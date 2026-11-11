import type { ClauseView, ObligationView, PartyView, PlanView, TestView } from '@clausework/core';
import { bps, clauseRef, day, humanize, money } from './format';

/** Fields every obligation has; the rest are its kind's terms. */
const BASE = new Set([
  'kind',
  'key',
  'title',
  'clauseIds',
  'payer',
  'payee',
  'confidence',
  'ambiguities',
]);
/** Terms held as minor units of the plan's currency. */
export const AMOUNT_FIELDS = new Set(['rate', 'price', 'overageRate', 'recoup']);
/** Terms held as basis points, shown and edited as percentages. */
export const BPS_FIELDS = new Set(['bps', 'rateBps', 'alertAtBps']);

const LABEL: Record<string, string> = {
  amount: 'Amount',
  due: 'Due',
  start: 'Starts',
  release: 'Released',
  interval: 'Every',
  period: 'Period',
  cycles: 'Payments',
  escalator: 'Escalator',
  metric: 'Metric',
  unit: 'Unit',
  rate: 'Rate per unit',
  included: 'Included per period',
  cap: 'Billable cap',
  alertAtBps: 'Alert at',
  units: 'Units in block',
  price: 'Block price',
  overageRate: 'Overage per unit',
  phase: 'Phase',
  netDays: 'Payment terms',
  appliesTo: 'Applies to',
  of: 'Of',
  bps: 'Share',
  rateBps: 'Rate',
  per: 'Charged per',
  graceDays: 'Grace period',
  recoup: 'Advance recouped first',
  basis: 'Basis',
  condition: 'Condition',
};

function dateRef(v: unknown, plan: PlanView): string {
  if (!v || typeof v !== 'object') return '—';
  const r = v as { kind: string; date?: string; phase?: string; offsetDays?: number };
  const off = r.offsetDays ?? 0;
  const tail = off === 0 ? '' : off > 0 ? ` + ${off} days` : ` − ${-off} days`;
  const phaseName = (k?: string) => plan.phases.find((p) => p.key === k)?.name ?? humanize(k ?? '');
  switch (r.kind) {
    case 'date':
      return r.date ?? '—';
    case 'effective':
      return off === 0 ? 'On the effective date' : `Effective date${tail}`;
    case 'phase_start':
      return `Start of ${phaseName(r.phase)}${tail}`;
    case 'phase_end':
      return `End of ${phaseName(r.phase)}${tail}`;
    default:
      return '—';
  }
}

function obligationTitle(plan: PlanView, key: string): string {
  if (key === '*') return 'every invoice';
  return plan.obligations.find((o) => o.key === key)?.title ?? humanize(key);
}

/** The label a person reads for an obligation's term. */
export function termLabel(field: string): string {
  return LABEL[field] ?? humanize(field);
}

/** One term of an obligation, formatted for people: money, percentages, dates, names. */
export function formatTerm(field: string, raw: unknown, plan: PlanView): string {
  const cur = plan.currency;
  if (raw === null || raw === undefined) return 'none';
  if (field === 'amount' && typeof raw === 'object') {
    const a = raw as { kind: string; amount?: string; bps?: number };
    return a.kind === 'fixed'
      ? money(a.amount ?? null, cur)
      : `${bps(a.bps)} of the contract value`;
  }
  if (field === 'amount' || AMOUNT_FIELDS.has(field)) return money(String(raw), cur);
  if (BPS_FIELDS.has(field)) return bps(raw);
  if (field === 'due' || field === 'start' || field === 'release') return dateRef(raw, plan);
  if (field === 'escalator' && typeof raw === 'object') {
    const e = raw as { bps: number; everyMonths: number };
    return `+${bps(e.bps)} every ${e.everyMonths === 12 ? 'year' : `${e.everyMonths} months`}`;
  }
  if (field === 'netDays' || field === 'graceDays') return `${raw} days`;
  if (field === 'phase')
    return plan.phases.find((p) => p.key === raw)?.name ?? humanize(String(raw));
  if (Array.isArray(raw)) return raw.map((k) => obligationTitle(plan, String(k))).join(', ');
  if (field === 'of') return obligationTitle(plan, String(raw));
  if (field === 'per') return raw === 'day' ? 'Day late' : 'Month or part of a month';
  if (field === 'metric') return humanize(String(raw));
  return String(raw);
}

/** The kind-specific terms of an obligation as label/value rows. */
export function obligationTerms(
  o: ObligationView,
  plan: PlanView,
): { label: string; value: string }[] {
  return Object.entries(o)
    .filter(([field, raw]) => !BASE.has(field) && raw !== null && raw !== undefined)
    .map(([field, raw]) => ({ label: termLabel(field), value: formatTerm(field, raw, plan) }));
}

export function partyName(plan: PlanView, key: string): string {
  return plan.parties.find((p) => p.key === key)?.name ?? humanize(key);
}

/** True when the party's latest approval is of the version now shown. */
export function hasApproved(p: { approval: PartyView['approval'] }): boolean {
  return p.approval?.current === true && p.approval.decision === 'approved';
}

export function clauseById(plan: PlanView): Map<string, ClauseView> {
  return new Map(plan.clauses.map((c) => [c.id, c]));
}

export function testsFor(tests: TestView[], key: string): TestView[] {
  return tests.filter((t) => t.obligation === key);
}

const GIVEN_LABEL: Record<string, string> = {
  periodIndex: 'period',
  quantity: 'quantity',
  invoiceAmount: 'invoice',
  daysLate: 'days late',
  receipts: 'receipts',
  priorReceipts: 'earlier receipts',
};

/** "quantity 26, invoice $12,000.00" from a test's inputs. */
export function describeGiven(given: TestView['given'], currency: string): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(given)) {
    if (v === null || v === undefined) continue;
    const label = GIVEN_LABEL[k] ?? humanize(k);
    if (k === 'invoiceAmount' || k === 'receipts' || k === 'priorReceipts') {
      parts.push(`${label} ${money(String(v), currency)}`);
    } else if (k === 'periodIndex') {
      parts.push(`period ${Number(v) + 1}`);
    } else {
      parts.push(`${label} ${v}`);
    }
  }
  return parts.length ? parts.join(', ') : 'no inputs';
}

/**
 * Display names for a plan's internal keys: obligations by title, parties and phases by name. Model
 * text sometimes names a line by its key ("handled on writer_a_royalty"); people never should see one.
 */
export function keyNames(plan: PlanView | null | undefined): Map<string, string> {
  const names = new Map<string, string>();
  if (!plan) return names;
  for (const p of plan.parties) names.set(p.key, p.name);
  for (const p of plan.phases) names.set(p.key, p.name);
  for (const o of plan.obligations) names.set(o.key, o.title);
  return names;
}

/**
 * Drops a phrase repeated across a " · " join: "share of Design System milestone · Design System
 * milestone for Kinetic" reads as "share of Design System milestone for Kinetic".
 */
function dropRepeats(text: string): string {
  const parts = text.split(' · ');
  let out = parts[0] ?? '';
  for (const part of parts.slice(1)) {
    const words = part.split(' ');
    let cut = 0;
    for (let n = words.length; n > 0; n--) {
      const phrase = words.slice(0, n).join(' ');
      if (phrase.length >= 4 && out.toLowerCase().endsWith(phrase.toLowerCase())) {
        cut = n;
        break;
      }
    }
    if (cut === 0) out += ` · ${part}`;
    else if (cut < words.length) out += ` ${words.slice(cut).join(' ')}`;
  }
  return out;
}

/**
 * Agent and activity text, made readable: clause ids become their references, ISO dates become
 * dates, the "action_name: " prefixes the engine writes are dropped, and internal keys become the
 * names people know (`names`, from `keyNames`).
 */
export function humanText(
  text: string,
  clauses?: Map<string, { ref: string }>,
  names?: Map<string, string>,
): string {
  return dropRepeats(
    text
      .replace(/\b[a-z]+(?:_[a-z]+)+: /g, '')
      .replace(/\bc(\d{1,4})\b/g, (m) =>
        clauses?.get(m) ? clauseRef(clauses.get(m)?.ref ?? m) : 'the clause',
      )
      .replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (k) => names?.get(k) ?? k.replaceAll('_', ' '))
      .replace(/\b(\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z?)?\b/g, (_m, d: string) => day(d)),
  );
}

/**
 * The agent's actions as a heading: "Capture the deposit", without a "No action needed" tacked on
 * when something was done.
 */
export function actionTitle(action: string): string {
  const parts = [...new Set(action.split(', ').map((a) => a.trim()))].filter(Boolean);
  const done = parts.filter((a) => a !== 'No action needed');
  return (done.length > 0 ? done : parts).join(' and ') || 'No action needed';
}
