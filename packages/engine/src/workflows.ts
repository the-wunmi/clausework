import { AsyncLocalStorage } from 'node:async_hooks';
import { DomainError } from '@clausework/core';
import { agreements, audits } from '@clausework/db';
import { PayPalError } from '@clausework/paypal';
import { DBOS, DBOSClient, Error as DBOSErrors, type WorkflowHandle } from '@dbos-inc/dbos-sdk';
import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import { agreementsAwaitingSetup, runPayPalSetup } from './activate.ts';
import { advanceAlerts, deliverAlert, pendingAlerts } from './alerts.ts';
import { runAudit } from './audit.ts';
import { runCompile } from './compile.ts';
import { type Engine, type Step, today } from './context.ts';
import { agreementsDueRetry, daysToRun, runRules } from './rules.ts';
import { processWebhook, reconcileWithPayPal, requeueUnprocessedWebhooks } from './webhooks.ts';

/**
 * Durable work, on DBOS. Anything with an outside effect that must finish even if the process
 * stops (a compile, PayPal setup, a webhook, a day's rules, a check with PayPal) runs as a
 * workflow recorded in Postgres. A restarted server resumes each one at the step it stopped on.
 *
 * Steps are at-least-once: a step that ran but was not yet recorded runs again on recovery. Every
 * step is therefore idempotent: charges move only from given statuses, ledger entries dedupe on
 * the PayPal id, and every PayPal call carries a request id or a natural key.
 */

// ── The engine the workflows run against ─────────────────────────────────────

let current: Engine | null = null;

function engine(): Engine {
  if (!current) throw new Error('The engine is not launched: call launchWorkflows first');
  return current;
}

// ── Queues ───────────────────────────────────────────────────────────────────

/**
 * Work on one agreement: webhooks, PayPal setup, rules, checks with PayPal. Partitioned by
 * agreement with one at a time per partition, across every server, so an agreement's work runs
 * in order while different agreements run side by side.
 */
const AGREEMENT_QUEUE = 'agreement';
/**
 * Model-heavy work (compiles, audits): a minute of model time each, a few at once per server, and
 * one at a time per agreement, so a recompile waits for the compile before it.
 */
const MODEL_QUEUE = 'model';
/** Owner alerts: one run at a time anywhere, so two runs never post the same alert. */
const ALERT_QUEUE = 'alerts';

/** Registered at launch; the code is the source of truth for their limits. */
async function registerQueues(): Promise<void> {
  await DBOS.registerQueue(AGREEMENT_QUEUE, {
    partitionConcurrency: 1,
    workerConcurrency: 8,
    minPollingIntervalMs: 200,
    onConflict: 'always_update',
  });
  await DBOS.registerQueue(MODEL_QUEUE, {
    workerConcurrency: 3,
    partitionConcurrency: 1,
    minPollingIntervalMs: 500,
    onConflict: 'always_update',
  });
  await DBOS.registerQueue(ALERT_QUEUE, {
    globalConcurrency: 1,
    minPollingIntervalMs: 1000,
    onConflict: 'always_update',
  });
}

/** Webhooks PayPal sent for no agreement we know still need a partition. */
const UNMATCHED = 'unmatched';

// ── Steps ────────────────────────────────────────────────────────────────────

/** A refusal (ours or PayPal's) will not change by asking again; anything else might. */
function worthRetrying(err: unknown): boolean {
  if (err instanceof DomainError) return false;
  if (err instanceof PayPalError) return err.retryable;
  return true;
}

/** A step retried with backoff: from 2 s, six attempts span about a minute. */
const step: Step = (name, work) =>
  DBOS.runStep(work, {
    name,
    retriesAllowed: true,
    maxAttempts: 6,
    intervalSeconds: 2,
    backoffRate: 2,
    shouldRetry: worthRetrying,
  });

/**
 * DBOS uses errors for cancellation and recovery, and workflows must let those through. A step
 * that ran out of retries is the exception: that is an ordinary failure the workflow handles.
 */
function isWorkflowControl(err: unknown): boolean {
  return (
    err instanceof DBOSErrors.DBOSError && !(err instanceof DBOSErrors.DBOSMaxStepRetriesError)
  );
}

/** Logs a workflow that failed for good. The schedule's sweep picks its work up again. */
function gaveUp(what: string, err: unknown, data: Record<string, unknown>): void {
  if (isWorkflowControl(err)) throw err;
  engine().log(`${what} failed`, {
    ...data,
    error: err instanceof Error ? err.message : String(err),
  });
}

// ── Workflows ────────────────────────────────────────────────────────────────

async function compileAgreement(agreementId: string, run: string): Promise<void> {
  try {
    await runCompile(engine(), agreementId, step, run);
  } catch (err) {
    gaveUp('compile', err, { agreementId, run });
    const message = err instanceof Error ? err.message : String(err);
    // Only this run's failure: a recompile started since owns the agreement now.
    await step('mark_failed', () =>
      engine()
        .db.update(agreements)
        .set({ status: 'failed', failure: `Compiling failed: ${message}`, progress: null })
        .where(and(eq(agreements.id, agreementId), eq(agreements.compileRun, run))),
    );
  }
}
const compileWorkflow = durable('compileAgreement', compileAgreement);

async function auditAgreement(auditId: string): Promise<void> {
  try {
    await runAudit(engine(), auditId, step);
  } catch (err) {
    gaveUp('audit', err, { auditId });
    await step('mark_failed', () =>
      engine().db.update(audits).set({ status: 'failed' }).where(eq(audits.id, auditId)),
    );
  }
}
const auditWorkflow = durable('auditAgreement', auditAgreement);

async function setUpPayPal(agreementId: string): Promise<void> {
  try {
    await runPayPalSetup(engine(), agreementId, step);
  } catch (err) {
    gaveUp('PayPal setup', err, { agreementId });
  }
}
const setupWorkflow = durable('setUpPayPal', setUpPayPal);

async function handleWebhook(eventId: string): Promise<void> {
  try {
    await step('handle', () => processWebhook(engine(), eventId));
  } catch (err) {
    gaveUp('webhook', err, { eventId });
  }
}
const webhookWorkflow = durable('handleWebhook', handleWebhook);

async function rulesForDay(agreementId: string, day: string): Promise<void> {
  try {
    await step('rules', () => runRules(engine(), agreementId, day));
  } catch (err) {
    gaveUp('rules', err, { agreementId, day });
  }
}
const rulesWorkflow = durable('rulesForDay', rulesForDay);

async function checkWithPayPal(agreementId: string, thorough: boolean): Promise<void> {
  try {
    await step('reconcile', async () => {
      const e = engine();
      const [agreement] = await e.db
        .select()
        .from(agreements)
        .where(eq(agreements.id, agreementId));
      if (agreement) await reconcileWithPayPal(e, agreement, { thorough });
    });
  } catch (err) {
    gaveUp('check with PayPal', err, { agreementId });
  }
}
const reconcileWorkflow = durable('checkWithPayPal', checkWithPayPal);

// ── Starting work ────────────────────────────────────────────────────────────

/** Workflows queued while handling one request, so the API can wait for them before answering. */
const queuedHere = new AsyncLocalStorage<WorkflowHandle<unknown>[]>();

interface Durable<Args extends unknown[]> {
  name: string;
  run: (...args: Args) => Promise<void>;
}

function durable<Args extends unknown[]>(
  name: string,
  fn: (...args: Args) => Promise<void>,
): Durable<Args> {
  return { name, run: DBOS.registerWorkflow(fn, { name }) };
}

/** Starts work from inside a step, where DBOS does not allow starting a workflow directly. */
let client: DBOSClient | null = null;

/**
 * Queues a workflow under a deterministic id: queuing the same id again returns the workflow
 * already there, so a retried step or a repeated sweep never starts work twice.
 */
async function enqueue<Args extends unknown[]>(
  workflow: Durable<Args>,
  options: { queue: string; workflowID: string; partition?: string },
  ...args: Args
): Promise<void> {
  if (DBOS.isInStep()) {
    if (!client) throw new Error('The workflow client is not started');
    await client.enqueue(
      {
        workflowName: workflow.name,
        queueName: options.queue,
        workflowID: options.workflowID,
        queuePartitionKey: options.partition,
      },
      ...args,
    );
    return;
  }
  const handle = await DBOS.startWorkflow(workflow.run, {
    workflowID: options.workflowID,
    queueName: options.queue,
    enqueueOptions: options.partition ? { queuePartitionKey: options.partition } : undefined,
  })(...args);
  queuedHere.getStore()?.push(handle);
}

/** Each compile or recompile has its own run id; `attempt` names a retry by the sweep. */
export const enqueueCompile = (agreementId: string, run: string, attempt = '') =>
  enqueue(
    compileWorkflow,
    {
      queue: MODEL_QUEUE,
      workflowID: `compile:${run}${attempt && `:${attempt}`}`,
      partition: agreementId,
    },
    agreementId,
    run,
  );

export const enqueueAudit = (auditId: string, agreementId: string, attempt = '') =>
  enqueue(
    auditWorkflow,
    {
      queue: MODEL_QUEUE,
      workflowID: `audit:${auditId}${attempt && `:${attempt}`}`,
      partition: agreementId,
    },
    auditId,
  );

/** Once per live version; `attempt` names a retry by the sweep. */
export const enqueuePayPalSetup = (agreementId: string, versionId: string, attempt = '') =>
  enqueue(
    setupWorkflow,
    {
      queue: AGREEMENT_QUEUE,
      workflowID: `paypal_setup:${versionId}${attempt && `:${attempt}`}`,
      partition: agreementId,
    },
    agreementId,
  );

/** Once per PayPal event; `attempt` names a retry by the sweep. */
export const enqueueWebhook = (eventId: string, agreementId: string | null, attempt = '') =>
  enqueue(
    webhookWorkflow,
    {
      queue: AGREEMENT_QUEUE,
      workflowID: `webhook:${eventId}${attempt && `:${attempt}`}`,
      partition: agreementId ?? UNMATCHED,
    },
    eventId,
  );

/** Once per agreement and day; `attempt` names a same-day rerun. */
const enqueueRules = (agreementId: string, day: string, attempt = '') =>
  enqueue(
    rulesWorkflow,
    {
      queue: AGREEMENT_QUEUE,
      workflowID: `rules:${agreementId}:${day}${attempt && `:${attempt}`}`,
      partition: agreementId,
    },
    agreementId,
    day,
  );

/** `thorough` also asks about long-overdue charges, which the frequent check leaves alone. */
const enqueueReconcile = (agreementId: string, slot: string, thorough: boolean) =>
  enqueue(
    reconcileWorkflow,
    {
      queue: AGREEMENT_QUEUE,
      workflowID: `reconcile:${agreementId}:${slot}${thorough ? ':full' : ''}`,
      partition: agreementId,
    },
    agreementId,
    thorough,
  );

/**
 * Runs `work` and waits for the workflows it queued, up to `timeoutMs`, so an answer shows what a
 * click set off (the PayPal objects a last approval creates, a webhook a return fetched). Past the
 * timeout the work carries on, and the page polls.
 */
export async function andWaitForQueued<T>(work: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const handles: WorkflowHandle<unknown>[] = [];
  const result = await queuedHere.run(handles, work);
  const done = Promise.allSettled(handles.map((h) => h.getResult()));
  await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  return result;
}

// ── Schedules ────────────────────────────────────────────────────────────────

const slotOf = (scheduled: Date) => scheduled.toISOString().slice(0, 16);

/**
 * Hourly: each live agreement's rules for every day not yet run (exactly once per agreement and
 * day, by workflow id), today's again so whatever PayPal refused earlier today is retried, a
 * thorough check with PayPal, and a sweep for work whose workflow gave up or was never queued.
 */
async function hourly(scheduled: Date): Promise<void> {
  const slot = slotOf(scheduled);
  const e = engine();
  const { days, agreementIds } = await step('days_to_run', () => daysToRun(e));
  const now = await step('today', () => today(e.db));
  for (const id of agreementIds) {
    for (const day of days) await enqueueRules(id, day);
    if (!days.includes(now)) await enqueueRules(id, now, slot);
    await enqueueReconcile(id, slot, true);
  }
  await sweep(slot);
}
const hourlyWorkflow = DBOS.registerWorkflow(hourly, { name: 'hourly' });

/**
 * Every two minutes: ask PayPal about what is waiting on it, in case a webhook is late or lost,
 * and run today's rules again where a charge PayPal refused has waited out its backoff (PayPal
 * sends no event when, say, funds become available).
 */
async function checkPayPal(scheduled: Date): Promise<void> {
  const slot = slotOf(scheduled);
  const e = engine();
  const running = await step('running_agreements', () =>
    e.db.select({ id: agreements.id }).from(agreements).where(isNotNull(agreements.liveVersionId)),
  );
  for (const { id } of running) await enqueueReconcile(id, slot, false);
  const due = await step('refusals_due', () => agreementsDueRetry(e));
  if (due.length === 0) return;
  const now = await step('today', () => today(e.db));
  for (const id of due) await enqueueRules(id, now, `retry:${slot}`);
}
const checkPayPalWorkflow = DBOS.registerWorkflow(checkPayPal, { name: 'checkPayPal' });

/** Posts what needs the owner to the alert webhook, in order, each once. */
async function alertOwner(): Promise<void> {
  const e = engine();
  const url = e.alertWebhookUrl;
  if (!url) return;
  const alerts = await step('pending_alerts', () => pendingAlerts(e));
  for (const alert of alerts) {
    try {
      await step(`deliver:${alert.eventId}`, () => deliverAlert(url, alert));
    } catch (err) {
      // Stop here, in order: the next run starts again from this alert.
      gaveUp('alert', err, { eventId: alert.eventId });
      return;
    }
    await step(`advance:${alert.eventId}`, () => advanceAlerts(e, alert.cursor));
  }
}
const alertWorkflow = durable('alertOwner', alertOwner);

/** Every two minutes: queue an alert run. The queue runs one at a time, so runs never overlap. */
async function alertTick(scheduled: Date): Promise<void> {
  await enqueue(alertWorkflow, { queue: ALERT_QUEUE, workflowID: `alerts:${slotOf(scheduled)}` });
}
const alertTickWorkflow = DBOS.registerWorkflow(alertTick, { name: 'alertTick' });

/** How long work may sit in its starting state before the sweep looks at it. */
const STUCK_AFTER_MS = 10 * 60_000;

/**
 * Work that should be under way and is not: a webhook stored but never handled, a compile or audit
 * whose workflow failed or was never queued, PayPal setup left unfinished. Each is queued again
 * under a new workflow id, unless a workflow for it is still queued or running.
 */
async function sweep(slot: string): Promise<void> {
  const e = engine();
  await step('requeue_webhooks', () => requeueUnprocessedWebhooks(e, slot));
  const before = new Date((await DBOS.now()) - STUCK_AFTER_MS);
  const stuck = await step('stuck_compiles', () =>
    e.db
      .select({ id: agreements.id, run: agreements.compileRun })
      .from(agreements)
      .where(
        and(inArray(agreements.status, ['reading', 'compiling']), lt(agreements.updatedAt, before)),
      ),
  );
  if (stuck.length > 0) {
    const active = await step('active_compiles', () => activeFirstArgs('compileAgreement'));
    for (const a of stuck) {
      if (a.run && !active.includes(a.id)) await enqueueCompile(a.id, a.run, slot);
    }
  }
  const matching = await step('stuck_audits', () =>
    e.db
      .select({ id: audits.id, agreementId: audits.agreementId })
      .from(audits)
      .where(and(eq(audits.status, 'matching'), lt(audits.createdAt, before))),
  );
  if (matching.length > 0) {
    const active = await step('active_audits', () => activeFirstArgs('auditAgreement'));
    for (const a of matching) {
      if (a.agreementId && !active.includes(a.id)) await enqueueAudit(a.id, a.agreementId, slot);
    }
  }
  const unfinished = await step('unfinished_setups', () => agreementsAwaitingSetup(e));
  for (const a of unfinished) await enqueuePayPalSetup(a.id, a.versionId, slot);
}

/** The first argument of every queued or running workflow of a kind (the thing it works on). */
async function activeFirstArgs(workflowName: string): Promise<string[]> {
  const rows = await DBOS.listWorkflows({
    workflowName,
    status: ['ENQUEUED', 'PENDING'],
    loadInput: true,
  });
  return rows.map((w) => String((w.input as unknown[] | undefined)?.[0] ?? ''));
}

// ── Launch ───────────────────────────────────────────────────────────────────

export interface LaunchOptions {
  systemDatabaseUrl?: string;
  /** Run the hourly rules and the PayPal checks on their schedules. Off in tests. */
  schedules?: boolean;
  logLevel?: string;
}

/** Starts DBOS for this engine. Workflows interrupted by a stop resume from here. */
export async function launchWorkflows(e: Engine, options: LaunchOptions = {}): Promise<void> {
  current = e;
  const systemDatabaseUrl = options.systemDatabaseUrl ?? process.env.DBOS_SYSTEM_DATABASE_URL;
  if (!systemDatabaseUrl) throw new Error('DBOS_SYSTEM_DATABASE_URL is not set');
  DBOS.setConfig({ name: 'clausework', systemDatabaseUrl, logLevel: options.logLevel ?? 'warn' });
  await DBOS.launch();
  await registerQueues();
  client = await DBOSClient.create({ systemDatabaseUrl, applicationName: 'clausework' });
  if (options.schedules) {
    await DBOS.applySchedules([
      { scheduleName: 'hourly', workflowFn: hourlyWorkflow, schedule: '0 * * * *' },
      { scheduleName: 'check-paypal', workflowFn: checkPayPalWorkflow, schedule: '*/2 * * * *' },
      { scheduleName: 'alert-owner', workflowFn: alertTickWorkflow, schedule: '*/2 * * * *' },
    ]);
  }
}

/**
 * Runs the hourly work now: on start, so days missed while the server was down run at once, and
 * in tests. `at` names the slot; the same slot twice queues nothing new.
 */
export async function runHourlyNow(at = new Date()): Promise<void> {
  await (await DBOS.startWorkflow(hourlyWorkflow)(at)).getResult();
}

/** Posts pending alerts now (tests). */
export async function alertOwnerNow(): Promise<void> {
  await (await DBOS.startWorkflow(alertWorkflow.run)()).getResult();
}

/** Asks PayPal about every running agreement now (the frequent check). */
export async function checkPayPalNow(at = new Date()): Promise<void> {
  await (await DBOS.startWorkflow(checkPayPalWorkflow)(at)).getResult();
}

/** Waits until no workflow is queued or running. Tests use it in place of a clock. */
export async function waitForIdle(timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const busy = await DBOS.listWorkflows({ status: ['ENQUEUED', 'PENDING'], limit: 1 });
    if (busy.length === 0) return;
    if (Date.now() > until) {
      throw new Error(`Workflows still running after ${timeoutMs} ms: ${busy[0]?.workflowName}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function shutdownWorkflows(): Promise<void> {
  await client?.destroy();
  client = null;
  await DBOS.shutdown();
  current = null;
}

/** Points running workflows at another engine (tests build one per case). */
export function useEngine(e: Engine): void {
  current = e;
}
