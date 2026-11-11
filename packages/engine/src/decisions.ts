import type { ScheduleProposal, ScheduleView } from '@clausework/agents';
import {
  addDays,
  daysBetween,
  evaluate,
  explainObligation,
  formatMoney,
} from '@clausework/billing';
import { DomainError, EMPTY_GIVEN, sha256, toMajor } from '@clausework/core';
import { agentDecisions, charges, events, phaseDates } from '@clausework/db';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import type { Engine } from './context.ts';
import { clauseRefs, flowOf, type Live, loadLive, party } from './live.ts';
import {
  amountDue,
  type ChargeRow,
  captureDeposit,
  loadCharge,
  payOut,
  raise,
  requestKey,
} from './money.ts';
import { redateCharges } from './phases.ts';
import { isUuid, loadPhaseRows, recordEvent } from './repo.ts';

/** A late fee invoice gets the payer two weeks; the clause sets the rate, not the terms. */
const LATE_FEE_TERMS_DAYS = 14;

/** A proposal is cut to this many actions, so a runaway answer cannot move much at once. */
const MAX_ACTIONS = 6;

/** Charges further out than this are noise to the agent. */
const VIEW_HORIZON_DAYS = 95;

/** A payer hears about the same charge at most once a week, whichever trigger asks. */
const REMINDER_COOLDOWN_DAYS = 7;

/**
 * The gateway for judgement. Every runtime decision passes through `consult`: it builds exactly
 * what the agent may see, asks it, checks each proposed action against the approved plan, runs
 * what passes and records all of it, bound to the view the agent saw. A situation is decided once
 * (`trigger.key`), however often the rules notice it.
 */

export interface Trigger {
  /** Unique per situation, e.g. `gate:build:2027-03-08`. */
  key: string;
  kind: string;
  summary: string;
  details: Record<string, unknown>;
}

type Action = ScheduleProposal['actions'][number];

interface Outcome {
  action: Action;
  status: 'executed' | 'rejected' | 'escalated' | 'no_action';
  reason: string;
}

export async function consult(
  engine: Engine,
  live: Live,
  on: string,
  trigger: Trigger,
): Promise<void> {
  const [claimed] = await engine.db
    .insert(agentDecisions)
    .values({
      agreementId: live.agreement.id,
      triggerKey: trigger.key,
      occurredOn: on,
      trigger: { kind: trigger.kind, summary: trigger.summary, ...trigger.details },
      view: {},
      outcome: { status: 'pending', reason: 'deciding' },
      decidedBy: 'pending',
    })
    .onConflictDoNothing()
    .returning({ id: agentDecisions.id });
  if (!claimed) return;

  const view = await buildView(engine, live, on, trigger);
  let proposal: ScheduleProposal;
  let decidedBy: string;
  if (engine.agents) {
    try {
      const decided = await engine.agents.schedule.decide(view);
      proposal = decided.proposal;
      decidedBy = decided.model;
    } catch (err) {
      proposal = fallback(
        trigger,
        `the schedule agent could not decide: ${err instanceof Error ? err.message : String(err)}`,
      );
      decidedBy = 'rules';
    }
  } else {
    proposal = fallback(trigger, 'no model is configured');
    decidedBy = 'rules';
  }

  const outcomes: Outcome[] = [];
  for (const action of proposal.actions.slice(0, MAX_ACTIONS)) {
    // Re-read: an earlier action may have moved a phase or raised a charge.
    const fresh = await loadLive(engine.db, live.agreement.id);
    try {
      outcomes.push(await apply(engine, fresh, on, action));
    } catch (err) {
      // A failed action is an outcome, not a lost decision: the owner sees it and can act.
      outcomes.push({
        action,
        status: 'rejected',
        reason: `failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const status = overallStatus(outcomes);
  const first = proposal.actions.find((a) => a.action !== 'no_action') ?? proposal.actions[0];
  const clause = first ? live.plan.clauses.find((c) => c.id === first.clauseId) : undefined;
  await engine.db
    .update(agentDecisions)
    .set({
      view,
      proposal: {
        // The decision is bound to exactly what the agent was shown.
        viewHash: sha256(view),
        action: actionList(proposal.actions.map((a) => a.action)),
        rationale: first?.rationale ?? proposal.summary,
        clauseId: clause?.id ?? null,
        clauseQuote: clause?.quote ?? null,
        summary: proposal.summary,
        actions: proposal.actions,
      },
      outcome: {
        status,
        reason:
          outcomes
            .filter((o) => o.action.action !== 'no_action' || outcomes.length === 1)
            .map((o) => `${ACTION_WORDS[o.action.action]}: ${o.reason}`)
            .join('; ') || 'Nothing to do',
        actions: outcomes.map((o) => ({
          action: o.action.action,
          target: o.action.target,
          status: o.status,
          reason: o.reason,
        })),
      },
      decidedBy,
    })
    .where(eq(agentDecisions.id, claimed.id));
  await recordEvent(engine.db, live.agreement.id, {
    actor: 'agent',
    type: 'agent_decision',
    summary: proposal.summary,
    clauseIds: [
      ...new Set(
        proposal.actions
          .map((a) => a.clauseId)
          .filter((c) => live.plan.clauses.some((x) => x.id === c)),
      ),
    ],
    data: { decisionId: claimed.id, trigger: trigger.kind, status },
    occurredOn: on,
  });
}

/** One status for a decision: the most consequential thing any of its actions did. */
function overallStatus(outcomes: Outcome[]): Outcome['status'] {
  for (const status of ['executed', 'escalated', 'rejected'] as const) {
    if (outcomes.some((o) => o.status === status)) return status;
  }
  return 'no_action';
}

function fallback(trigger: Trigger, why: string): ScheduleProposal {
  return {
    summary: `${trigger.summary}. Passed to you because ${why}.`,
    actions: [
      {
        action: 'escalate',
        target: null,
        start: null,
        end: null,
        message: trigger.summary,
        clauseId: '',
        rationale: why,
      },
    ],
  };
}

async function buildView(
  engine: Engine,
  live: Live,
  on: string,
  trigger: Trigger,
): Promise<ScheduleView> {
  const phaseRows = await loadPhaseRows(engine.db, live.agreement.id);
  const open = await engine.db
    .select()
    .from(charges)
    .where(
      and(
        eq(charges.agreementId, live.agreement.id),
        notInArray(charges.status, ['paid', 'cancelled', 'refunded']),
      ),
    );
  return {
    today: on,
    agreement: { title: live.plan.title, currency: live.plan.currency, ownerParty: live.owner.key },
    trigger: { kind: trigger.kind, summary: trigger.summary, details: trigger.details },
    parties: live.plan.parties.map((p) => ({ key: p.key, name: p.name, role: p.role })),
    clauses: live.plan.clauses.map((c) => ({ id: c.id, ref: c.ref, quote: c.quote })),
    phases: live.plan.phases.map((p) => ({
      key: p.key,
      name: p.name,
      plannedStart: p.start,
      plannedEnd: p.end,
      start: live.phases[p.key]?.start ?? null,
      end: live.phases[p.key]?.end ?? null,
      completedOn: phaseRows.find((r) => r.phaseKey === p.key)?.completedOn ?? null,
      dependsOn: p.dependsOn,
      gatedBy: p.gatedBy,
    })),
    obligations: live.plan.obligations.map((o) => ({
      key: o.key,
      kind: o.kind,
      title: o.title,
      terms: explainObligation(live.plan, o),
      clauseIds: o.clauseIds,
    })),
    openCharges: open
      .filter((c) => c.issueDate === null || c.issueDate <= addDays(on, VIEW_HORIZON_DAYS))
      .slice(0, 40)
      .map((c) => ({
        id: c.id,
        label: c.label,
        obligationKey: c.obligationKey,
        status: c.status,
        issueDate: c.issueDate,
        dueDate: c.dueDate,
        amount: c.amount === null ? null : toMajor(c.amount, c.currency),
        daysOverdue:
          c.dueDate && c.dueDate < on && ['issued', 'overdue'].includes(c.status)
            ? daysBetween(c.dueDate, on)
            : null,
      })),
  };
}

/** Checks one action against the plan and, if it holds, does it. Never trusts a number from the model. */
async function apply(engine: Engine, live: Live, on: string, a: Action): Promise<Outcome> {
  const reject = (reason: string): Outcome => ({ action: a, status: 'rejected', reason });
  const ok = (reason: string): Outcome => ({ action: a, status: 'executed', reason });
  const clauseKnown = live.plan.clauses.some((c) => c.id === a.clauseId);
  if (a.action === 'no_action') return { action: a, status: 'no_action', reason: a.rationale };
  if (a.action === 'escalate') {
    await recordEvent(engine.db, live.agreement.id, {
      actor: 'agent',
      type: 'escalated',
      summary: a.message ?? a.rationale,
      clauseIds: clauseKnown ? [a.clauseId] : [],
      occurredOn: on,
    });
    return { action: a, status: 'escalated', reason: 'passed to the owner' };
  }
  if (!clauseKnown)
    return reject(`cites ${a.clauseId || 'no clause'}, which is not in the agreement`);

  switch (a.action) {
    case 'shift_phase':
    case 'hold_phase': {
      const phase = live.plan.phases.find((p) => p.key === a.target);
      if (!phase) return reject(`no phase ${a.target}`);
      const rows = await loadPhaseRows(engine.db, live.agreement.id);
      if (rows.find((r) => r.phaseKey === phase.key)?.completedOn)
        return reject(`${phase.name} is already delivered`);
      if (a.action === 'hold_phase') {
        await recordEvent(engine.db, live.agreement.id, {
          actor: 'agent',
          type: 'phase_held',
          summary: `${phase.name} is on hold until the payment that gates it arrives`,
          clauseIds: [a.clauseId],
          data: { phase: phase.key },
          occurredOn: on,
        });
        return ok(`${phase.name} held`);
      }
      if (
        !a.start ||
        !a.end ||
        !/^\d{4}-\d{2}-\d{2}$/.test(a.start) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(a.end) ||
        a.end < a.start
      ) {
        return reject('needs a valid start and end');
      }
      // The agent may delay a phase, never bring it forward: an earlier start would release money
      // (a deposit capture) before the agreement says so. People can move phases either way.
      const current = live.phases[phase.key];
      if (current?.start && a.start < current.start) {
        return reject(
          `the agent can delay ${phase.name}, not bring it forward from ${current.start}`,
        );
      }
      for (const dep of phase.dependsOn) {
        const depEnd = live.phases[dep]?.end;
        if (depEnd && a.start <= depEnd)
          return reject(`${phase.name} cannot start before ${dep} ends on ${depEnd}`);
      }
      const before = live.phases[phase.key];
      await engine.db
        .insert(phaseDates)
        .values({ agreementId: live.agreement.id, phaseKey: phase.key, start: a.start, end: a.end })
        .onConflictDoUpdate({
          target: [phaseDates.agreementId, phaseDates.phaseKey],
          set: { start: a.start, end: a.end },
        });
      const moved = await redateCharges(engine, await loadLive(engine.db, live.agreement.id));
      await recordEvent(engine.db, live.agreement.id, {
        actor: 'agent',
        type: 'phase_moved',
        summary: `Moved ${phase.name} from ${before?.start ?? '?'}–${before?.end ?? '?'} to ${a.start}–${a.end}${moved.length ? `; re-dated ${moved.join(', ')}` : ''}`,
        clauseIds: [a.clauseId],
        data: { phase: phase.key, start: a.start, end: a.end, moved },
        occurredOn: on,
      });
      return ok(`${phase.name} now ${a.start} to ${a.end}`);
    }
    case 'issue_invoice': {
      const charge = await chargeFor(engine, live, a.target);
      if (!charge) return reject(`no charge ${a.target}`);
      if (charge.status !== 'scheduled')
        return reject(`${charge.label} is already ${charge.status}`);
      if (charge.amount === null) return reject(`${charge.label} has no amount yet`);
      // The same due test the rules apply: the date has come and, for a milestone, the work is delivered.
      if (charge.issueDate && charge.issueDate > on) {
        return reject(`${charge.label} is not due until ${charge.issueDate}`);
      }
      const owed = live.plan.obligations.find((o) => o.key === charge.obligationKey);
      if (owed?.kind === 'milestone' && owed.phase) {
        const rows = await loadPhaseRows(engine.db, live.agreement.id);
        if (!rows.find((r) => r.phaseKey === owed.phase)?.completedOn) {
          return reject(`${charge.label} is raised when the phase is delivered`);
        }
      }
      await raise(engine, live, charge, on);
      return ok(`raised ${charge.label}`);
    }
    case 'send_reminder': {
      const charge = await chargeFor(engine, live, a.target);
      if (!charge) return reject(`no charge ${a.target}`);
      if (
        !['issued', 'overdue'].includes(charge.status) ||
        charge.paypalProduct !== 'invoicing' ||
        !charge.paypalRef
      ) {
        return reject(`${charge.label} has no open invoice to remind`);
      }
      const last = await lastReminder(engine, live, charge.id);
      if (last && daysBetween(last, on) < REMINDER_COOLDOWN_DAYS) {
        return reject(
          `a reminder went out on ${last}; the next can go from ${addDays(last, REMINDER_COOLDOWN_DAYS)}`,
        );
      }
      try {
        await engine.gateway.remindInvoice(charge.paypalRef, (a.message ?? '').slice(0, 1000));
      } catch (err) {
        return reject(
          `PayPal refused the reminder: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await recordEvent(engine.db, live.agreement.id, {
        actor: 'agent',
        type: 'reminder_sent',
        summary: `Reminded ${party(live, charge.payer).name} about ${charge.label}: “${a.message ?? ''}”`,
        clauseIds: [a.clauseId],
        data: { chargeId: charge.id },
        occurredOn: on,
      });
      return ok('reminder sent through PayPal');
    }
    case 'apply_late_fee': {
      const charge = await chargeFor(engine, live, a.target);
      if (!charge) return reject(`no charge ${a.target}`);
      if (charge.status !== 'overdue' || !charge.dueDate || amountDue(charge) === null)
        return reject(`${charge.label} is not overdue`);
      if (charge.kind === 'late_fee') return reject('a late fee is not charged on a late fee');
      const fee = live.plan.obligations.find(
        (o) =>
          o.kind === 'late_fee' &&
          (o.appliesTo.includes('*') || o.appliesTo.includes(charge.obligationKey)),
      );
      if (fee?.kind !== 'late_fee') return reject('no late payment clause covers this charge');
      if (!fee.clauseIds.includes(a.clauseId))
        return reject(
          `the late fee comes from ${clauseRefs(live.plan, fee.clauseIds).join(', ')}, not ${a.clauseId}`,
        );
      if (flowOf(live, fee) !== 'collect') return reject('the late fee is not owed to the owner');
      const daysLate = daysBetween(charge.dueDate, on);
      const total = evaluate(live.plan, fee, {
        ...EMPTY_GIVEN,
        invoiceAmount: amountDue(charge),
        daysLate,
      });
      const prefix = `${fee.key}:${charge.chargeKey}:`;
      const already = await engine.db
        .select({ amount: charges.amount, key: charges.chargeKey })
        .from(charges)
        .where(and(eq(charges.agreementId, live.agreement.id), eq(charges.obligationKey, fee.key)));
      const charged = already
        .filter((r) => r.key.startsWith(prefix))
        .reduce((s, r) => s + (r.amount ?? 0n), 0n);
      const owed = total - charged;
      if (owed <= 0n) return reject(`the fee for ${daysLate} days late is already charged`);
      const step = Math.ceil(daysLate / 30);
      const [row] = await engine.db
        .insert(charges)
        .values({
          agreementId: live.agreement.id,
          chargeKey: `${fee.key}:${charge.chargeKey}:${step}`,
          obligationKey: fee.key,
          kind: 'late_fee',
          label: `${fee.title} on ${charge.label}`,
          payer: fee.payer,
          payee: fee.payee,
          amount: owed,
          currency: charge.currency,
          status: 'scheduled',
          issueDate: on,
          dueDate: addDays(on, LATE_FEE_TERMS_DAYS),
          clauseIds: fee.clauseIds,
          paypalProduct: 'invoicing',
          basis: `${fee.rateBps / 100}% × ${step} month${step === 1 ? '' : 's'} on ${formatMoney(amountDue(charge) ?? 0n, charge.currency)} (${daysLate} days late)`,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return reject('this month’s late fee was already raised');
      await raise(engine, live, row, on);
      return ok(`late fee ${formatMoney(owed, charge.currency)} invoiced`);
    }
    case 'capture_deposit':
    case 'reauthorize_deposit': {
      const charge = await chargeFor(engine, live, a.target);
      if (charge?.kind !== 'deposit') return reject('not a deposit');
      const data = (charge.paypalData ?? {}) as { authorizationId?: string };
      if (charge.status !== 'authorized' || !data.authorizationId)
        return reject('the deposit is not authorized');
      if (a.action === 'capture_deposit') {
        const gated = live.plan.phases.find((p) => p.gatedBy === charge.obligationKey);
        const starts = gated ? live.phases[gated.key]?.start : null;
        if (starts && starts > on)
          return reject(`the deposit is captured when ${gated?.name} starts on ${starts}`);
        await captureDeposit(engine, live, charge, data.authorizationId, on);
        return ok('deposit captured');
      }
      const auth = await engine.gateway.reauthorize(
        data.authorizationId,
        requestKey('reauthorize', charge.id, on),
      );
      await engine.db
        .update(charges)
        .set({
          paypalData: {
            ...(charge.paypalData as object),
            authorizationId: auth.id,
            authorizedOn: on,
          },
        })
        .where(eq(charges.id, charge.id));
      return ok(`reauthorized as ${auth.id}`);
    }
    case 'retry_payout': {
      const charge = await chargeFor(engine, live, a.target);
      if (!charge) return reject(`no charge ${a.target}`);
      if (charge.status === 'unclaimed') {
        return reject(
          'the first payout can still be claimed; sending another could pay twice. Ask the payee to claim it, or wait for PayPal to return it',
        );
      }
      if (charge.status !== 'failed' || charge.paypalProduct !== 'payouts') {
        return reject(`${charge.label} is ${charge.status}, not a returned payout`);
      }
      const attempt = ((charge.paypalData as { attempt?: number } | null)?.attempt ?? 0) + 1;
      if (attempt > 3)
        return reject('three attempts already; ask the payee for new PayPal details');
      await payOut(engine, live, charge, on, attempt);
      return ok(`payout sent again (attempt ${attempt + 1})`);
    }
    case 'notify': {
      const p = live.plan.parties.find((x) => x.key === a.target);
      if (!p || !a.message) return reject('needs a party and a message');
      await recordEvent(engine.db, live.agreement.id, {
        actor: 'agent',
        type: 'notified',
        summary: `Told ${p.name}: “${a.message}”`,
        clauseIds: [a.clauseId],
        data: { party: p.key, message: a.message },
        occurredOn: on,
      });
      return ok(`${p.name} notified`);
    }
  }
}

async function chargeFor(engine: Engine, live: Live, id: string | null): Promise<ChargeRow | null> {
  if (!id || !isUuid(id)) return null;
  try {
    return await loadCharge(engine.db, live.agreement.id, id);
  } catch (err) {
    if (err instanceof DomainError && err.code === 'not_found') return null;
    throw err;
  }
}

/**
 * What the agent chose, as one sentence: "Capture the deposit and send a reminder". A "no action"
 * beside real actions is noise, so it is left out unless it is all there was.
 */
function actionList(actions: (keyof typeof ACTION_WORDS)[]): string {
  const acted = actions.filter((a) => a !== 'no_action');
  if (acted.length === 0) return ACTION_WORDS.no_action;
  const words = [...new Set(acted)].map((a, i) => {
    const w = ACTION_WORDS[a];
    return i === 0 ? w : w.charAt(0).toLowerCase() + w.slice(1);
  });
  return words.length === 1
    ? (words[0] as string)
    : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** How each action reads in the activity log. */
const ACTION_WORDS: Record<Action['action'], string> = {
  shift_phase: 'Move a phase',
  hold_phase: 'Hold a phase',
  issue_invoice: 'Raise a charge',
  send_reminder: 'Send a reminder',
  apply_late_fee: 'Apply the late fee',
  capture_deposit: 'Capture the deposit',
  reauthorize_deposit: 'Renew the deposit authorization',
  retry_payout: 'Resend a payout',
  notify: 'Notify a party',
  escalate: 'Ask the owner',
  no_action: 'No action needed',
};

async function lastReminder(engine: Engine, live: Live, chargeId: string): Promise<string | null> {
  const [row] = await engine.db
    .select({ on: events.occurredOn })
    .from(events)
    .where(
      and(
        eq(events.agreementId, live.agreement.id),
        eq(events.type, 'reminder_sent'),
        sql`${events.data}->>'chargeId' = ${chargeId}`,
      ),
    )
    .orderBy(desc(events.occurredOn))
    .limit(1);
  return row?.on ?? null;
}
