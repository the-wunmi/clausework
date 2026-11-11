import { z } from 'zod';
import { Currency, MinorAmount } from './money.ts';

/**
 * The money-plan language. A contract compiles into one `Plan`: who the parties are, which clauses
 * carry money, the delivery phases, the obligations and the tests that prove them.
 *
 * Every schema is built from an amount type, so the same shape serves three readers: the model
 * (decimal strings in major units, which JSON can carry), the compiler (which converts those to
 * minor units) and the rest of the system (bigint minor units).
 */

export const Key = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, 'lower_snake_case key');
export const IsoDate = z.iso.date();

/** Basis points: 150 = 1.5%. */
export const Bps = z.int().min(0).max(1_000_000);

export const ClauseKind = z.enum([
  'payment_terms',
  'deposit',
  'recurring_fee',
  'escalation',
  'usage',
  'prepaid',
  'milestone',
  'late_payment',
  'revenue_share',
  'split',
  'retainage',
  'service_credit',
  'term',
  'termination',
  'delivery',
  'other',
]);
export type ClauseKind = z.infer<typeof ClauseKind>;

export const Interval = z.enum(['week', 'month', 'quarter', 'year']);
export type Interval = z.infer<typeof Interval>;

/** A date stated outright, or relative to the effective date or to a delivery phase. */
export const DateRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('date'), date: IsoDate }),
  z.object({ kind: z.literal('effective'), offsetDays: z.int() }),
  z.object({ kind: z.literal('phase_start'), phase: Key, offsetDays: z.int() }),
  z.object({ kind: z.literal('phase_end'), phase: Key, offsetDays: z.int() }),
]);
export type DateRef = z.infer<typeof DateRef>;

export const Party = z.object({
  key: Key,
  /** What the contract calls them: client, agency, subcontractor, co-writer, referrer. */
  role: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  email: z.string().max(254).nullable(),
});
export type Party = z.infer<typeof Party>;

export const Clause = z.object({
  /** c1, c2, … in document order. */
  id: z.string().regex(/^c\d{1,4}$/),
  /** The section number and heading as printed, e.g. "§4.1 Monthly retainer". */
  ref: z.string().max(120),
  kind: ClauseKind,
  /** The clause's words exactly as they appear in the document. */
  quote: z.string().min(1).max(4000),
});
export type Clause = z.infer<typeof Clause>;

export const Phase = z.object({
  key: Key,
  name: z.string().min(1).max(120),
  start: IsoDate.nullable(),
  end: IsoDate.nullable(),
  dependsOn: z.array(Key),
  /** An obligation that must be paid before this phase may start, e.g. the deposit. */
  gatedBy: Key.nullable(),
  clauseIds: z.array(z.string()),
});
export type Phase = z.infer<typeof Phase>;

export const ObligationKind = z.enum([
  'deposit',
  'recurring',
  'usage',
  'prepaid',
  'milestone',
  'late_fee',
  'revenue_share',
  'split',
  'retainage',
  'service_credit',
]);
export type ObligationKind = z.infer<typeof ObligationKind>;

export function planSchemas<A extends z.ZodType>(Amount: A) {
  const AmountRule = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fixed'), amount: Amount }),
    /** A share of the contract value stated in the agreement. */
    z.object({ kind: z.literal('percent_of_contract'), bps: Bps }),
  ]);

  const base = {
    key: Key,
    title: z.string().min(1).max(120),
    clauseIds: z.array(z.string()).min(1),
    payer: Key,
    payee: Key,
    /** 0 to 1. Below 0.8 the obligation needs a person before approval. */
    confidence: z.number().min(0).max(1),
    /** Anything the clause leaves open. Never guessed: each one is shown to the parties. */
    ambiguities: z.array(z.string().max(400)),
  };

  const Obligation = z.discriminatedUnion('kind', [
    z.object({
      ...base,
      kind: z.literal('deposit'),
      amount: AmountRule,
      due: DateRef,
    }),
    z.object({
      ...base,
      kind: z.literal('recurring'),
      amount: Amount,
      interval: Interval,
      start: DateRef,
      /** Number of billing periods, or null to run until the agreement ends. */
      cycles: z.int().min(1).nullable(),
      escalator: z.object({ bps: Bps, everyMonths: z.int().min(1).max(120) }).nullable(),
    }),
    z.object({
      ...base,
      kind: z.literal('usage'),
      metric: Key,
      unit: z.string().min(1).max(30),
      /** Price per unit above the included quantity. */
      rate: Amount,
      included: z.number().min(0),
      period: Interval,
      /** Billable units per period are capped here; null for no cap. */
      cap: z.number().min(0).nullable(),
      /** Notify the payer when usage reaches this share of the included quantity. */
      alertAtBps: Bps.nullable(),
    }),
    z.object({
      ...base,
      kind: z.literal('prepaid'),
      metric: Key,
      unit: z.string().min(1).max(30),
      units: z.number().min(0),
      price: Amount,
      /** Price per unit once the block is used up; null if usage simply stops. */
      overageRate: Amount.nullable(),
    }),
    z.object({
      ...base,
      kind: z.literal('milestone'),
      amount: AmountRule,
      phase: Key.nullable(),
      due: DateRef,
      netDays: z.int().min(0).max(365),
    }),
    z.object({
      ...base,
      kind: z.literal('late_fee'),
      /** Obligation keys, or ["*"] for every invoice the payer owes. */
      appliesTo: z.array(z.string()).min(1),
      rateBps: Bps,
      per: z.enum(['month_or_part', 'day']),
      graceDays: z.int().min(0).max(365),
    }),
    z.object({
      ...base,
      kind: z.literal('revenue_share'),
      /**
       * The obligations whose collections count as receipts. Empty when receipts arrive outside
       * the plan (royalty income, sales) and are reported as they come in.
       */
      of: z.array(Key),
      bps: Bps,
      period: Interval,
      /** An advance recouped from the payee's share before anything is paid out. */
      recoup: Amount.nullable(),
      basis: z.string().min(1).max(200),
    }),
    z.object({
      ...base,
      kind: z.literal('split'),
      /** The obligations whose receipts are split as they arrive. */
      of: z.array(Key).min(1),
      bps: Bps,
    }),
    z.object({
      ...base,
      kind: z.literal('retainage'),
      of: z.array(Key).min(1),
      bps: Bps,
      release: DateRef,
    }),
    z.object({
      ...base,
      kind: z.literal('service_credit'),
      of: Key,
      bps: Bps,
      condition: z.string().min(1).max(400),
    }),
  ]);

  /**
   * What a test gives the evaluator. Each obligation kind reads only the fields it needs; see
   * `@clausework/billing` `evaluate` for the exact meaning of `expect` per kind.
   */
  const Given = z.object({
    periodIndex: z.int().min(0).nullable(),
    quantity: z.number().min(0).nullable(),
    invoiceAmount: Amount.nullable(),
    daysLate: z.int().min(0).nullable(),
    receipts: Amount.nullable(),
    priorReceipts: Amount.nullable(),
  });

  const TestCase = z.object({
    obligation: Key,
    name: z.string().min(1).max(200),
    given: Given,
    expect: Amount,
  });

  const Plan = z.object({
    title: z.string().min(1).max(200),
    currency: Currency,
    effectiveDate: IsoDate.nullable(),
    endDate: IsoDate.nullable(),
    contractValue: Amount.nullable(),
    parties: z.array(Party).min(2),
    clauses: z.array(Clause),
    phases: z.array(Phase),
    obligations: z.array(Obligation),
    tests: z.array(TestCase),
  });

  return { AmountRule, Obligation, Given, TestCase, Plan };
}

const minor = planSchemas(MinorAmount);
export const AmountRule = minor.AmountRule;
export type AmountRule = z.infer<typeof AmountRule>;
export const Obligation = minor.Obligation;
export type Obligation = z.infer<typeof Obligation>;
export type ObligationOf<K extends ObligationKind> = Extract<Obligation, { kind: K }>;
export const Given = minor.Given;
export type Given = z.infer<typeof Given>;
export const TestCase = minor.TestCase;
export type TestCase = z.infer<typeof TestCase>;
export const Plan = minor.Plan;
export type Plan = z.infer<typeof Plan>;

export const EMPTY_GIVEN: Given = {
  periodIndex: null,
  quantity: null,
  invoiceAmount: null,
  daysLate: null,
  receipts: null,
  priorReceipts: null,
};

/** The PayPal product each obligation kind runs on when the owner collects it. */
export const PAYPAL_PRODUCT: Record<ObligationKind, PayPalProduct> = {
  deposit: 'orders',
  recurring: 'subscriptions',
  usage: 'usage_billing',
  prepaid: 'invoicing',
  milestone: 'invoicing',
  late_fee: 'invoicing',
  revenue_share: 'payouts',
  split: 'payouts',
  retainage: 'invoicing',
  service_credit: 'refunds',
};

/**
 * Where an obligation's money runs, from the owner's side: what the owner collects runs on the
 * product for its kind, what the owner pays goes out as Payouts, and money between two other
 * parties is tracked but not moved.
 */
export function productFor(
  o: Pick<Obligation, 'kind' | 'payer' | 'payee'>,
  owner: string | null,
): PayPalProduct | null {
  if (owner === null || o.payee === owner) return PAYPAL_PRODUCT[o.kind];
  if (o.payer === owner) return o.kind === 'service_credit' ? 'refunds' : 'payouts';
  return null;
}

/** Below this the compiler was unsure; a person confirms the obligation before money moves. */
export const CONFIDENT = 0.8;
export type PayPalProduct =
  | 'orders'
  | 'subscriptions'
  | 'usage_billing'
  | 'invoicing'
  | 'payouts'
  | 'refunds';
