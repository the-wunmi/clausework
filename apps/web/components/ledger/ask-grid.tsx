'use client';

import type { LedgerAnswer, LedgerRow } from '@clausework/core';
import type { GridApi } from 'ag-grid-community';
import type { AgGridReact } from 'ag-grid-react';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { ChargesGrid, type Row } from '../grid/charges-grid';
import { Spinner } from '../ui';

const EXAMPLES = [
  'Overdue charges by agreement',
  'Payouts to subcontractors this quarter',
  'Largest unpaid invoices first',
];

/** Applies the model's answer through the grid's own API: filter model, then column state. */
function applyAnswer(grid: GridApi<Row>, answer: LedgerAnswer) {
  grid.setFilterModel(answer.grid.filter ?? null);
  const visible = answer.grid.columns ? new Set(answer.grid.columns) : null;
  const sortIndex = new Map(answer.grid.sort.map((s, i) => [s.colId, i]));
  grid.applyColumnState({
    state: (grid.getColumns() ?? []).map((col) => {
      const colId = col.getColId();
      const sort = answer.grid.sort.find((s) => s.colId === colId);
      const group = answer.grid.groupBy.indexOf(colId);
      return {
        colId,
        sort: sort?.sort ?? null,
        sortIndex: sortIndex.get(colId) ?? null,
        rowGroup: group >= 0,
        rowGroupIndex: group >= 0 ? group : null,
        // A grouped column already shows in the group column; showing it twice adds nothing.
        hide: group >= 0 ? true : visible ? !visible.has(colId) : undefined,
      };
    }),
  });
}

export function AskGrid({ rows }: { rows: LedgerRow[] }) {
  const gridRef = useRef<AgGridReact<Row>>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = async (q: string) => {
    const grid = gridRef.current?.api;
    if (!grid || !q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const a = await api.askLedger(q);
      applyAnswer(grid, a);
      setAnswer(a.answer);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <input
          className="field h-10 flex-1 text-[14px]"
          placeholder="Ask the ledger, for example: which clients owe escalator increases this quarter?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          aria-label="Ask the ledger"
        />
        <button type="submit" className="btn btn-primary h-10" disabled={busy || !question.trim()}>
          {busy && <Spinner className="size-3.5" />}
          Ask
        </button>
        <button
          type="button"
          className="btn btn-quiet h-10"
          onClick={() => {
            const grid = gridRef.current?.api;
            if (!grid) return;
            grid.setFilterModel(null);
            grid.resetColumnState();
            setAnswer(null);
          }}
        >
          Reset view
        </button>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        Try
        {EXAMPLES.map((e) => (
          <button
            key={e}
            type="button"
            className="rounded-full border border-rule bg-sheet px-2.5 py-0.5 text-ink-2 hover:border-ink-3 hover:text-ink"
            onClick={() => {
              setQuestion(e);
              void ask(e);
            }}
          >
            {e}
          </button>
        ))}
      </div>
      {answer && (
        <p className="serif rise rounded-lg bg-seal-soft px-4 py-3 text-[15px] text-seal-deep">
          {answer}
        </p>
      )}
      {error && <p className="rounded-lg bg-red-soft px-4 py-3 text-[13px] text-red">{error}</p>}
      <ChargesGrid rows={rows} portfolio gridRef={gridRef} height={600} />
    </div>
  );
}
