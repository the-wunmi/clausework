import { explainObligation, formatDay, formatMoney } from '@clausework/billing';
import {
  DomainError,
  fromMajor,
  newId,
  PhaseInput,
  type Plan,
  parseInput,
  UsageInput,
} from '@clausework/core';
import { bindings, phaseDates, usageEvents } from '@clausework/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type Engine, serially, today } from './context.ts';
import { consult } from './decisions.ts';
import { type Live, loadLive, party } from './live.ts';
import { loadCharge } from './money.ts';
import { redateCharges } from './phases.ts';
import { loadPhaseRows, recordEvent } from './repo.ts';
import { tick } from './rules.ts';

/**
 * Records usage (hours, calls) or reported receipts against an obligation. Usage also goes to the
 * PayPal meter when Usage-Based Billing is on, so PayPal's own alerts fire.
 */
export async function recordUsage(engine: Engine, live: Live, input: UsageInput): Promise<void> {
  const u = parseInput(UsageInput, input);
  await serially(engine, live.agreement.id, () => recordUsageNow(engine, live, u));
}

async function recordUsageNow(
  engine: Engine,
  live: Live,
  u: z.output<typeof UsageInput>,
): Promise<void> {
  const o = live.plan.obligations.find((x) => x.key === u.obligationKey);
  if (!o || !['usage', 'prepaid', 'revenue_share'].includes(o.kind)) {
    throw new DomainError(
      'invalid',
      'Usage can only be recorded against usage, prepaid or revenue share obligations',
    );
  }
  const on = u.occurredOn ?? (await today(engine.db));
  const key = u.idempotencyKey ?? newId();
  const inserted = await engine.db
    .insert(usageEvents)
    .values({
      agreementId: live.agreement.id,
      obligationKey: o.key,
      quantity: u.quantity.toFixed(2),
      occurredOn: on,
      note: u.note ?? null,
      idempotencyKey: `${live.agreement.id}:${key}`,
    })
    .onConflictDoNothing()
    .returning({ id: usageEvents.id });
  if (inserted.length === 0) return;

  const [meter] = await engine.db
    .select()
    .from(bindings)
    .where(
      and(
        eq(bindings.agreementId, live.agreement.id),
        eq(bindings.obligationKey, o.key),
        eq(bindings.role, 'meter'),
      ),
    );
  if (meter) {
    const metricCode = (meter.data as { metricCode?: string }).metricCode ?? o.key;
    await engine.gateway.recordUsage({
      transactionId: `cw_${(inserted[0] as { id: string }).id}`,
      externalSubscriptionId: meter.paypalId,
      metricCode,
      quantity: u.quantity,
      timestamp: `${on}T12:00:00Z`,
    });
  }
  const what =
    o.kind === 'revenue_share'
      ? `Reported ${formatMoney(fromMajor(u.quantity.toFixed(2), live.plan.currency), live.plan.currency)} of receipts for ${o.title}`
      : `Logged ${u.quantity} ${'unit' in o ? o.unit : 'unit'}${u.quantity === 1 ? '' : 's'} of ${o.title}`;
  await recordEvent(engine.db, live.agreement.id, {
    actor: 'owner',
    type: 'usage_recorded',
    summary: `${what}${u.note ? `: ${u.note}` : ''}`,
    clauseIds: o.clauseIds,
    occurredOn: on,
  });
}

/** "Nov 23 – Dec 18, 2026", or what is known of it. */
const span = (start: string | null, end: string | null) =>
  `${start ? formatDay(start) : 'an open start'} – ${end ? formatDay(end) : 'an open end'}`;

/**
 * A person moves a phase on the Gantt or marks it delivered. Code records the move and re-dates the
 * charges tied to it; the schedule agent then decides what else the agreement requires (moving the
 * phases after it, a reminder, a hold) and says why.
 */
export async function updatePhase(
  engine: Engine,
  live: Live,
  phaseKey: string,
  input: PhaseInput,
): Promise<void> {
  const u = parseInput(PhaseInput, input);
  await serially(engine, live.agreement.id, () => updatePhaseNow(engine, live, phaseKey, u));
}

async function updatePhaseNow(
  engine: Engine,
  live: Live,
  phaseKey: string,
  u: z.output<typeof PhaseInput>,
): Promise<void> {
  const phase = live.plan.phases.find((p) => p.key === phaseKey);
  if (!phase) throw new DomainError('not_found', `No phase ${phaseKey}`);
  const on = await today(engine.db);
  const before = live.phases[phaseKey] ?? { start: null, end: null };
  let start = u.start ?? before.start;
  let end = u.end ?? before.end;
  if (start && end && end < start)
    throw new DomainError('invalid', 'A phase cannot end before it starts');
  const rows = await loadPhaseRows(engine.db, live.agreement.id);
  const row = rows.find((r) => r.phaseKey === phaseKey);
  if (row?.completedOn && (u.start || u.end) && u.completedOn === undefined) {
    throw new DomainError(
      'conflict',
      `${phase.name} was delivered on ${row.completedOn}; its dates are history now`,
    );
  }
  if (u.completedOn && u.completedOn > on) {
    throw new DomainError('invalid', `A phase cannot be delivered after today (${on})`);
  }
  const delivering = Boolean(u.completedOn) && !row?.completedOn;
  if (delivering) {
    // Work is delivered in the order the schedule sets: a phase before the ones it builds on
    // would leave the timeline (and the invoices tied to it) contradicting itself.
    const waiting = phase.dependsOn
      .filter((k) => !rows.find((r) => r.phaseKey === k)?.completedOn)
      .map((k) => live.plan.phases.find((p) => p.key === k)?.name ?? k);
    if (waiting.length > 0) {
      throw new DomainError(
        'conflict',
        `Deliver ${waiting.join(' and ')} first: ${phase.name} follows ${waiting.length === 1 ? 'it' : 'them'}`,
      );
    }
    // Delivered early, the phase ends when it was delivered, so the timeline shows what happened.
    const done = u.completedOn as string;
    if (!end || done < end) end = done;
    if (!start || done < start) start = done;
  }
  const completedOn = u.completedOn === undefined ? (row?.completedOn ?? null) : u.completedOn;
  await engine.db
    .insert(phaseDates)
    .values({ agreementId: live.agreement.id, phaseKey, start, end, completedOn })
    .onConflictDoUpdate({
      target: [phaseDates.agreementId, phaseDates.phaseKey],
      set: { start, end, completedOn },
    });

  const fresh = await loadLive(engine.db, live.agreement.id);
  // Dates fitted to a delivery are a record of what happened, not a move for the agent to answer.
  const moved = !delivering && (start !== before.start || end !== before.end);
  if (moved) {
    const redated = await redateCharges(engine, fresh);
    await recordEvent(engine.db, live.agreement.id, {
      actor: 'owner',
      type: 'phase_moved',
      summary: `Moved ${phase.name} to ${start ? formatDay(start) : '?'} – ${end ? formatDay(end) : '?'}${redated.length ? `; re-dated ${redated.join(', ')}` : ''}`,
      clauseIds: phase.clauseIds,
      data: { phase: phaseKey, from: before, to: { start, end } },
      occurredOn: on,
    });
    await consult(engine, fresh, on, {
      key: `moved:${phaseKey}:${start}:${end}:${Date.now()}`,
      kind: 'phase_moved',
      summary: `${phase.name} moved from ${span(before.start, before.end)} to ${span(start, end)}`,
      details: {
        phase: phaseKey,
        from: before,
        to: { start, end },
        dependents: live.plan.phases
          .filter((p) => p.dependsOn.includes(phaseKey))
          .map((p) => p.key),
      },
    });
  }
  if (u.completedOn && u.completedOn !== row?.completedOn) {
    await recordEvent(engine.db, live.agreement.id, {
      actor: 'owner',
      type: 'phase_delivered',
      summary: `${phase.name} delivered on ${formatDay(u.completedOn)}`,
      clauseIds: phase.clauseIds,
      occurredOn: on,
    });
  }
  await tick(engine, await loadLive(engine.db, live.agreement.id), on);
}

export async function remindCharge(engine: Engine, live: Live, chargeId: string): Promise<void> {
  const charge = await loadCharge(
    engine.db,
    live.agreement.id,
    parseInput(z.string().uuid(), chargeId),
  );
  if (
    !['issued', 'overdue'].includes(charge.status) ||
    !charge.paypalRef ||
    charge.paypalProduct !== 'invoicing'
  ) {
    throw new DomainError('conflict', 'Only an open invoice can be reminded');
  }
  const payer = party(live, charge.payer);
  await engine.gateway.remindInvoice(
    charge.paypalRef,
    `A reminder about ${charge.label}, raised under ${live.plan.title}.`,
  );
  await recordEvent(engine.db, live.agreement.id, {
    actor: 'owner',
    type: 'reminder_sent',
    summary: `Reminded ${payer.name} about ${charge.label}`,
    clauseIds: charge.clauseIds,
    data: { chargeId: charge.id },
    occurredOn: await today(engine.db),
  });
}

/** The terms of every obligation in one line each, as agents read them. */
export function termsOf(plan: Plan): { key: string; kind: string; title: string; terms: string }[] {
  return plan.obligations.map((o) => ({
    key: o.key,
    kind: o.kind,
    title: o.title,
    terms: explainObligation(plan, o),
  }));
}
