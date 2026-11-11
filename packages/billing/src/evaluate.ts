import {
  type AmountRule,
  applyBps,
  type Given,
  maxBig,
  minBig,
  type Obligation,
  type Plan,
} from '@clausework/core';
import { monthsElapsed } from './dates.ts';

/** A scenario the obligation cannot be evaluated for, such as usage with no quantity. */
export class EvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvaluationError';
  }
}

function need<T>(value: T | null, field: string, obligation: Obligation): T {
  if (value === null) {
    throw new EvaluationError(`${obligation.kind} "${obligation.key}" needs given.${field}`);
  }
  return value;
}

export function resolveAmount(plan: Plan, rule: AmountRule): bigint {
  if (rule.kind === 'fixed') return rule.amount;
  if (plan.contractValue === null) {
    throw new EvaluationError('a percentage of the contract needs the contract value');
  }
  return applyBps(plan.contractValue, rule.bps);
}

/** Quantities may carry two decimals (1.5 hours). They are counted in hundredths. */
const hundredths = (q: number) => BigInt(Math.round(q * 100));

/** `rate × units`, with units in hundredths, rounded half up to the minor unit. */
const priceOf = (rate: bigint, unitsHundredths: bigint) => (rate * unitsHundredths + 50n) / 100n;

/** The amount for a recurring fee in a given period, with any escalator compounded and rounded each step. */
export function recurringAmount(
  obligation: Extract<Obligation, { kind: 'recurring' }>,
  periodIndex: number,
): bigint {
  let amount = obligation.amount;
  const { escalator } = obligation;
  if (!escalator) return amount;
  const steps = Math.floor(monthsElapsed(obligation.interval, periodIndex) / escalator.everyMonths);
  for (let i = 0; i < steps; i++) amount += applyBps(amount, escalator.bps);
  return amount;
}

/**
 * What one obligation charges, pays or credits in one scenario, in minor units.
 *
 * - deposit, milestone: the amount due.
 * - recurring: the fee for `periodIndex` (0 = first period), escalator applied.
 * - usage: the charge for `quantity` units used in a period, above the included units, capped.
 * - prepaid: the block price when `quantity` is null, otherwise the overage for `quantity` used.
 * - late_fee: the fee on an `invoiceAmount` paid `daysLate` days after its due date.
 * - revenue_share: the payout for a period with `receipts`, after `priorReceipts` in earlier
 *   periods, net of any advance still being recouped.
 * - split: the payee's share of `receipts`.
 * - retainage: the amount held back from an `invoiceAmount`.
 * - service_credit: the credit on an `invoiceAmount` when the condition is met.
 */
export function evaluate(plan: Plan, obligation: Obligation, given: Given): bigint {
  switch (obligation.kind) {
    case 'deposit':
    case 'milestone':
      return resolveAmount(plan, obligation.amount);

    case 'recurring':
      return recurringAmount(obligation, given.periodIndex ?? 0);

    case 'usage': {
      const used = hundredths(need(given.quantity, 'quantity', obligation));
      let billable = maxBig(0n, used - hundredths(obligation.included));
      if (obligation.cap !== null) billable = minBig(billable, hundredths(obligation.cap));
      return priceOf(obligation.rate, billable);
    }

    case 'prepaid': {
      if (given.quantity === null) return obligation.price;
      if (obligation.overageRate === null) return 0n;
      const over = maxBig(0n, hundredths(given.quantity) - hundredths(obligation.units));
      return priceOf(obligation.overageRate, over);
    }

    case 'late_fee': {
      const invoice = need(given.invoiceAmount, 'invoiceAmount', obligation);
      const late = need(given.daysLate, 'daysLate', obligation) - obligation.graceDays;
      if (late <= 0) return 0n;
      const units = obligation.per === 'day' ? late : Math.ceil(late / 30);
      return applyBps(invoice, obligation.rateBps * units);
    }

    case 'revenue_share': {
      const receipts = need(given.receipts, 'receipts', obligation);
      const prior = given.priorReceipts ?? 0n;
      const recoup = obligation.recoup ?? 0n;
      const before = applyBps(prior, obligation.bps);
      const after = applyBps(prior + receipts, obligation.bps);
      return maxBig(0n, after - recoup) - maxBig(0n, before - recoup);
    }

    case 'split':
      return applyBps(need(given.receipts, 'receipts', obligation), obligation.bps);

    case 'retainage':
    case 'service_credit':
      return applyBps(need(given.invoiceAmount, 'invoiceAmount', obligation), obligation.bps);
  }
}
