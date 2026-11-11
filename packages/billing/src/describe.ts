import type { DateRef, Obligation, Plan } from '@clausework/core';
import { toMajor } from '@clausework/core';

const PER: Record<string, string> = {
  week: 'a week',
  month: 'a month',
  quarter: 'a quarter',
  year: 'a year',
};
const EVERY: Record<string, string> = {
  week: 'weekly',
  month: 'monthly',
  quarter: 'quarterly',
  year: 'yearly',
};

export function formatMoney(amount: bigint, currency: string): string {
  const major = Number(toMajor(amount, currency));
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(major);
}

/** "20 hours", "1 hour". Only plain words get an s; a bundle unit such as "1000 calls" is multiplied out. */
export function count(n: number, unit: string): string {
  const name = unit.replaceAll('_', ' ');
  const amount = n.toLocaleString('en-US');
  // "1000 calls" is a bundle: 1,000 of them read as "1,000,000 calls", not two numbers glued.
  const bundle = /^(\d[\d,]*)\s+(.+)$/.exec(name);
  if (bundle) {
    const total = n * Number((bundle[1] as string).replaceAll(',', ''));
    return `${total.toLocaleString('en-US')} ${bundle[2]}`;
  }
  const plural = n !== 1 && /^[a-z]+$/i.test(name) && !name.endsWith('s');
  return `${amount} ${name}${plural ? 's' : ''}`;
}

const DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "2027-04-20" → "Apr 20, 2027", for text people read. */
export const formatDay = (day: string): string => DAY.format(new Date(`${day}T00:00:00Z`));

const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

export function describeDate(plan: Plan, ref: DateRef): string {
  const phase = (key: string) => plan.phases.find((p) => p.key === key)?.name ?? key;
  const offset = (n: number) => (n === 0 ? '' : n > 0 ? ` + ${n} days` : ` − ${-n} days`);
  switch (ref.kind) {
    case 'date':
      return ref.date;
    case 'effective':
      return ref.offsetDays === 0 ? 'on signing' : `${ref.offsetDays} days after signing`;
    case 'phase_start':
      return `when ${phase(ref.phase)} starts${offset(ref.offsetDays)}`;
    case 'phase_end':
      return `when ${phase(ref.phase)} is delivered${offset(ref.offsetDays)}`;
  }
}

/** One line a person can check against the clause: "$3,000.00 a month, +3% every 12 months". */
export function explainObligation(plan: Plan, o: Obligation): string {
  const m = (v: bigint) => formatMoney(v, plan.currency);
  const amount = (rule: Extract<Obligation, { kind: 'deposit' }>['amount']) =>
    rule.kind === 'fixed'
      ? m(rule.amount)
      : `${pct(rule.bps)} of ${plan.contractValue === null ? 'the contract value' : m(plan.contractValue)}`;
  const names = (keys: string[]) =>
    keys
      .map((k) =>
        k === '*' ? 'every invoice' : (plan.obligations.find((x) => x.key === k)?.title ?? k),
      )
      .join(', ');
  switch (o.kind) {
    case 'deposit':
      return `${amount(o.amount)} ${describeDate(plan, o.due)}`;
    case 'recurring': {
      const esc = o.escalator
        ? `, +${pct(o.escalator.bps)} every ${o.escalator.everyMonths} months`
        : '';
      const cycles = o.cycles ? ` for ${o.cycles} periods` : '';
      return `${m(o.amount)} ${PER[o.interval]}${cycles}${esc}`;
    }
    case 'usage': {
      const cap = o.cap === null ? '' : `, capped at ${o.cap} billable`;
      const above =
        o.included > 0
          ? ` above ${count(o.included, o.unit)} ${PER[o.period]}`
          : `, billed ${EVERY[o.period]}`;
      return `${m(o.rate)} per ${o.unit.replaceAll('_', ' ')}${above}${cap}`;
    }
    case 'prepaid': {
      const over =
        o.overageRate === null
          ? ''
          : `, then ${m(o.overageRate)} per ${o.unit.replaceAll('_', ' ')}`;
      return `${count(o.units, o.unit)} prepaid for ${m(o.price)}${over}`;
    }
    case 'milestone':
      return `${amount(o.amount)} ${describeDate(plan, o.due)}, net ${o.netDays}`;
    case 'late_fee':
      return `${pct(o.rateBps)} per ${o.per === 'day' ? 'day' : 'month or part'} on ${names(o.appliesTo)}${o.graceDays ? ` after ${o.graceDays} days' grace` : ''}`;
    case 'revenue_share': {
      const recoup = o.recoup ? ` after recouping ${m(o.recoup)}` : '';
      const of = o.of.length ? ` of payments for ${names(o.of)}` : ` of ${o.basis}`;
      return `${pct(o.bps)}${of}, paid ${EVERY[o.period]}${recoup}`;
    }
    case 'split':
      return `${pct(o.bps)} of each payment for ${names(o.of)}`;
    case 'retainage':
      return `${pct(o.bps)} of ${names(o.of)} held, released ${describeDate(plan, o.release)}`;
    case 'service_credit':
      return `${pct(o.bps)} of ${names([o.of])} credited when ${o.condition}`;
  }
}
