'use client';

import type { AgreementDetail, ClauseView } from '@clausework/core';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Skeleton, Spinner } from '../ui';
import { ObligationCard } from './obligation-card';
import { ObligationReview } from './obligation-review';

interface Segment {
  /** Where the run starts in the source; unique, so it keys the run. */
  start: number;
  text: string;
  clause: ClauseView | null;
}

/** Splits the source into plain runs and clause runs. Overlapping spans keep the earlier clause. */
function segments(source: string, clauses: ClauseView[]): Segment[] {
  const located = clauses
    .filter((c): c is ClauseView & { span: { start: number; end: number } } => c.span !== null)
    .sort((a, b) => a.span.start - b.span.start);
  const out: Segment[] = [];
  let at = 0;
  for (const c of located) {
    if (c.span.start < at) continue;
    if (c.span.start > at)
      out.push({ start: at, text: source.slice(at, c.span.start), clause: null });
    out.push({ start: c.span.start, text: source.slice(c.span.start, c.span.end), clause: c });
    at = c.span.end;
  }
  if (at < source.length) out.push({ start: at, text: source.slice(at), clause: null });
  return out;
}

export function ContractView({
  detail,
  onChange,
}: {
  detail: AgreementDetail;
  onChange: (d: AgreementDetail) => void;
}) {
  const { agreement, version, progress } = detail;
  const clauses = version?.plan.clauses ?? progress?.clauses ?? [];
  const [activeClause, setActiveClause] = useState<string | null>(null);
  const [activeObligation, setActiveObligation] = useState<string | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);

  // Clauses that appeared since the last render animate in; earlier ones stay still.
  const seen = useRef(new Set<string>());
  const arriving = useMemo(() => {
    const fresh = new Set<string>();
    for (const c of clauses) if (!seen.current.has(c.id)) fresh.add(c.id);
    return fresh;
  }, [clauses]);
  useEffect(() => {
    for (const c of clauses) seen.current.add(c.id);
  }, [clauses]);

  const segs = useMemo(
    () => segments(agreement.sourceText, clauses),
    [agreement.sourceText, clauses],
  );
  const unlocated = clauses.filter((c) => c.span === null);

  const focusClause = (cid: string) => {
    setActiveClause(cid);
    const el = docRef.current?.querySelector<HTMLElement>(`[data-clause="${CSS.escape(cid)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const focusFromDocument = (cid: string) => {
    setActiveClause(cid);
    const o = version?.plan.obligations.find((x) => x.clauseIds.includes(cid));
    if (o) {
      setActiveObligation(o.key);
      cardsRef.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(`ob-${o.key}`)}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const compiling = detail.agreement.stage === 'reading' || detail.agreement.stage === 'compiling';

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="sheet flex max-h-[calc(100vh-15rem)] min-h-[520px] flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-rule-2 px-5 py-2.5 text-[12.5px] text-ink-2">
          <span className="truncate">{agreement.sourceName}</span>
          <span className="num shrink-0">
            {clauses.length} money clause{clauses.length === 1 ? '' : 's'} found
            {unlocated.length > 0 && (
              <span className="ml-2 text-amber">{unlocated.length} not found in text</span>
            )}
          </span>
        </div>
        <div ref={docRef} className="flex-1 overflow-auto px-10 py-8">
          <div className="serif mx-auto max-w-[66ch] text-[16.5px] leading-[1.72] whitespace-pre-wrap text-ink">
            {segs.map((s) =>
              s.clause ? (
                <ClauseRun
                  key={s.clause.id}
                  clause={s.clause}
                  active={activeClause === s.clause.id}
                  arriving={arriving.has(s.clause.id)}
                  onPick={focusFromDocument}
                >
                  {s.text}
                </ClauseRun>
              ) : (
                <Fragment key={s.start}>{s.text}</Fragment>
              ),
            )}
          </div>
        </div>
      </div>

      <div
        ref={cardsRef}
        className="max-h-[calc(100vh-15rem)] min-h-[520px] space-y-3 overflow-auto pr-1"
      >
        {!version ? (
          <CompilingPanel
            step={progress?.step ?? null}
            clauses={clauses}
            compiling={compiling}
            failure={agreement.failure}
          />
        ) : (
          <>
            {version.issues.length > 0 && (
              <div className="rounded-lg border border-amber/30 bg-amber-soft px-4 py-3 text-[13px] text-amber">
                <div className="mb-1 font-semibold">
                  The plan has {version.issues.length} issue{version.issues.length === 1 ? '' : 's'}{' '}
                  to resolve
                </div>
                <ul className="list-disc space-y-0.5 pl-4">
                  {version.issues.map((i) => (
                    <li key={`${i.code}:${i.subject}:${i.message}`}>{i.message}</li>
                  ))}
                </ul>
              </div>
            )}
            <TestSummary detail={detail} />
            {version.plan.obligations.map((o) => (
              <ObligationCard
                key={o.key}
                id={`ob-${o.key}`}
                obligation={o}
                version={version}
                active={activeObligation === o.key}
                activeClause={activeClause}
                ended={agreement.stage === 'completed'}
                review={<ObligationReview detail={detail} obligation={o} onChange={onChange} />}
                onClause={(cid) => {
                  setActiveObligation(o.key);
                  focusClause(cid);
                }}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function TestSummary({ detail }: { detail: AgreementDetail }) {
  const v = detail.version;
  if (!v) return null;
  const pass = v.tests.filter((t) => t.pass).length;
  const all = v.tests.length;
  return (
    <div className="flex items-center justify-between rounded-lg border border-rule bg-[#faf9f6] px-4 py-3 text-[13px]">
      <span className="text-ink-2">
        <span className="serif text-[16px] text-ink">{v.plan.obligations.length} obligations</span>{' '}
        compiled from {v.plan.clauses.length} clauses
      </span>
      <span className={pass === all ? 'font-medium text-seal' : 'font-medium text-red'}>
        <span className="num">
          {pass} of {all}
        </span>{' '}
        generated tests pass
      </span>
    </div>
  );
}

function CompilingPanel({
  step,
  clauses,
  compiling,
  failure,
}: {
  step: string | null;
  clauses: ClauseView[];
  compiling: boolean;
  failure: string | null;
}) {
  if (!compiling) {
    return (
      <div className="rounded-lg border border-red/30 bg-red-soft px-5 py-4 text-[13.5px] text-red">
        <div className="font-semibold">The plan could not be compiled</div>
        <p className="mt-1">{failure ?? 'Recompile to try again.'}</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="sheet flex items-center gap-3 px-4 py-3.5">
        <Spinner className="size-4 text-seal" />
        <div>
          <div className="text-[13.5px] font-medium text-ink">
            {step ?? 'Reading the agreement'}
          </div>
          <div className="text-[12.5px] text-ink-3">
            {clauses.length === 0
              ? 'Finding parties, dates, phases and every clause that moves money.'
              : `${clauses.length} clauses found and checked against the document. Compiling obligations and writing tests.`}
          </div>
        </div>
      </div>
      {clauses.map((c) => (
        <div key={c.id} className="rise rounded-[10px] border border-rule bg-sheet px-4 py-3">
          <div className="flex items-center justify-between text-[12px]">
            <span className="font-medium text-ink-2">{c.ref}</span>
            {c.span === null ? (
              <span className="text-amber">Quote not found</span>
            ) : (
              <span className="text-seal">Found in document</span>
            )}
          </div>
          <p className="serif mt-1 line-clamp-2 text-[14px] text-ink">{c.quote}</p>
        </div>
      ))}
      {clauses.length === 0 && [0, 1, 2].map((i) => <Skeleton key={i} className="h-[74px]" />)}
    </div>
  );
}

function ClauseRun({
  clause,
  active,
  arriving,
  onPick,
  children,
}: {
  clause: ClauseView;
  active: boolean;
  arriving: boolean;
  onPick: (clauseId: string) => void;
  children: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an inline run of document text must stay a span so it wraps with the text.
    <span
      role="button"
      tabIndex={0}
      data-clause={clause.id}
      data-active={active}
      data-arriving={arriving}
      className="clause-mark"
      title={clause.ref}
      onClick={() => onPick(clause.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick(clause.id);
        }
      }}
    >
      {children}
    </span>
  );
}
