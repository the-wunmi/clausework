import type { Plan } from '@clausework/core';
import type { IsoDay } from './dates.ts';
import { recurringAmount } from './evaluate.ts';
import type { ProjectedCharge } from './schedule.ts';

/** A payment that really moved, as PayPal recorded it. */
export interface Transaction {
  id: string;
  date: IsoDay;
  /** Positive minor units in the plan's currency. */
  amount: bigint;
  /** Who paid and who was paid, as party keys, when known. */
  payer: string | null;
  payee: string | null;
  memo: string;
}

/** The matcher's verdict for one transaction: which projected charge it pays, if any. */
export interface Match {
  transactionId: string;
  /** A `ProjectedCharge.id`, or null when the transaction pays nothing in the plan. */
  chargeId: string | null;
  /** The obligation, even when no projected charge fits (e.g. a fee billed after termination). */
  obligationKey: string | null;
  reason: string;
}

export type LeakKind =
  | 'unbilled'
  | 'underbilled'
  | 'overbilled'
  | 'escalator_misapplied'
  | 'duplicate'
  | 'after_termination'
  | 'unexplained';

export interface Leak {
  kind: LeakKind;
  obligationKey: string | null;
  chargeId: string | null;
  clauseIds: string[];
  label: string;
  expected: bigint;
  actual: bigint;
  /** Always positive: how much should move to settle it. */
  amount: bigint;
  /** The party the money is owed to. */
  owedTo: string | null;
  owedBy: string | null;
  transactionIds: string[];
  recovery: string;
}

export interface AuditReport {
  leaks: Leak[];
  /** Totals from the perspective party's side. */
  owedToYou: bigint;
  youOwe: bigint;
  expectedTotal: bigint;
  actualTotal: bigint;
  chargesChecked: number;
  transactionsChecked: number;
}

/**
 * Compares what the plan says should have moved with what did. Matching transactions to charges
 * takes judgement (the model does it); every amount here is arithmetic.
 */
export function owedVersusPaid(
  plan: Plan,
  perspective: string,
  expected: ProjectedCharge[],
  transactions: Transaction[],
  matches: Match[],
): AuditReport {
  const byId = new Map(transactions.map((t) => [t.id, t]));
  const charges = new Map(expected.map((c) => [c.id, c]));
  const obligations = new Map(plan.obligations.map((o) => [o.key, o]));
  const paidFor = new Map<string, Transaction[]>();
  const leaks: Leak[] = [];
  const seen = new Set<string>();

  for (const m of matches) {
    const t = byId.get(m.transactionId);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    if (m.chargeId && charges.has(m.chargeId)) {
      paidFor.set(m.chargeId, [...(paidFor.get(m.chargeId) ?? []), t]);
      continue;
    }
    const o = m.obligationKey ? obligations.get(m.obligationKey) : undefined;
    if (o && plan.endDate && t.date > plan.endDate) {
      leaks.push({
        kind: 'after_termination',
        obligationKey: o.key,
        chargeId: null,
        clauseIds: o.clauseIds,
        label: `${o.title} charged after the agreement ended on ${plan.endDate}`,
        expected: 0n,
        actual: t.amount,
        amount: t.amount,
        owedTo: o.payer,
        owedBy: o.payee,
        transactionIds: [t.id],
        recovery: 'Cancel the subscription and refund the charge in full.',
      });
      continue;
    }
    leaks.push(unexplained(t, m.reason));
  }
  for (const t of transactions) if (!seen.has(t.id)) leaks.push(unexplained(t, 'not matched'));

  let expectedTotal = 0n;
  for (const c of expected) {
    if (c.amount === null) continue;
    expectedTotal += c.amount;
    const paid = paidFor.get(c.id) ?? [];
    const actual = paid.reduce((s, t) => s + t.amount, 0n);
    if (actual === c.amount) continue;
    const ids = paid.map((t) => t.id);
    const common = {
      obligationKey: c.obligationKey,
      chargeId: c.id,
      clauseIds: c.clauseIds,
      label: c.label,
      expected: c.amount,
      actual,
      transactionIds: ids,
    };

    if (actual < c.amount) {
      leaks.push({
        ...common,
        kind: actual === 0n ? 'unbilled' : 'underbilled',
        amount: c.amount - actual,
        owedTo: c.payee,
        owedBy: c.payer,
        recovery:
          actual === 0n
            ? 'Send a catch-up invoice that cites the clause.'
            : 'Invoice the difference, citing the clause.',
      });
      continue;
    }
    const duplicate = paid.length > 1 && paid.some((t) => t.amount === c.amount);
    const o = obligations.get(c.obligationKey);
    const misEscalated =
      !duplicate &&
      o?.kind === 'recurring' &&
      o.escalator !== null &&
      c.periodIndex !== null &&
      actual !== recurringAmount(o, c.periodIndex);
    leaks.push({
      ...common,
      kind: duplicate ? 'duplicate' : misEscalated ? 'escalator_misapplied' : 'overbilled',
      amount: actual - c.amount,
      owedTo: c.payer,
      owedBy: c.payee,
      recovery: duplicate
        ? 'Refund the duplicate payment through PayPal, or credit it against the next charge.'
        : 'Refund the excess, or credit it against the next charge.',
    });
  }

  let owedToYou = 0n;
  let youOwe = 0n;
  for (const l of leaks) {
    if (l.owedTo === perspective) owedToYou += l.amount;
    else if (l.owedBy === perspective) youOwe += l.amount;
  }

  return {
    leaks: leaks.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)),
    owedToYou,
    youOwe,
    expectedTotal,
    actualTotal: transactions.reduce((s, t) => s + t.amount, 0n),
    chargesChecked: expected.length,
    transactionsChecked: transactions.length,
  };
}

function unexplained(t: Transaction, reason: string): Leak {
  return {
    kind: 'unexplained',
    obligationKey: null,
    chargeId: null,
    clauseIds: [],
    label: `${t.memo || 'Payment'} (${reason})`,
    expected: 0n,
    actual: t.amount,
    amount: t.amount,
    owedTo: null,
    owedBy: null,
    transactionIds: [t.id],
    recovery: 'Review: no clause explains this payment.',
  };
}
