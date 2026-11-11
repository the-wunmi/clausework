import type { ScheduleProposal, ScheduleView } from '@clausework/agents';
import { addDays } from '@clausework/billing';
import { EMPTY_GIVEN, type Plan } from '@clausework/core';
import { agreements, createDb, createPool, type Db } from '@clausework/db';
import { runMigrations } from '@clausework/db/migrate';
import { MemorySimStore, PayPalSimulator } from '@clausework/paypal';
import { sql } from 'drizzle-orm';
import { agencyPlan } from '../../billing/test/fixture.ts';
import {
  type Agents,
  createEngine,
  daysToRun,
  type Engine,
  launchWorkflows,
  loadLive,
  loadPhaseRows,
  locateClauses,
  realToday,
  receiveSimulatedEvent,
  runRules,
  saveVersion,
  setClockOffset,
  updatePhase,
  useEngine,
  waitForIdle,
} from '../src/index.ts';

/** A schedule agent that answers from a script, so runtime decisions are deterministic. */
export class ScriptedScheduleAgent {
  readonly modelName = 'scripted';
  readonly seen: ScheduleView[] = [];
  constructor(private readonly script: (view: ScheduleView) => ScheduleProposal) {}
  async decide(view: ScheduleView): Promise<{ proposal: ScheduleProposal; model: string }> {
    this.seen.push(view);
    return { proposal: this.script(view), model: this.modelName };
  }
}

export const action = (
  a: Partial<ScheduleProposal['actions'][number]> &
    Pick<ScheduleProposal['actions'][number], 'action' | 'clauseId'>,
): ScheduleProposal['actions'][number] => ({
  target: null,
  start: null,
  end: null,
  message: null,
  rationale: 'scripted',
  ...a,
});

/** An engine on the PayPal simulator, which tests drive as the payer would. */
export type TestEngine = Engine & { simulator: PayPalSimulator };

let db: Db | null = null;
let previous: TestEngine | null = null;
/** Days the simulator's clock runs ahead, kept in step with the engine's. */
let offsetDays = 0;
/** Whether the clock has been set yet in this case: the first setting jumps rather than steps. */
let clockSet = false;

export async function testEngine(schedule: ScriptedScheduleAgent): Promise<TestEngine> {
  if (!db) {
    await runMigrations(process.env.DATABASE_URL);
    db = createDb(createPool(process.env.DATABASE_URL));
  }
  if (previous) {
    // The last case's queued work finishes before its tables are emptied under it.
    await waitForIdle();
    await previous.lanes.close();
  }
  await db.execute(sql`truncate agreements, webhook_events, settings, audits cascade`);
  offsetDays = 0;
  clockSet = false;
  const simulator = new PayPalSimulator({
    store: new MemorySimStore(),
    publicUrl: 'http://web.test',
    now: () => new Date(Date.now() + offsetDays * 86_400_000),
    usageBilling: true,
  });
  const engine = await createEngine({
    db,
    gateway: simulator,
    env: { ...process.env, CLAUSEWORK_PUBLIC_URL: 'http://web.test' },
    agents: { schedule, model: 'scripted' } as unknown as Agents,
    log: (m, d) => (process.env.DEBUG_ENGINE ? console.log(m, d) : undefined),
  });
  simulator.onWebhook((event) => receiveSimulatedEvent(engine, event));
  if (previous) useEngine(engine);
  else await launchWorkflows(engine);
  previous = Object.assign(engine, { simulator });
  return previous;
}

/**
 * Moves the clock to a calendar day, one day at a time. Each day: the rules run for every live
 * agreement, PayPal bills the subscription cycles that came due (as its own scheduler would), and
 * the workflows that set off finish before the next day, so every event carries its own day.
 */
export async function setToday(engine: TestEngine, day: string): Promise<void> {
  const target = Math.round((Date.parse(day) - Date.parse(realToday())) / 86_400_000);
  await run(engine);
  const first = clockSet ? offsetDays + 1 : target;
  clockSet = true;
  for (let offset = first; offset <= target; offset++) {
    offsetDays = offset;
    await setClockOffset(engine.db, offset);
    const { days, agreementIds } = await daysToRun(engine);
    for (const d of days) for (const id of agreementIds) await runRules(engine, id, d);
    for (const { id, data } of await engine.simulator.listObjects('subscription')) {
      if ((data as { status?: string }).status === 'ACTIVE') {
        await engine.simulator.billDueCycles(id.replace(/^subscription:/, ''));
      }
    }
    await run(engine);
  }
}

/** Delivers a phase on a day, delivering the phases it follows first, as the work would go. */
export async function deliver(engine: Engine, id: string, phase: string, day: string) {
  const live = await loadLive(engine.db, id);
  const target = live.plan.phases.find((p) => p.key === phase);
  const delivered = new Set(
    (await loadPhaseRows(engine.db, id)).filter((r) => r.completedOn).map((r) => r.phaseKey),
  );
  for (const before of target?.dependsOn ?? []) {
    if (!delivered.has(before)) await deliver(engine, id, before, day);
  }
  await updatePhase(engine, await loadLive(engine.db, id), phase, { completedOn: day });
}

/** Waits for every queued workflow (webhooks, PayPal setup) to finish. */
export async function run(_engine: Engine): Promise<void> {
  await waitForIdle();
}

/** The agency fixture with retainage on the Phase 2 milestone. */
export function agencyWithRetainage(): Plan {
  const plan = agencyPlan();
  plan.clauses.push({
    id: 'c7',
    ref: '§3.6 Retainage',
    kind: 'retainage',
    quote: 'Client may withhold 10% of each milestone.',
  });
  plan.obligations.push({
    kind: 'retainage',
    key: 'retainage',
    title: 'Retainage',
    clauseIds: ['c7'],
    payer: 'client',
    payee: 'agency',
    confidence: 0.9,
    ambiguities: [],
    of: ['phase_2'],
    bps: 1000,
    release: { kind: 'phase_end', phase: 'design', offsetDays: 30 },
  });
  plan.tests.push({
    obligation: 'retainage',
    name: '10% of $12,000',
    given: { ...EMPTY_GIVEN, invoiceAmount: 1_200_000n },
    expect: 120_000n,
  });
  return plan;
}

/** An agreement already compiled to `plan`, with the agency as owner, ready for approvals. */
export async function compiledAgreement(engine: Engine, plan: Plan): Promise<string> {
  const text = plan.clauses.map((c) => `${c.ref}\n${c.quote}`).join('\n\n');
  const [row] = await engine.db
    .insert(agreements)
    .values({
      title: plan.title,
      status: 'review',
      sourceKind: 'text',
      sourceName: 'fixture.txt',
      sourceText: text,
      ownerParty: 'agency',
    })
    .returning();
  await saveVersion(engine, row as typeof agreements.$inferSelect, {
    plan,
    origin: 'compile',
    note: 'fixture',
    spans: locateClauses(text, plan),
  });
  return (row as { id: string }).id;
}

export { addDays };
