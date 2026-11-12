import {
  type AuditReport,
  addDays,
  type Match,
  owedVersusPaid,
  projectCharges,
  type Transaction,
} from '@clausework/billing';
import {
  AuditInput,
  DomainError,
  dayIn,
  fromMajor,
  type Plan,
  parseInput,
  startOfDay,
  toMajor,
} from '@clausework/core';
import { audits } from '@clausework/db';
import { desc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { type Engine, runDirectly, type Step, today, workspaceTimeZone } from './context.ts';
import { termsOf } from './operations.ts';
import { activeVersion, currentPhaseDates, isUuid, loadAgreement } from './repo.ts';
import { findSample, sampleFile } from './samples.ts';
import { enqueueAudit } from './workflows.ts';

/**
 * Audit mode: a contract plus its PayPal history. Code projects what should have moved, the model
 * matches each payment to a charge, and code computes every difference, in both directions.
 */

/** PayPal's Transaction Search covers at most 31 days per request. */
const SEARCH_WINDOW_DAYS = 31;

export async function createAudit(engine: Engine, input: AuditInput): Promise<{ id: string }> {
  const a = parseInput(AuditInput, input);
  const agreement = await loadAgreement(engine.db, a.agreementId);
  const version = await activeVersion(engine.db, agreement);
  if (!version) throw new DomainError('conflict', 'Compile the agreement before auditing it');
  const perspective = a.perspective ?? agreement.ownerParty;
  if (!perspective || !version.plan.parties.some((p) => p.key === perspective)) {
    throw new DomainError('invalid', 'Choose which party you are first');
  }
  const { transactions, sourceName } =
    a.history.kind === 'paypal'
      ? await paypalHistory(engine, version.plan, perspective, a.history)
      : readHistoryFile(a.history, version.plan, perspective);
  if (transactions.length === 0)
    throw new DomainError('invalid', `No ${version.plan.currency} payments found in the history`);
  const [row] = await engine.db
    .insert(audits)
    .values({
      agreementId: agreement.id,
      status: 'matching',
      perspective,
      sourceName,
      transactions,
    })
    .returning({ id: audits.id });
  const id = (row as { id: string }).id;
  await enqueueAudit(id, agreement.id);
  return { id };
}

type History = z.output<typeof AuditInput>['history'];

/** Payments from PayPal's own records, in the plan's currency, as the perspective party saw them. */
async function paypalHistory(
  engine: Engine,
  plan: Plan,
  perspective: string,
  range: Extract<History, { kind: 'paypal' }>,
): Promise<{ transactions: Transaction[]; sourceName: string }> {
  const caps = await engine.gateway.capabilities();
  if (!caps.transactionSearch)
    throw new DomainError('unavailable', 'Transaction Search is not enabled for this PayPal app');
  const zone = await workspaceTimeZone(engine.db);
  const found = [];
  for (let from = range.from; from <= range.to; from = addDays(from, SEARCH_WINDOW_DAYS)) {
    const windowEnd = addDays(from, SEARCH_WINDOW_DAYS - 1);
    // ISO dates order as text, so the earlier of the two is the first when sorted.
    const to = [windowEnd, range.to].sort()[0] as string;
    found.push(
      ...(await engine.gateway.searchTransactions(
        startOfDay(from, zone),
        startOfDay(addDays(to, 1), zone),
      )),
    );
  }
  const transactions = found
    .filter((t) => t.amount.currency === plan.currency)
    .map((t) => {
      const incoming = t.amount.amount >= 0n;
      const other = partyFor(plan, t.counterpartyEmail, t.counterpartyName);
      return {
        id: t.id,
        date: dayIn(new Date(t.at), zone),
        amount: incoming ? t.amount.amount : -t.amount.amount,
        payer: incoming ? other : perspective,
        payee: incoming ? perspective : other,
        memo: [t.note, t.invoiceId].filter(Boolean).join(' · '),
      };
    });
  return { transactions, sourceName: `PayPal Transaction Search ${range.from} to ${range.to}` };
}

/** Payments from an uploaded activity CSV or a bundled sample one. */
function readHistoryFile(
  history: Exclude<History, { kind: 'paypal' }>,
  plan: Plan,
  perspective: string,
): { transactions: Transaction[]; sourceName: string } {
  if (history.kind === 'csv') {
    return {
      transactions: parseActivityCsv(history.text, plan, perspective),
      sourceName: history.name,
    };
  }
  const sample = findSample(history.key);
  if (sample?.kind !== 'history') throw new DomainError('not_found', 'No such sample');
  const file = sampleFile(sample);
  if (file.kind !== 'text') throw new DomainError('invalid', 'Sample history is not text');
  return { transactions: parseActivityCsv(file.text, plan, perspective), sourceName: file.name };
}

/** Matches the history to the plan. The model's match is a step, so a recovered run reuses it. */
export async function runAudit(
  engine: Engine,
  auditId: string,
  step: Step = runDirectly,
): Promise<void> {
  const [audit] = await engine.db.select().from(audits).where(eq(audits.id, auditId));
  if (audit?.status !== 'matching' || !audit.agreementId) return;
  const agreement = await loadAgreement(engine.db, audit.agreementId);
  const version = await activeVersion(engine.db, agreement);
  if (!version) return;
  const plan = version.plan;
  const transactions = (
    audit.transactions as (Omit<Transaction, 'amount'> & { amount: string })[]
  ).map((t) => ({
    ...t,
    amount: BigInt(t.amount),
  }));
  const lastDay =
    transactions
      .map((t) => t.date)
      .sort()
      .at(-1) ?? '0000';
  const until = [lastDay, await today(engine.db), plan.endDate ?? '9999'].sort()[0] as string;
  const expected = projectCharges(plan, {
    phases: await currentPhaseDates(engine.db, agreement.id, plan),
    until,
  }).filter((c) => c.amount !== null && c.dueDate !== null && c.dueDate <= until);

  if (!engine.agents) {
    await engine.db
      .update(audits)
      .set({ status: 'failed', failure: 'No model is configured to match payments' })
      .where(eq(audits.id, auditId));
    return;
  }
  const agents = engine.agents;
  const out = await step('match', () =>
    agents.matcher.match({
      agreement: { title: plan.title, currency: plan.currency, endDate: plan.endDate },
      // So a stranger's payment with a matching amount and memo is not taken as a party's.
      parties: plan.parties.map((p) => ({ key: p.key, name: p.name, email: p.email })),
      obligations: termsOf(plan),
      charges: expected.map((c) => ({
        id: c.id,
        obligationKey: c.obligationKey,
        label: c.label,
        dueDate: c.dueDate,
        amount: toMajor(c.amount ?? 0n, plan.currency),
      })),
      transactions: transactions.map((t) => ({
        id: t.id,
        date: t.date,
        amount: toMajor(t.amount, plan.currency),
        counterparty: t.payer === audit.perspective ? t.payee : t.payer,
        memo: t.memo,
      })),
    }),
  );
  const known = new Set(expected.map((c) => c.id));
  const keys = new Set(plan.obligations.map((o) => o.key));
  const matches: Match[] = out.matches.map((m) => ({
    transactionId: m.transactionId,
    chargeId: m.chargeId && known.has(m.chargeId) ? m.chargeId : null,
    obligationKey: m.obligationKey && keys.has(m.obligationKey) ? m.obligationKey : null,
    reason: m.reason,
  }));
  const report: AuditReport = owedVersusPaid(
    plan,
    audit.perspective,
    expected,
    transactions,
    matches,
  );
  await engine.db
    .update(audits)
    .set({ status: 'done', matches, report })
    .where(eq(audits.id, auditId));
}

export async function listAudits(engine: Engine) {
  return engine.db.select().from(audits).orderBy(desc(audits.createdAt));
}

export async function loadAudit(engine: Engine, id: string) {
  const [row] = isUuid(id) ? await engine.db.select().from(audits).where(eq(audits.id, id)) : [];
  if (!row) throw new DomainError('not_found', 'No such audit');
  return row;
}

function partyFor(plan: Plan, email: string | null, name: string | null): string | null {
  const e = email?.toLowerCase();
  const byEmail = e ? plan.parties.find((p) => p.email?.toLowerCase() === e) : undefined;
  if (byEmail) return byEmail.key;
  const n = name?.toLowerCase();
  return n
    ? (plan.parties.find(
        (p) => n.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(n),
      )?.key ?? null)
    : null;
}

/** Reads PayPal's activity download (CSV). Money in has a positive Gross, money out negative. */
export function parseActivityCsv(text: string, plan: Plan, perspective: string): Transaction[] {
  const rows = parseCsv(text);
  const header = rows.shift()?.map((h) => h.trim().toLowerCase()) ?? [];
  const col = (name: string) => header.indexOf(name);
  const need = ['date', 'gross', 'currency', 'transaction id'];
  for (const n of need) {
    if (col(n) < 0)
      throw new DomainError(
        'invalid',
        `The CSV has no "${n}" column; use PayPal's activity download`,
      );
  }
  const at = (row: string[], name: string) => (col(name) >= 0 ? (row[col(name)] ?? '').trim() : '');
  const out: Transaction[] = [];
  for (const row of rows) {
    if (row.length < header.length / 2) continue;
    if (at(row, 'currency') !== plan.currency) continue;
    const status = at(row, 'status').toLowerCase();
    if (status && !['completed', 'paid'].includes(status)) continue;
    const gross = fromMajor(at(row, 'gross').replace(/[,\s$]/g, ''), plan.currency);
    if (gross === 0n) continue;
    const counterparty = partyFor(
      plan,
      at(row, gross > 0n ? 'from email address' : 'to email address') || null,
      at(row, 'name') || null,
    );
    out.push({
      id: at(row, 'transaction id'),
      date: toIso(at(row, 'date')),
      amount: gross < 0n ? -gross : gross,
      payer: gross > 0n ? counterparty : perspective,
      payee: gross > 0n ? perspective : counterparty,
      memo: [at(row, 'item title'), at(row, 'invoice number'), at(row, 'note'), at(row, 'type')]
        .filter(Boolean)
        .join(' · '),
    });
  }
  return out;
}

function toIso(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(d);
  if (!m) throw new DomainError('invalid', `Unreadable date "${d}"`);
  return `${m[3]}-${(m[1] as string).padStart(2, '0')}-${(m[2] as string).padStart(2, '0')}`;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}
