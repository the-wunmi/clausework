'use client';

import type { ChargeTraceView, DecisionView } from '@clausework/core';
import type { ICellRendererParams } from 'ag-grid-community';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { clauseRef, day, money } from '@/lib/format';
import { describeGiven } from '@/lib/plan';
import { Spinner } from '../ui';
import type { Row } from './charges-grid';

const MOVED: Record<string, string> = {
  collected: 'Collected',
  paid_out: 'Paid out',
  refunded: 'Refunded',
  credited: 'Credited',
  held: 'Held back',
  released: 'Released',
  reversal: 'Reversed',
};

const OUTCOME: Record<DecisionView['outcome']['status'], string> = {
  executed: 'Done',
  rejected: 'Refused by the plan check',
  escalated: 'Sent to you',
  no_action: 'No action needed',
};

/**
 * A charge's detail row: the clause it comes from, the tests that prove its amount, and what
 * happened to it, fetched when the row is opened.
 */
export function ChargeTrace({ data: row, node, api: grid }: ICellRendererParams<Row>) {
  const [trace, setTrace] = useState<ChargeTraceView | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!row) return;
    let live = true;
    api.chargeTrace(row.agreementId, row.id).then(
      (t) => live && setTrace(t),
      (e: Error) => live && setFailed(e.message),
    );
    return () => {
      live = false;
    };
  }, [row]);
  // The trace arrives after the row opens, and its length varies: the row follows its content.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      if (node.rowHeight === el.offsetHeight) return;
      node.setRowHeight(el.offsetHeight);
      grid.onRowHeightChanged();
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [node, grid]);

  // Grid rows never wrap; a trace is prose and must.
  return (
    <div ref={box} className="whitespace-normal break-words">
      {row && <Body row={row} trace={trace} failed={failed} />}
    </div>
  );
}

function Body({
  row,
  trace,
  failed,
}: {
  row: Row;
  trace: ChargeTraceView | null;
  failed: string | null;
}) {
  if (failed) return <p className="px-6 py-4 text-[13px] text-red">{failed}</p>;
  if (!trace) {
    return (
      <p className="flex items-center gap-2 px-6 py-4 text-[13px] text-ink-3">
        <Spinner className="size-3.5" /> Tracing the charge to its clause…
      </p>
    );
  }
  const currency = row.currency;
  return (
    <div className="grid grid-cols-3 gap-5 bg-paper px-6 py-4 text-[13px] leading-snug">
      <section className="min-w-0">
        <h4 className="label mb-2">Where it comes from</h4>
        {trace.clauses.length === 0 && <p className="text-ink-3">No clause recorded.</p>}
        {trace.clauses.map((c) => (
          <figure key={c.id} className="mb-2.5">
            <blockquote className="serif border-l-2 border-seal/40 pl-3 text-[14px] text-ink">
              “{c.quote}”
            </blockquote>
            <figcaption className="mt-1 pl-3 text-[12px] text-ink-3">
              {clauseRef(c.ref)}, plan version {trace.version}
              {!c.found && (
                <span className="ml-1.5 text-amber">· not found word for word in the contract</span>
              )}
            </figcaption>
          </figure>
        ))}
      </section>

      <section className="min-w-0">
        <h4 className="label mb-2">How the amount is proved</h4>
        {trace.obligation && <p className="text-ink">{trace.obligation.explanation}</p>}
        {row.basis && <p className="mt-1 text-ink-2">This charge: {row.basis}</p>}
        {trace.tests.length > 0 && (
          <ul className="mt-2.5 divide-y divide-rule-2 rounded-md border border-rule-2 bg-sheet">
            {trace.tests.map((t) => (
              <li key={t.name} className="flex items-baseline gap-2 px-2.5 py-1.5 text-[12.5px]">
                <span className={t.pass ? 'text-seal' : 'text-red'}>
                  <span aria-hidden>{t.pass ? '✓' : '✕'}</span>
                  <span className="sr-only">{t.pass ? 'Passes' : 'Fails'}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-ink">{t.name}</span>
                  <span className="block text-ink-3">{describeGiven(t.given, currency)}</span>
                </span>
                <span className="num text-ink">{money(t.expect, currency)}</span>
              </li>
            ))}
          </ul>
        )}
        {trace.tests.length > 0 && (
          <p className="mt-1.5 text-[12px] text-ink-3">
            Tests written from the clause wording, run by code against the plan.
          </p>
        )}
      </section>

      <section className="min-w-0">
        <h4 className="label mb-2">What happened</h4>
        {trace.decisions.map((d) => (
          <div
            key={d.id}
            className="mb-2.5 rounded-md border border-seal/25 bg-seal-soft px-2.5 py-2"
          >
            <p className="text-[12px] text-ink-3">
              Schedule agent, {day(d.occurredOn)} · {OUTCOME[d.outcome.status]}
            </p>
            <p className="text-ink">{d.proposal.rationale || d.trigger.summary}</p>
          </div>
        ))}
        {trace.movements.length > 0 && (
          <ul className="mb-2.5 space-y-1">
            {trace.movements.map((m) => (
              <li key={`${m.kind}:${m.paypalRef}:${m.occurredOn}`} className="flex gap-2">
                <span className="num text-ink">{money(m.amount, m.currency)}</span>
                <span className="text-ink-2">
                  {MOVED[m.kind] ?? m.kind} {day(m.occurredOn)}
                  {m.paypalRef && <span className="num text-ink-3"> · {m.paypalRef}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        <ol className="space-y-1.5 border-l border-rule pl-3">
          {trace.events.map((e) => (
            <li key={e.id} className="text-[12.5px] text-ink-2">
              <span className="num text-ink-3">{day(e.occurredOn, true)}</span> {e.summary}
            </li>
          ))}
          {trace.events.length === 0 && (
            <li className="text-[12.5px] text-ink-3">
              Nothing yet: it falls due {day(row.dueDate)}.
            </li>
          )}
        </ol>
      </section>
    </div>
  );
}
