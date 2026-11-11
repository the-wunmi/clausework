import {
  type DateRef,
  fromMajor,
  type Obligation,
  ObligationKind,
  planSchemas,
  type TestCase,
  toMajor,
} from '@clausework/core';
import { z } from 'zod';

export const Major = z
  .string()
  .describe('A decimal amount in major units with no symbol or separators, e.g. "3000.00"');

/**
 * What the model fills in for each obligation. Structured output allows few nullable or union
 * fields, so the kind-specific terms are a list of named values, each written as text. Code parses
 * every value and rebuilds the typed union, naming any term a kind needs but did not get.
 */
export const TermName = z.enum([
  'amount',
  'percent_of_contract_bps',
  'due',
  'start',
  'release',
  'interval',
  'cycles',
  'escalator_bps',
  'escalator_every_months',
  'metric',
  'unit',
  'rate',
  'included',
  'cap',
  'alert_at_bps',
  'units',
  'price',
  'overage_rate',
  'phase',
  'net_days',
  'applies_to',
  'of',
  'bps',
  'per',
  'grace_days',
  'recoup',
  'basis',
  'condition',
]);
export type TermName = z.infer<typeof TermName>;

export const FlatObligation = z.object({
  kind: ObligationKind,
  key: z.string().describe('lower_snake_case, unique'),
  title: z.string(),
  clauseIds: z.array(z.string()),
  payer: z.string(),
  payee: z.string(),
  confidence: z.number(),
  ambiguities: z.array(z.string()),
  terms: z.array(z.object({ name: TermName, value: z.string() })),
});
export type FlatObligation = z.infer<typeof FlatObligation>;

const GivenName = z.enum([
  'period_index',
  'quantity',
  'invoice_amount',
  'days_late',
  'receipts',
  'prior_receipts',
]);

export const FlatTest = z.object({
  obligation: z.string(),
  name: z.string(),
  given: z.array(z.object({ name: GivenName, value: z.string() })),
  expect: Major,
});
export type FlatTest = z.infer<typeof FlatTest>;

export const Compiled = z.object({
  obligations: z.array(FlatObligation),
  tests: z.array(FlatTest),
});
export type Compiled = z.infer<typeof Compiled>;

export const OBLIGATION_LANGUAGE = `Each obligation has a kind and a list of terms. Every term value is text. Kinds and their terms (required unless marked optional):
- deposit: a one-off amount due on signing or another date. amount OR percent_of_contract_bps; due.
- recurring: a fee every interval from start. amount (per period); interval; start; optional cycles (number of periods, omit if open-ended); optional escalator_bps and escalator_every_months (the fee rises by escalator_bps every N months, compounded and rounded to the minor unit each step).
- usage: metered work or consumption, billed per period. metric; unit; rate (price per unit above the included units); included (units per period, 0 if none); interval (the period); optional cap (maximum billable units per period); optional alert_at_bps (notify the payer at that share of the included units, 8000 = 80%).
- prepaid: a block of units bought up front. metric; unit; units; price; optional overage_rate (per unit once used up).
- milestone: an amount invoiced when a phase is delivered or on a date. amount OR percent_of_contract_bps; due (usually phase_end of its phase); optional phase; net_days (payment window after the invoice).
- late_fee: a fee on late invoices. bps (the rate); per (month_or_part or day); optional grace_days after the due date; optional applies_to (comma-separated obligation keys; omit for all invoices).
- revenue_share: the payee receives bps of receipts each period after any advance is recouped from their share. bps; interval (the period); optional of (comma-separated obligation keys whose payments count as receipts; omit when receipts come from outside the agreement, such as royalty income); optional recoup (the advance); basis (what receipts count, in words).
- split: when the payer receives money for the obligations in "of", the payee gets bps of each receipt (a subcontractor or platform share). of (comma-separated obligation keys); bps.
- retainage: bps held back from payments for the obligations in "of", released on release. of; bps; release.
- service_credit: a credit of bps of an invoice for "of" when condition is met (e.g. an SLA miss). of (one obligation key); bps; condition.

Value formats:
- Amounts are decimal strings in major units with no symbol or separators: "3000.00". An amount never has more decimals than the currency (two for USD), so price usage in the unit the agreement uses: "0.40" per "1,000 API calls", never "0.0004" per call; quantities are then counted in that unit.
- Percentages are basis points as whole numbers: 3% = "300", 1.5% = "150".
- Dates (due, start, release): "2027-01-04" only for a date printed in the agreement; otherwise "effective+0" (days after the effective date), "phase_start:design+0" or "phase_end:design+0" (days after a phase starts or ends).
- interval is one of week, month, quarter, year. Counts and units are plain numbers ("20", "1.5").

Rules:
- payer and payee are party keys. A split or royalty is paid by whoever receives the money first.
- Use the phase keys and clause ids you are given. Every obligation cites the clauses it comes from.
- If a clause leaves something open ("reasonable expenses", "fees to be agreed"), do not invent a number. Either leave the obligation out and say so in an ambiguity on a related obligation, or keep it with confidence below 0.8 and the gap stated in ambiguities.
- Ambiguities are read by the parties themselves, including in their own portal. Write each one as a plain sentence about the agreement: name parties by name and obligations by their title, and quote the contract where it helps. Never mention keys, kinds, terms, field names or how the plan encodes something (no snake_case, no "encoded as", "the reader", "tagged").
- confidence is your honest probability that the obligation is exactly what the clause requires.

Tests: write 2 to 4 tests per obligation from the clause's own wording, computing the expected amount yourself, independently of how you encoded the obligation. Cover the plain case and the edges the clause names (the threshold, the anniversary, the grace period, the recoupment). given lists only the inputs the kind reads:
- deposit, milestone: none; expect is the amount due.
- recurring: period_index (0 = first period); expect is that period's fee.
- usage: quantity used in one period; expect is the charge.
- prepaid: no quantity for the block price, or the quantity used for the overage charge.
- late_fee: invoice_amount and days_late after the due date; expect is the fee.
- revenue_share: receipts this period and prior_receipts in earlier periods; expect is this period's payout.
- split: receipts; expect is the payee's share.
- retainage: invoice_amount; expect is the amount held back.
- service_credit: invoice_amount; expect is the credit.`;

/** "Support Hours" → "support_hours": a metric name is an identifier, however the model wrote it. */
const slug = (v: string | null): string | null =>
  v === null
    ? null
    : v
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/^(\d)/, 'm_$1') || null;

/** `Number` alone reads "" as 0 and "0x10" as 16, so a blank or odd value would pass as a number. */
const toNumber = (v: string): number => {
  const plain = v.replace(/[,\s]/g, '');
  return /^-?(\d+\.?\d*|\.\d+)$/.test(plain) ? Number(plain) : Number.NaN;
};

const DATE_REF =
  /^(effective|phase_start:([a-z][a-z0-9_]*)|phase_end:([a-z][a-z0-9_]*))\s*([+-]\s*\d+)?$/;

/** Reads the obligation's terms into the typed shape, noting every missing or unreadable term. */
export function toObligation(o: FlatObligation, problems: string[]): unknown {
  const terms = new Map<TermName, string>();
  for (const t of o.terms) terms.set(t.name, t.value.trim());
  const where = `obligation ${o.key} (${o.kind})`;
  const bad = (name: string, value: string, want: string) => {
    problems.push(`${where}: term ${name} "${value}" is not ${want}`);
    return null;
  };

  const text = (name: TermName, required = true): string | null => {
    const v = terms.get(name);
    if (v === undefined || v === '') {
      if (required) problems.push(`${where} needs term ${name}`);
      return null;
    }
    return v;
  };
  const num = (name: TermName, required = true): number | null => {
    const v = text(name, required);
    if (v === null) return null;
    // "3%" read as a number would be 3 basis points, a hundredth of what the clause says.
    if (v.includes('%')) return bad(name, v, 'basis points or a count without "%" (3% = "300")');
    const n = toNumber(v);
    return Number.isFinite(n) ? n : bad(name, v, 'a number');
  };
  const int = (name: TermName, required = true): number | null => {
    const n = num(name, required);
    if (n === null) return null;
    return Number.isInteger(n) ? n : bad(name, String(n), 'a whole number');
  };
  const list = (name: TermName, required = true): string[] | null => {
    const v = text(name, required);
    return v === null
      ? null
      : v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
  };
  const date = (name: TermName): unknown => {
    const v = text(name);
    if (v === null) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { kind: 'date', date: v };
    const m = DATE_REF.exec(v);
    if (!m) return bad(name, v, 'a date such as "effective+0" or "phase_end:design+0"');
    const offsetDays = m[4] ? Number(m[4].replace(/\s/g, '')) : 0;
    if (m[1] === 'effective') return { kind: 'effective', offsetDays };
    if (m[2]) return { kind: 'phase_start', phase: m[2], offsetDays };
    return { kind: 'phase_end', phase: m[3], offsetDays };
  };
  const amountRule = () => {
    const pct = int('percent_of_contract_bps', false);
    if (pct !== null) return { kind: 'percent_of_contract', bps: pct };
    return { kind: 'fixed', amount: text('amount') };
  };

  const base = {
    kind: o.kind,
    key: o.key,
    title: o.title,
    clauseIds: o.clauseIds,
    payer: o.payer,
    payee: o.payee,
    confidence: o.confidence,
    ambiguities: o.ambiguities,
  };
  switch (o.kind) {
    case 'deposit':
      return { ...base, amount: amountRule(), due: date('due') };
    case 'recurring': {
      const escalatorBps = int('escalator_bps', false);
      return {
        ...base,
        amount: text('amount'),
        interval: text('interval'),
        start: date('start'),
        cycles: int('cycles', false),
        escalator:
          escalatorBps !== null && escalatorBps > 0
            ? { bps: escalatorBps, everyMonths: int('escalator_every_months') }
            : null,
      };
    }
    case 'usage':
      return {
        ...base,
        metric: slug(text('metric')),
        unit: text('unit'),
        rate: text('rate'),
        included: num('included', false) ?? 0,
        period: text('interval'),
        cap: num('cap', false),
        alertAtBps: int('alert_at_bps', false),
      };
    case 'prepaid':
      return {
        ...base,
        metric: slug(text('metric')),
        unit: text('unit'),
        units: num('units'),
        price: text('price'),
        overageRate: text('overage_rate', false),
      };
    case 'milestone':
      return {
        ...base,
        amount: amountRule(),
        phase: text('phase', false),
        due: date('due'),
        netDays: int('net_days', false) ?? 0,
      };
    case 'late_fee':
      return {
        ...base,
        appliesTo: list('applies_to', false) ?? ['*'],
        rateBps: int('bps'),
        per: text('per', false) ?? 'month_or_part',
        graceDays: int('grace_days', false) ?? 0,
      };
    case 'revenue_share':
      return {
        ...base,
        of: list('of', false) ?? [],
        bps: int('bps'),
        period: text('interval'),
        recoup: text('recoup', false),
        basis: text('basis', false) ?? 'receipts',
      };
    case 'split':
      return { ...base, of: list('of'), bps: int('bps') };
    case 'retainage':
      return { ...base, of: list('of'), bps: int('bps'), release: date('release') };
    case 'service_credit':
      return {
        ...base,
        of: list('of')?.[0] ?? null,
        bps: int('bps'),
        condition: text('condition'),
      };
  }
}

const GIVEN_KEYS = {
  period_index: 'periodIndex',
  days_late: 'daysLate',
  quantity: 'quantity',
} as const;

export function toTest(t: FlatTest, problems: string[]): unknown {
  const given: Record<string, number | string | null> = {
    periodIndex: null,
    quantity: null,
    invoiceAmount: null,
    daysLate: null,
    receipts: null,
    priorReceipts: null,
  };
  for (const { name, value } of t.given) {
    const v = value.trim();
    switch (name) {
      case 'period_index':
      case 'days_late':
      case 'quantity': {
        const n = toNumber(v);
        if (!Number.isFinite(n)) {
          problems.push(`test "${t.name}": ${name} "${value}" is not a number`);
          continue;
        }
        given[GIVEN_KEYS[name]] = n;
        break;
      }
      case 'invoice_amount':
        given.invoiceAmount = v;
        break;
      case 'receipts':
        given.receipts = v;
        break;
      case 'prior_receipts':
        given.priorReceipts = v;
        break;
    }
  }
  return { obligation: t.obligation, name: t.name, given, expect: t.expect };
}

/** Schemas that read decimal major-unit strings into bigint minor units of one currency. */
export function minorSchemas(currency: string) {
  const ToMinor = z.string().transform((v, ctx) => {
    try {
      return fromMajor(v.replace(/[,\s$€£]/g, ''), currency);
    } catch {
      ctx.addIssue({ code: 'custom', message: `"${v}" is not a ${currency} amount` });
      return z.NEVER;
    }
  });
  return planSchemas(ToMinor);
}

/** One flat obligation, typed and in minor units, or the reasons it could not be. */
export function readObligation(
  flat: FlatObligation,
  currency: string,
): { obligation: Obligation | null; problems: string[] } {
  const problems: string[] = [];
  const shaped = toObligation(flat, problems);
  const parsed = minorSchemas(currency).Obligation.safeParse(shaped);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      problems.push(`obligation ${flat.key}, ${i.path.join('.')}: ${i.message}`);
    }
  }
  return {
    obligation: parsed.success && problems.length === 0 ? (parsed.data as Obligation) : null,
    problems,
  };
}

export function readTest(
  flat: FlatTest,
  currency: string,
): { test: TestCase | null; problems: string[] } {
  const problems: string[] = [];
  const parsed = minorSchemas(currency).TestCase.safeParse(toTest(flat, problems));
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      problems.push(`test "${flat.name}", ${i.path.join('.')}: ${i.message}`);
    }
  }
  return {
    test: parsed.success && problems.length === 0 ? (parsed.data as TestCase) : null,
    problems,
  };
}

const dateTerm = (d: DateRef): string => {
  if (d.kind === 'date') return d.date;
  const off =
    d.offsetDays === 0 ? '+0' : d.offsetDays > 0 ? `+${d.offsetDays}` : String(d.offsetDays);
  return d.kind === 'effective' ? `effective${off}` : `${d.kind}:${d.phase}${off}`;
};

/** An obligation back in the term language, so a model can be shown it and change only some terms. */
export function toFlat(o: Obligation, currency: string): FlatObligation {
  const terms: { name: TermName; value: string }[] = [];
  const put = (name: TermName, value: string | number | bigint | null | undefined) => {
    if (value === null || value === undefined) return;
    terms.push({
      name,
      value: typeof value === 'bigint' ? toMajor(value, currency) : String(value),
    });
  };
  const rule = (r: Extract<Obligation, { kind: 'deposit' }>['amount']) =>
    r.kind === 'fixed' ? put('amount', r.amount) : put('percent_of_contract_bps', r.bps);
  switch (o.kind) {
    case 'deposit':
      rule(o.amount);
      put('due', dateTerm(o.due));
      break;
    case 'recurring':
      put('amount', o.amount);
      put('interval', o.interval);
      put('start', dateTerm(o.start));
      put('cycles', o.cycles);
      put('escalator_bps', o.escalator?.bps);
      put('escalator_every_months', o.escalator?.everyMonths);
      break;
    case 'usage':
      put('metric', o.metric);
      put('unit', o.unit);
      put('rate', o.rate);
      put('included', o.included);
      put('interval', o.period);
      put('cap', o.cap);
      put('alert_at_bps', o.alertAtBps);
      break;
    case 'prepaid':
      put('metric', o.metric);
      put('unit', o.unit);
      put('units', o.units);
      put('price', o.price);
      put('overage_rate', o.overageRate);
      break;
    case 'milestone':
      rule(o.amount);
      put('due', dateTerm(o.due));
      put('phase', o.phase);
      put('net_days', o.netDays);
      break;
    case 'late_fee':
      put('bps', o.rateBps);
      put('per', o.per);
      put('grace_days', o.graceDays);
      if (!o.appliesTo.includes('*')) put('applies_to', o.appliesTo.join(', '));
      break;
    case 'revenue_share':
      put('bps', o.bps);
      put('interval', o.period);
      if (o.of.length) put('of', o.of.join(', '));
      put('recoup', o.recoup);
      put('basis', o.basis);
      break;
    case 'split':
      put('of', o.of.join(', '));
      put('bps', o.bps);
      break;
    case 'retainage':
      put('of', o.of.join(', '));
      put('bps', o.bps);
      put('release', dateTerm(o.release));
      break;
    case 'service_credit':
      put('of', o.of);
      put('bps', o.bps);
      put('condition', o.condition);
      break;
  }
  return {
    kind: o.kind,
    key: o.key,
    title: o.title,
    clauseIds: o.clauseIds,
    payer: o.payer,
    payee: o.payee,
    confidence: o.confidence,
    ambiguities: o.ambiguities,
    terms,
  };
}

/** A changed obligation: the old terms, with only the terms the change names replaced. */
export function mergeTerms(before: FlatObligation, change: FlatObligation): FlatObligation {
  const named = new Set(change.terms.map((t) => t.name));
  return { ...change, terms: [...before.terms.filter((t) => !named.has(t.name)), ...change.terms] };
}
