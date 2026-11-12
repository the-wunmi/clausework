import { formatMoney } from '@clausework/billing';
import type { LedgerAnswer, LedgerRow } from '@clausework/core';
import { DomainError, fromMajor, LedgerQuestion, parseInput } from '@clausework/core';
import { type Engine, today } from './context.ts';
import { ledgerRows } from './views.ts';

/**
 * "What's at risk this month?" The analyst turns a question into grid state; the grid applies it.
 * The answer's figures are totalled here from the rows the filters keep, never by the model.
 */
export async function askLedger(engine: Engine, input: LedgerQuestion): Promise<LedgerAnswer> {
  const { question: q } = parseInput(LedgerQuestion, input);
  if (!engine.agents) throw new DomainError('unavailable', 'No model is configured');
  const on = await today(engine.db);
  const query = await engine.agents.analyst.ask(q, on);
  const rows = (await ledgerRows(engine)).filter((r) => query.filters.every((f) => keeps(r, f)));
  const byCurrency = new Map<string, bigint>();
  for (const r of rows) {
    if (r.amount !== null)
      byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0n) + BigInt(r.amount));
  }
  const totals = [...byCurrency].map(([c, v]) => formatMoney(v, c));
  const figures = `${rows.length} charge${rows.length === 1 ? '' : 's'}${totals.length ? `, ${totals.join(' + ')}` : ''}.`;

  const filter: Record<string, unknown> = {};
  for (const f of query.filters) filter[f.column] = toAgFilter(f);
  return {
    answer: `${query.answer} ${figures}`,
    grid: {
      filter: Object.keys(filter).length ? filter : null,
      sort: query.sort.map((s) => ({ colId: s.column, sort: s.direction })),
      groupBy: query.groupBy,
      columns: query.columns.length ? query.columns : null,
    },
  };
}

type Filter = { column: string; op: string; values: string[] };

const NUMERIC = new Set(['amount', 'daysOverdue']);
const DATES = new Set(['dueDate', 'paidOn']);

/** The same filter as AG Grid will apply, so the totals match what the person sees. */
function keeps(row: LedgerRow, f: Filter): boolean {
  const raw = (row as unknown as Record<string, unknown>)[f.column];
  const value = Array.isArray(raw) ? raw.join(', ') : raw;
  const first = f.values[0] ?? '';
  if (value === null || value === undefined) return false;
  if (f.column === 'amount') {
    // Minor units both sides, in the row's own currency: no floats near money.
    const n = BigInt(value as string);
    const target = fromMajor(first || '0', row.currency);
    if (f.op === 'greaterThan') return n > target;
    if (f.op === 'lessThan') return n < target;
    return n === target;
  }
  if (NUMERIC.has(f.column)) {
    const n = Number(value);
    const target = Number(first);
    if (f.op === 'greaterThan') return n > target;
    if (f.op === 'lessThan') return n < target;
    return n === target;
  }
  const s = String(value);
  switch (f.op) {
    case 'in':
      return f.values.includes(s);
    case 'contains':
      return s.toLowerCase().includes(first.toLowerCase());
    case 'before':
      return s < first;
    case 'after':
      return s > first;
    case 'greaterThan':
      return s > first;
    case 'lessThan':
      return s < first;
    default:
      return s === first;
  }
}

/** AG Grid filter model for one column. */
function toAgFilter(f: Filter): Record<string, unknown> {
  if (DATES.has(f.column)) {
    const type =
      f.op === 'before' || f.op === 'lessThan'
        ? 'lessThan'
        : f.op === 'after' || f.op === 'greaterThan'
          ? 'greaterThan'
          : 'equals';
    return { filterType: 'date', type, dateFrom: f.values[0] ?? null };
  }
  if (NUMERIC.has(f.column)) {
    const type =
      f.op === 'greaterThan' ? 'greaterThan' : f.op === 'lessThan' ? 'lessThan' : 'equals';
    return { filterType: 'number', type, filter: Number(f.values[0] ?? 0) };
  }
  if (f.op === 'in' || f.op === 'equals') return { filterType: 'set', values: f.values };
  return { filterType: 'text', type: 'contains', filter: f.values[0] ?? '' };
}
