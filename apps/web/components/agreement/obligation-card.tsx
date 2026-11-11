'use client';

import type { ObligationView, VersionView } from '@clausework/core';
import { type ReactNode, useState } from 'react';
import { clauseRef, KIND_LABEL, money, PRODUCT_LABEL } from '@/lib/format';
import {
  clauseById,
  describeGiven,
  humanText,
  keyNames,
  obligationTerms,
  partyName,
  testsFor,
} from '@/lib/plan';
import { ConfidenceMeter } from '../ui';

export function ObligationCard({
  obligation: o,
  version,
  active,
  onClause,
  activeClause,
  id,
  review,
  ended = false,
}: {
  obligation: ObligationView;
  version: VersionView;
  active?: boolean;
  activeClause?: string | null;
  onClause?: (clauseId: string) => void;
  id?: string;
  /** Confirm and edit actions, shown on a line the owner has not yet confirmed. */
  review?: ReactNode;
  /** The agreement has ended: nothing is left to confirm, so uncertain lines are only noted. */
  ended?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const plan = version.plan;
  const clauses = clauseById(plan);
  const tests = testsFor(version.tests, o.key);
  const passing = tests.filter((t) => t.pass).length;
  const failing = tests.length - passing;
  const product = version.products[o.key];
  const unconfirmed = version.unconfirmed.includes(o.key);
  const lowConfidence = o.confidence < 0.8;
  const unlocated = o.clauseIds.filter((c) => clauses.get(c)?.span === null);
  const names = keyNames(plan);
  // One chip per reference as people read it: two clause records can carry the same "§2.2".
  const chips = new Map<string, string[]>();
  for (const cid of o.clauseIds) {
    const c = clauses.get(cid);
    const label = c?.ref ? clauseRef(c.ref) : 'Clause';
    chips.set(label, [...(chips.get(label) ?? []), cid]);
  }

  return (
    <article
      id={id}
      className={`rounded-[10px] border bg-sheet transition-[border-color,box-shadow] ${
        active ? 'border-seal shadow-[0_0_0_3px_var(--color-seal-soft)]' : 'border-rule'
      }`}
    >
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11.5px] font-medium text-ink-3">{KIND_LABEL[o.kind]}</div>
            <h3 className="serif text-[17px] leading-snug text-ink">{o.title}</h3>
          </div>
          {product ? (
            <span className="mt-0.5 shrink-0 rounded-md border border-paypal/20 bg-paypal-soft px-2 py-0.5 text-[11.5px] font-medium text-paypal-deep">
              {PRODUCT_LABEL[product]}
            </span>
          ) : (
            <span
              className="mt-0.5 shrink-0 rounded-md border border-rule bg-rule-2 px-2 py-0.5 text-[11.5px] font-medium text-ink-2"
              title="Clausework tracks this line; the money does not move through your PayPal account."
            >
              Tracked only
            </span>
          )}
        </div>
        {version.explanations[o.key] && (
          <p className="mt-1.5 text-[14px] text-ink">{version.explanations[o.key]}</p>
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-ink-2">
          <span>
            <span className="text-ink">{partyName(plan, o.payer)}</span>
            <span className="mx-1.5 text-ink-3">pays</span>
            <span className="text-ink">{partyName(plan, o.payee)}</span>
          </span>
          <ConfidenceMeter value={o.confidence} />
          {tests.length > 0 && (
            <span className={failing ? 'font-medium text-red' : 'text-seal'}>
              {failing
                ? `${failing} of ${tests.length} tests fail`
                : `${passing} of ${tests.length} tests pass`}
            </span>
          )}
        </div>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {[...chips].map(([label, ids]) => {
            const cid = ids[0] ?? '';
            const c = clauses.get(cid);
            const missing = c?.span === null;
            return (
              <button
                key={label}
                type="button"
                onClick={() => onClause?.(cid)}
                title={missing ? 'This quote was not found in the document' : c?.quote}
                className={`rounded px-1.5 py-0.5 text-[12px] transition-colors ${
                  activeClause && ids.includes(activeClause)
                    ? 'bg-marker-strong text-ink'
                    : missing
                      ? 'bg-amber-soft text-amber'
                      : 'bg-marker/70 text-ink hover:bg-marker-strong'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {(lowConfidence || o.ambiguities.length > 0 || unlocated.length > 0) && (
          <div className="mt-3 space-y-1.5">
            {unlocated.length > 0 && (
              <p className="rounded-md bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
                Quote not found in the document. A person should check this clause before approving.
              </p>
            )}
            {lowConfidence && (
              <p className="rounded-md bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
                {ended
                  ? 'The model was unsure of this line. Check it against its clause when auditing.'
                  : unconfirmed
                    ? review
                      ? 'Uncertain. Confirm this line as written or edit it before anyone can approve the plan.'
                      : 'Uncertain. The owner confirms or corrects this line before anyone approves the plan.'
                    : 'Low confidence. The owner confirmed this line as written.'}
              </p>
            )}
            {o.ambiguities.map((a) => (
              <p key={a} className="rounded-md bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
                {humanText(a, clauses, names)}
              </p>
            ))}
          </div>
        )}
        {unconfirmed && !ended && review}
      </div>

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between border-t border-rule-2 px-4 py-2 text-[12.5px] text-ink-2 hover:text-ink"
      >
        <span>{open ? 'Hide terms and tests' : 'Terms and tests'}</span>
        <span aria-hidden className={`transition-transform ${open ? 'rotate-180' : ''}`}>
          ▾
        </span>
      </button>
      {open && (
        <div className="space-y-4 border-t border-rule-2 px-4 py-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
            {obligationTerms(o, plan).map((t) => (
              <div key={t.label}>
                <dt className="text-[11.5px] text-ink-3">{t.label}</dt>
                <dd className="num text-[13px] text-ink">{t.value}</dd>
              </div>
            ))}
          </dl>
          {tests.length > 0 && (
            <div>
              <div className="mb-1.5 text-[12px] font-medium text-ink-2">
                Tests written from the clause, run against the plan
              </div>
              <ul className="divide-y divide-rule-2 rounded-md border border-rule-2">
                {tests.map((t) => (
                  <li
                    key={t.name}
                    className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-baseline gap-2 px-3 py-2 text-[12.5px]"
                  >
                    <span className={t.pass ? 'text-seal' : 'text-red'}>
                      <span aria-hidden>{t.pass ? '✓' : '✕'}</span>
                      <span className="sr-only">{t.pass ? 'Passes' : 'Fails'}</span>
                    </span>
                    <span className="min-w-0">
                      <span className="text-ink">{t.name}</span>
                      <span className="block text-ink-3">
                        {describeGiven(t.given, plan.currency)}
                      </span>
                      {t.error && <span className="block text-red">{t.error}</span>}
                    </span>
                    <span className="num text-right">
                      <span className="text-ink">{money(t.expect, plan.currency)}</span>
                      {!t.pass && t.actual !== null && (
                        <span className="block text-red">
                          plan gives {money(t.actual, plan.currency)}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
