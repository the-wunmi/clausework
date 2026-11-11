import type { ChargeStatus, Minor, ObligationKind, PayPalProduct, Stage } from '@clausework/core';

/**
 * Minor-unit digits, as in @clausework/core's money.ts. Kept here because core's entry point also
 * carries server code (node:crypto) that must not be bundled into the browser.
 */
const DIGITS: Record<string, number> = { JPY: 0, KRW: 0, VND: 0, BHD: 3, KWD: 3 };

export const minorDigits = (currency: string): number => DIGITS[currency] ?? 2;
const formatters = new Map<string, Intl.NumberFormat>();

function formatter(currency: string, compact: boolean): Intl.NumberFormat {
  const key = `${currency}:${compact}`;
  let f = formatters.get(key);
  if (!f) {
    const digits = DIGITS[currency] ?? 2;
    f = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: compact ? 0 : digits,
      maximumFractionDigits: compact ? 0 : digits,
    });
    formatters.set(key, f);
  }
  return f;
}

/**
 * Formats a string of minor units for display. The digits are split as text, so no amount ever
 * passes through floating point on its way to the screen.
 */
export function money(minor: Minor | null | undefined, currency = 'USD', compact = false): string {
  if (minor === null || minor === undefined || minor === '') return '—';
  const digits = DIGITS[currency] ?? 2;
  const negative = minor.startsWith('-');
  const abs = (negative ? minor.slice(1) : minor).padStart(digits + 1, '0');
  const whole = digits === 0 ? abs : abs.slice(0, -digits);
  const frac = digits === 0 ? '' : abs.slice(-digits);
  // Intl formats a decimal string exactly; no float round trip for large amounts.
  const decimal = `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}` as `${number}`;
  return formatter(currency, compact).format(decimal);
}

/** Major units as a number, for charts only: chart libraries plot numbers, never money math. */
export function chartAmount(minor: Minor, currency: string): number {
  return Number(minor) / 10 ** (DIGITS[currency] ?? 2);
}

/** Adds minor-unit strings exactly. */
export function sumMinor(values: (Minor | null | undefined)[]): Minor {
  let total = 0n;
  for (const v of values) if (v) total += BigInt(v);
  return total.toString();
}

const DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const DAY_SHORT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const STAMP = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function day(iso: string | null | undefined, short = false): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return (short ? DAY_SHORT : DAY).format(d);
}

export function stamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : STAMP.format(d);
}

/** Today's date in UTC, for pages that have no server clock to ask. */
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

export function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const bps = (v: unknown) =>
  typeof v === 'number'
    ? `${(v / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
    : '—';

export const STAGE_LABEL: Record<Stage, string> = {
  reading: 'Reading',
  compiling: 'Compiling',
  failed: 'Could not compile',
  needs_owner: 'Choose your side',
  needs_review: 'Needs review',
  awaiting_approvals: 'Awaiting approvals',
  ready_to_activate: 'Ready to go live',
  awaiting_payer_setup: 'Waiting on PayPal setup',
  live: 'Live',
  completed: 'Ended',
};

/** Running on PayPal, even while an amendment waits for approval. */
export function isLive(a: { activatedAt: string | null; stage: Stage }): boolean {
  return a.activatedAt !== null && a.stage !== 'completed';
}

/** The stage as people read it, with what the stage alone does not say. */
export function stageOf(
  a: { stage: Stage; activatedAt: string | null },
  extra: { unconfirmed?: number; pendingVersion?: number | null } = {},
): { label: string; tone: Tone } {
  if (
    a.activatedAt &&
    a.stage !== 'completed' &&
    a.stage !== 'live' &&
    a.stage !== 'awaiting_payer_setup'
  ) {
    const v = extra.pendingVersion ? `v${extra.pendingVersion} ` : 'amendment ';
    return { label: `Live, ${v}awaiting approval`, tone: 'seal' };
  }
  if (a.stage === 'needs_review' && extra.unconfirmed) {
    const n = extra.unconfirmed;
    return { label: `Confirm ${n} uncertain term${n === 1 ? '' : 's'}`, tone: 'amber' };
  }
  return { label: STAGE_LABEL[a.stage], tone: STAGE_TONE[a.stage] };
}

export type Tone = 'ink' | 'seal' | 'amber' | 'red' | 'paypal' | 'muted';

const STAGE_TONE: Record<Stage, Tone> = {
  reading: 'muted',
  compiling: 'muted',
  failed: 'red',
  needs_owner: 'amber',
  needs_review: 'amber',
  awaiting_approvals: 'ink',
  ready_to_activate: 'seal',
  awaiting_payer_setup: 'paypal',
  live: 'seal',
  completed: 'muted',
};

export const STATUS_LABEL: Record<ChargeStatus, string> = {
  scheduled: 'Scheduled',
  awaiting_approval: 'Awaiting payer',
  issued: 'Issued',
  authorized: 'Authorized',
  paid: 'Paid',
  overdue: 'Overdue',
  failed: 'Failed',
  cancelled: 'Cancelled',
  held: 'Held back',
  released: 'Released',
  refunded: 'Refunded',
  unclaimed: 'Unclaimed',
};

const STATUS_TONE: Record<ChargeStatus, Tone> = {
  scheduled: 'muted',
  awaiting_approval: 'paypal',
  issued: 'ink',
  authorized: 'paypal',
  paid: 'seal',
  overdue: 'red',
  failed: 'red',
  cancelled: 'muted',
  held: 'amber',
  released: 'seal',
  refunded: 'amber',
  unclaimed: 'amber',
};

export const PRODUCT_LABEL: Record<PayPalProduct, string> = {
  orders: 'Orders',
  subscriptions: 'Subscriptions',
  usage_billing: 'Usage-Based Billing',
  invoicing: 'Invoicing',
  payouts: 'Payouts',
  refunds: 'Refunds',
};

/** The PayPal product a line runs on; a line with none is tracked by Clausework only. */
export const productLabel = (product: PayPalProduct | null | undefined): string =>
  product ? PRODUCT_LABEL[product] : 'Tracked only';

export const KIND_LABEL: Record<ObligationKind, string> = {
  deposit: 'Deposit',
  recurring: 'Recurring fee',
  usage: 'Usage',
  prepaid: 'Prepaid block',
  milestone: 'Milestone',
  late_fee: 'Late fee',
  revenue_share: 'Revenue share',
  split: 'Split',
  retainage: 'Retainage',
  service_credit: 'Service credit',
};

export function humanize(key: string): string {
  const s = key.replaceAll('_', ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A clause reference as people read it. PDF text layers often keep headings in capitals
 * ("3. PROJECT FEES 3.1 Project fees"); those are set in title case.
 */
export function clauseRef(ref: string): string {
  if (!/[A-Z]{3,}/.test(ref)) return ref;
  return ref.replace(
    /\b([A-Z])([A-Z]+)\b/g,
    (_m, a: string, rest: string) => a + rest.toLowerCase(),
  );
}

/** Clause references for a list of ids or refs, each shown once. */
export function uniqueRefs(refs: string[]): string[] {
  return [...new Set(refs.map(clauseRef))];
}

/**
 * A charge label without the repeats the engine's joins can leave: "Kinetic share of Design System
 * milestone · Design System milestone" reads as "Kinetic share of Design System milestone".
 */
export function tidyLabel(label: string): string {
  const kept: string[] = [];
  for (const part of label.split(' · ')) {
    const p = part.trim();
    if (p && !kept.some((k) => k.toLowerCase().includes(p.toLowerCase()))) kept.push(p);
  }
  return kept.join(' · ');
}

/** Statuses after which PayPal has nothing left to move, so an old refusal no longer matters. */
const SETTLED = new Set<ChargeStatus>(['paid', 'released', 'cancelled', 'refunded']);

/** True when PayPal refused to move this money and it is still owed. */
export function refused(c: { status: ChargeStatus; problem?: string | null }): boolean {
  return Boolean(c.problem) && !SETTLED.has(c.status);
}

/** Statuses of money that is asked for but has not moved yet. */
const AWAITING_PAYMENT = new Set<ChargeStatus>([
  'issued',
  'overdue',
  'authorized',
  'awaiting_approval',
]);

export const isAwaitingPayment = (c: { status: ChargeStatus }): boolean =>
  AWAITING_PAYMENT.has(c.status);

/** Late, failed, unclaimed or refused by PayPal: money that may not arrive when the plan says. */
export function atRisk(c: { status: ChargeStatus; problem?: string | null }): boolean {
  return refused(c) || c.status === 'overdue' || c.status === 'failed' || c.status === 'unclaimed';
}

/** The status a person reads: a refusal by PayPal outranks the stored status, which is still owed. */
export function chargeStatus(c: { status: ChargeStatus; problem?: string | null }): {
  label: string;
  tone: Tone;
  /** PayPal's reason, for a tooltip. */
  reason: string | null;
} {
  if (refused(c)) return { label: 'PayPal refused', tone: 'red', reason: c.problem ?? null };
  return { label: STATUS_LABEL[c.status], tone: STATUS_TONE[c.status], reason: null };
}

/**
 * "of $14,400.00; $1,440.00 retainage held" for a charge with retainage withheld. `amount` is what
 * is asked for or paid; `grossAmount` is the charge before the holdback.
 */
export function retainageNote(c: {
  amount: Minor | null;
  grossAmount?: Minor | null;
  currency: string;
}): string | null {
  if (!c.grossAmount || c.amount === null || c.grossAmount === c.amount) return null;
  const held = (BigInt(c.grossAmount) - BigInt(c.amount)).toString();
  return `of ${money(c.grossAmount, c.currency)}; ${money(held, c.currency)} retainage held`;
}
