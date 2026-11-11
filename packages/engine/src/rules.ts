import {
  addDays,
  count,
  daysBetween,
  evaluate,
  formatDay,
  formatMoney,
  recurringAmount,
} from '@clausework/billing';
import { EMPTY_GIVEN, fromMajor, type Obligation, type Plan, sum } from '@clausework/core';
import { bindings, charges, ledgerEntries, settings, usageEvents } from '@clausework/db';
import { PayPalError } from '@clausework/paypal';
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { clockOffset, type Engine, serially, today } from './context.ts';
import { consult } from './decisions.ts';
import { flowOf, type Live, liveAgreementIds, loadLive, party } from './live.ts';
import { type ChargeRow, captureDeposit, raise } from './money.ts';
import { gateCharge } from './phases.ts';
import { loadPhaseRows, loadVersion, recordEvent } from './repo.ts';

/**
 * The fast paths. Each day, for each live agreement, rules raise what has fallen due: period
 * closes, anniversaries, delivered milestones, retainage releases, deposit captures when work
 * starts. Anything that needs judgement goes to the schedule agent through `consult`.
 */

const LAST_TICK = 'last_tick';

/**
 * The days whose rules have not run yet, up to and including today, and the agreements they run
 * for. Marks them as run: the caller queues a workflow per agreement and day before this returns
 * to the schedule, so a crash cannot lose them.
 */
export async function daysToRun(
  engine: Engine,
): Promise<{ days: string[]; agreementIds: string[] }> {
  const now = await today(engine.db);
  const [row] = await engine.db.select().from(settings).where(eq(settings.key, LAST_TICK));
  let day = (row?.value as { day?: string } | undefined)?.day ?? addDays(now, -1);
  if (day > now) day = addDays(now, -1);
  const days: string[] = [];
  while (day < now) {
    day = addDays(day, 1);
    days.push(day);
  }
  if (days.length > 0) {
    await engine.db
      .insert(settings)
      .values({ key: LAST_TICK, value: { day: now } })
      .onConflictDoUpdate({ target: settings.key, set: { value: { day: now } } });
  }
  return { days, agreementIds: await liveAgreementIds(engine.db) };
}

/** Runs one agreement's rules for one day, in its lane. Running a day again changes nothing done. */
export async function runRules(engine: Engine, agreementId: string, day: string): Promise<void> {
  await serially(engine, agreementId, async () =>
    tick(engine, await loadLive(engine.db, agreementId), day),
  );
}

export async function tick(engine: Engine, live: Live, on: string): Promise<void> {
  const rows = await engine.db
    .select()
    .from(charges)
    .where(eq(charges.agreementId, live.agreement.id))
    .orderBy(asc(charges.dueDate), asc(charges.periodIndex));
  const phaseRows = await loadPhaseRows(engine.db, live.agreement.id);
  const completed = new Map(phaseRows.map((p) => [p.phaseKey, p.completedOn]));
  const now = await engineNow(engine);

  // A charge follows the terms of the version that laid it out, so an amendment effective from a
  // date leaves earlier periods on the old terms.
  const versions = new Map<string, Plan>([[live.version.row.id, live.plan]]);
  const planOf = async (versionId: string | null): Promise<Plan> => {
    if (!versionId) return live.plan;
    const known = versions.get(versionId);
    if (known) return known;
    const loaded = (await loadVersion(engine.db, versionId)).plan;
    versions.set(versionId, loaded);
    return loaded;
  };
  const currentPeriods = new Map<
    string,
    { o: Extract<Obligation, { kind: 'recurring' }>; charge: ChargeRow }
  >();
  for (const charge of rows) {
    const terms = await planOf(charge.versionId);
    const o =
      terms.obligations.find((x) => x.key === charge.obligationKey) ??
      live.plan.obligations.find((x) => x.key === charge.obligationKey);
    if (!o) continue;
    if (waitingAfterRefusal(charge, now)) continue;
    try {
      switch (o.kind) {
        case 'deposit':
          // An advance the owner pays goes out as a payout on its date; one the owner collects is
          // authorized by the payer on PayPal and captured when work starts.
          if (flowOf(live, o) === 'pay') {
            if (isDue(charge, on)) {
              await raise(engine, live, charge, on);
            }
          } else {
            await depositRules(engine, live, o, charge, on);
          }
          break;
        case 'prepaid':
          if (isDue(charge, on)) {
            await raise(engine, live, charge, on);
          }
          break;
        case 'recurring':
          if (flowOf(live, o) === 'pay') {
            if (charge.status === 'scheduled' && charge.issueDate && charge.issueDate <= on) {
              await raise(engine, live, charge, on);
            }
            break;
          }
          // Handled once per obligation after the loop: the current period decides the price.
          if (charge.issueDate && charge.issueDate <= on && charge.periodIndex !== null) {
            const best = currentPeriods.get(o.key);
            if (!best || (best.charge.periodIndex ?? -1) < charge.periodIndex) {
              currentPeriods.set(o.key, { o, charge });
            }
          }
          break;
        case 'split':
          if (isDue(charge, on)) {
            await raise(engine, live, charge, on);
          }
          break;
        case 'usage':
        case 'revenue_share':
          if (charge.status === 'scheduled' && charge.issueDate && charge.issueDate <= on) {
            await closePeriod(engine, live, o, charge, on);
          }
          break;
        case 'milestone': {
          if (charge.status !== 'scheduled') break;
          const deliveredOn = o.phase ? completed.get(o.phase) : null;
          const dueWithoutPhase =
            !o.phase && o.due.kind === 'date' && charge.issueDate && charge.issueDate <= on;
          if ((deliveredOn && deliveredOn <= on) || dueWithoutPhase) {
            await raise(engine, live, charge, deliveredOn ?? on);
          }
          break;
        }
        case 'retainage':
          if (
            charge.status === 'held' &&
            charge.issueDate &&
            charge.issueDate <= on &&
            (charge.amount ?? 0n) > 0n
          ) {
            await engine.db
              .update(charges)
              .set({ status: 'scheduled' })
              .where(eq(charges.id, charge.id));
            await raise(engine, live, { ...charge, status: 'scheduled' }, on);
            await recordEvent(engine.db, live.agreement.id, {
              actor: 'system',
              type: 'retainage_released',
              summary: `Released ${formatMoney(charge.amount ?? 0n, charge.currency)} of retainage`,
              clauseIds: charge.clauseIds,
              occurredOn: on,
            });
          }
          break;
        default:
          break;
      }
    } catch (err) {
      // One refusal must not stop the rest of the agreement's rules; the charge stays owed.
      await notePayPalRefusal(engine, live, charge, err, on);
    }
    await overdueRules(engine, live, charge, on);
  }
  for (const { o, charge } of currentPeriods.values()) {
    try {
      await recurringRules(engine, live, o, charge, on);
    } catch (err) {
      await notePayPalRefusal(engine, live, charge, err, on);
    }
  }
  await gateRules(engine, live, on);
}

/** A scheduled charge whose issue date has come; one with no date is due at once. */
const isDue = (charge: ChargeRow, on: string) =>
  charge.status === 'scheduled' && (charge.issueDate ?? on) <= on;

/**
 * Records a PayPal refusal once per charge and reason (not on every retry), so the owner sees why
 * money has not moved, e.g. a payout refused for insufficient funds. The next run tries again.
 * Anything that is not a PayPal answer is a bug and still throws.
 */
async function notePayPalRefusal(
  engine: Engine,
  live: Live,
  charge: ChargeRow,
  err: unknown,
  on: string,
): Promise<void> {
  if (!(err instanceof PayPalError)) throw err;
  engine.log('PayPal refused a charge', { charge: charge.id, error: err.message });
  const reason = err.message.replace(/^PayPal \S+ \S+ failed: /, '');
  const [row] = await engine.db
    .select({ data: charges.paypalData })
    .from(charges)
    .where(eq(charges.id, charge.id));
  const before = (row?.data ?? {}) as Refusal;
  const refusals = (before.refusals ?? 0) + 1;
  const retryAt = new Date(
    (await engineNow(engine)) + Math.min(FIRST_RETRY_MS * 2 ** (refusals - 1), MAX_RETRY_MS),
  ).toISOString();
  await engine.db
    .update(charges)
    .set({
      paypalData: sql`coalesce(${charges.paypalData}, '{}'::jsonb) || ${JSON.stringify({ refused: reason, refusals, retryAt })}::jsonb`,
    })
    .where(eq(charges.id, charge.id));
  // Told once per reason, not on every retry.
  if (before.refused === reason) return;
  const pays = flowOf(live, charge) === 'pay';
  await recordEvent(engine.db, live.agreement.id, {
    actor: 'paypal',
    type: 'paypal_refused',
    summary: `PayPal refused the ${formatMoney(charge.amount ?? 0n, charge.currency)} ${pays ? 'payout to' : 'request to'} ${party(live, pays ? charge.payee : charge.payer).name} (${charge.label}): ${reason} It is still owed, and Clausework tries again, waiting longer each time.`,
    clauseIds: charge.clauseIds,
    data: { chargeId: charge.id, issue: err.issue, debugId: err.debugId },
    occurredOn: on,
  });
}

/** What a refusal leaves on the charge, until the money moves (which replaces the PayPal data). */
interface Refusal {
  refused?: string;
  refusals?: number;
  retryAt?: string;
}

/**
 * PayPal sends no event when a refusal stops applying (funds becoming available, say), so a
 * refused charge is tried again after 5 minutes, then 10, 20 and so on, at most every 6 hours.
 */
const FIRST_RETRY_MS = 5 * 60_000;
const MAX_RETRY_MS = 6 * 3_600_000;

/** The engine's now, in milliseconds: real time, or ahead by the clock tests move. */
async function engineNow(engine: Engine): Promise<number> {
  return Date.now() + (await clockOffset(engine.db)) * 86_400_000;
}

/** Whether a refused charge is still waiting out its backoff. */
function waitingAfterRefusal(charge: ChargeRow, now: number): boolean {
  const retryAt = (charge.paypalData as Refusal | null)?.retryAt;
  return retryAt !== undefined && Date.parse(retryAt) > now;
}

/** Live agreements with a refused charge whose backoff is over: the PayPal check retries them. */
export async function agreementsDueRetry(engine: Engine): Promise<string[]> {
  const now = new Date(await engineNow(engine)).toISOString();
  const rows = await engine.db
    .selectDistinct({ id: charges.agreementId })
    .from(charges)
    .where(
      and(
        inArray(charges.status, ['scheduled', 'failed']),
        sql`${charges.paypalData} ? 'retryAt'`,
        sql`(${charges.paypalData}->>'retryAt')::timestamptz <= ${now}::timestamptz`,
      ),
    );
  return rows.map((r) => r.id);
}

/** A deposit is authorized when the payer approves, and captured when the work it secures starts. */
async function depositRules(
  engine: Engine,
  live: Live,
  o: Obligation,
  charge: ChargeRow,
  on: string,
): Promise<void> {
  if (charge.status !== 'authorized') return;
  const data = (charge.paypalData ?? {}) as {
    authorizationId?: string;
    authorizedOn?: string;
    captureId?: string;
  };
  // A capture already asked for (completed or pending at PayPal) is waited on, never repeated.
  if (!data.authorizationId || data.captureId) return;
  const gated = live.plan.phases.find((p) => p.gatedBy === o.key);
  const startsOn = gated ? live.phases[gated.key]?.start : null;
  if (!startsOn || startsOn <= on) {
    const capture = await captureDeposit(engine, live, charge, data.authorizationId, on);
    await recordEvent(engine.db, live.agreement.id, {
      actor: 'system',
      type: 'deposit_captured',
      summary: `Captured the ${formatMoney(charge.amount ?? 0n, charge.currency)} deposit${gated ? ` as ${gated.name} starts` : ''}`,
      clauseIds: o.clauseIds,
      data: { captureId: capture.id },
      occurredOn: on,
    });
    return;
  }
  if (data.authorizedOn && daysBetween(data.authorizedOn, on) >= 27) {
    await consult(engine, live, on, {
      key: `deposit_expiring:${charge.id}:${data.authorizedOn}`,
      kind: 'deposit_authorization_expiring',
      summary: `The deposit authorization from ${formatDay(data.authorizedOn)} expires after 29 days, and ${gated?.name ?? 'the work'} has not started`,
      details: { chargeId: charge.id, authorizedOn: data.authorizedOn, phaseStart: startsOn },
    });
  }
}

/**
 * Keeps the PayPal plan's price at the current period's fee: an anniversary escalator, or an
 * amendment's new rate from its date. Only the latest period that has started counts, so the
 * price never moves backwards.
 */
async function recurringRules(
  engine: Engine,
  live: Live,
  o: Extract<Obligation, { kind: 'recurring' }>,
  charge: ChargeRow,
  on: string,
): Promise<void> {
  if (flowOf(live, o) !== 'collect' || charge.periodIndex === null) return;
  const bound = await engine.db
    .select()
    .from(bindings)
    .where(and(eq(bindings.agreementId, live.agreement.id), eq(bindings.obligationKey, o.key)));
  const planBinding = bound.find((b) => b.role === 'plan');
  const subBinding = bound.find((b) => b.role === 'subscription');
  if (!planBinding || !subBinding) return;

  const price = recurringAmount(o, charge.periodIndex);
  const applied = (planBinding.data as { price?: string }).price;
  if (applied !== price.toString()) {
    await engine.gateway.updatePlanPrice(planBinding.paypalId, {
      amount: price,
      currency: charge.currency,
    });
    await engine.db
      .update(bindings)
      .set({ data: { ...(planBinding.data as object), price: price.toString() } })
      .where(eq(bindings.id, planBinding.id));
    const escalated =
      charge.periodIndex > 0 && price !== recurringAmount(o, charge.periodIndex - 1);
    await recordEvent(engine.db, live.agreement.id, {
      actor: 'system',
      type: 'plan_repriced',
      summary: `${escalated ? 'Anniversary: ' : ''}${o.title} is now ${formatMoney(price, charge.currency)} a period (PayPal plan ${planBinding.paypalId} repriced)`,
      clauseIds: o.clauseIds,
      data: { periodIndex: charge.periodIndex, price: price.toString() },
      occurredOn: on,
    });
  }
}

/** At a period's close, usage and revenue shares become an amount, then a charge or nothing. */
async function closePeriod(
  engine: Engine,
  live: Live,
  o: Extract<Obligation, { kind: 'usage' | 'revenue_share' }>,
  charge: ChargeRow,
  on: string,
): Promise<void> {
  if (!charge.periodStart || !charge.periodEnd) return;
  const m = (v: bigint) => formatMoney(v, charge.currency);
  let amount: bigint;
  let basis: string;
  if (o.kind === 'usage') {
    const used = await usageIn(engine, live, o.key, charge.periodStart, charge.periodEnd);
    amount = evaluate(live.plan, o, { ...EMPTY_GIVEN, quantity: used });
    const over = Math.max(0, used - o.included);
    basis =
      amount > 0n
        ? `${count(over, o.unit)} × ${m(o.rate)} above ${o.included} included (${used} used)`
        : `${count(used, o.unit)} used, within the ${o.included} included`;
  } else {
    const { receipts, prior } = await receiptsFor(
      engine,
      live,
      o,
      charge.periodStart,
      charge.periodEnd,
    );
    amount = evaluate(live.plan, o, { ...EMPTY_GIVEN, receipts, priorReceipts: prior });
    const share = `${o.bps / 100}% of ${m(receipts)} received`;
    const recouping =
      o.recoup && amount === 0n && receipts > 0n ? `, recouping the ${m(o.recoup)} advance` : '';
    basis = `${share}${recouping}`;
  }
  if (amount === 0n) {
    await engine.db
      .update(charges)
      .set({ status: 'cancelled', amount: 0n, basis: `Nothing due: ${basis}` })
      .where(eq(charges.id, charge.id));
    return;
  }
  const [updated] = await engine.db
    .update(charges)
    .set({ amount, basis })
    .where(eq(charges.id, charge.id))
    .returning();
  await raise(engine, live, updated as ChargeRow, on);
}

async function usageIn(
  engine: Engine,
  live: Live,
  key: string,
  from: string,
  to: string,
): Promise<number> {
  const rows = await engine.db
    .select({ quantity: usageEvents.quantity })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.agreementId, live.agreement.id),
        eq(usageEvents.obligationKey, key),
        gte(usageEvents.occurredOn, from),
        lte(usageEvents.occurredOn, to),
      ),
    );
  return Math.round(rows.reduce((s, r) => s + Number(r.quantity), 0) * 100) / 100;
}

/**
 * Receipts for a revenue share: what was collected for its source obligations, or, when the money
 * arrives outside the plan, what was reported for it.
 */
async function receiptsFor(
  engine: Engine,
  live: Live,
  o: Extract<Obligation, { kind: 'revenue_share' }>,
  from: string,
  to: string,
): Promise<{ receipts: bigint; prior: bigint }> {
  if (o.of.length > 0) {
    const rows = await engine.db
      .select({ amount: ledgerEntries.amount, on: ledgerEntries.occurredOn })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.agreementId, live.agreement.id),
          eq(ledgerEntries.kind, 'collected'),
          inArray(ledgerEntries.obligationKey, o.of),
          lte(ledgerEntries.occurredOn, to),
        ),
      );
    return {
      receipts: sum(rows.filter((r) => r.on >= from).map((r) => r.amount)),
      prior: sum(rows.filter((r) => r.on < from).map((r) => r.amount)),
    };
  }
  const rows = await engine.db
    .select({ quantity: usageEvents.quantity, on: usageEvents.occurredOn })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.agreementId, live.agreement.id),
        eq(usageEvents.obligationKey, o.key),
        lte(usageEvents.occurredOn, to),
      ),
    );
  // Reported receipts are stored in major units as the quantity.
  const minor = (q: string) => fromMajor(q, live.plan.currency);
  return {
    receipts: sum(rows.filter((r) => r.on >= from).map((r) => minor(r.quantity))),
    prior: sum(rows.filter((r) => r.on < from).map((r) => minor(r.quantity))),
  };
}

/** An invoice past its due date is overdue; each month or part of lateness is a fresh judgement. */
async function overdueRules(
  engine: Engine,
  live: Live,
  charge: ChargeRow,
  on: string,
): Promise<void> {
  if (!['issued', 'overdue'].includes(charge.status) || !charge.dueDate || charge.dueDate >= on)
    return;
  if (charge.paypalProduct !== 'invoicing' || flowOf(live, charge) !== 'collect') return;
  if (charge.status === 'issued') {
    await engine.db.update(charges).set({ status: 'overdue' }).where(eq(charges.id, charge.id));
  }
  // A late fee is not charged on a late fee; its lateness is visible, not a new decision.
  if (charge.kind === 'late_fee') return;
  const daysLate = daysBetween(charge.dueDate, on);
  const month = Math.ceil(daysLate / 30);
  await consult(engine, live, on, {
    key: `overdue:${charge.id}:${month}`,
    kind: 'invoice_overdue',
    summary: `${charge.label} (${formatMoney(charge.amount ?? 0n, charge.currency)}) is ${daysLate} day${daysLate === 1 ? '' : 's'} past its due date of ${formatDay(charge.dueDate)}`,
    details: { chargeId: charge.id, daysLate, dueDate: charge.dueDate },
  });
}

/** A phase whose start date has come while the payment that gates it is unpaid. */
async function gateRules(engine: Engine, live: Live, on: string): Promise<void> {
  const phaseRows = await loadPhaseRows(engine.db, live.agreement.id);
  for (const phase of live.plan.phases) {
    if (!phase.gatedBy) continue;
    const at = live.phases[phase.key];
    if (!at?.start || at.start > on) continue;
    if (phaseRows.find((p) => p.phaseKey === phase.key)?.completedOn) continue;
    const gate = await gateCharge(engine, live.agreement.id, phase.gatedBy);
    if (!gate || gate.status === 'paid') continue;
    await consult(engine, live, on, {
      key: `gate:${phase.key}:${at.start}`,
      kind: 'gating_payment_late',
      summary: `${phase.name} is due to start on ${formatDay(at.start)}, but ${gate.label} has not been paid`,
      details: { phase: phase.key, chargeId: gate.id, chargeStatus: gate.status },
    });
  }
}
