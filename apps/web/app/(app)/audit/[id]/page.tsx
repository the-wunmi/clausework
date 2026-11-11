'use client';

import type { AuditLeakView } from '@clausework/core';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorNote, Money, Pill, Skeleton, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { day, humanize, type Tone, uniqueRefs } from '@/lib/format';
import { humanText, keyNames } from '@/lib/plan';
import { useResource } from '@/lib/use-resource';

const KIND: Record<AuditLeakView['kind'], { label: string; tone: Tone }> = {
  unbilled: { label: 'Never billed', tone: 'amber' },
  underbilled: { label: 'Underbilled', tone: 'amber' },
  overbilled: { label: 'Overbilled', tone: 'red' },
  escalator_misapplied: { label: 'Wrong escalation', tone: 'red' },
  duplicate: { label: 'Paid twice', tone: 'red' },
  after_termination: { label: 'After the agreement ended', tone: 'red' },
  unexplained: { label: 'No clause explains it', tone: 'muted' },
};

/** "platform_fee:3" reads as "Monthly platform fee, period 4", by the obligation's title. */
function chargeName(id: string, names: Map<string, string>): string {
  const m = /^(.*):(\d+)$/.exec(id);
  const key = m?.[1] ?? id;
  const name = names.get(key) ?? humanize(key);
  return m ? `${name}, period ${Number(m[2]) + 1}` : name;
}

export default function AuditReportPage() {
  const { id } = useParams<{ id: string }>();
  const res = useResource(
    () => api.audit(id),
    [id],
    (d) => (d?.status === 'matching' ? 2000 : null),
    id,
  );
  const a = res.data;
  // The agreement's plan names the lines the matcher refers to by key.
  const agreementId = a?.agreementId ?? null;
  const agreement = useResource(
    agreementId ? () => api.agreement(agreementId) : null,
    [agreementId],
    undefined,
    agreementId,
  );
  const names = keyNames(agreement.data?.version?.plan);

  if (res.error && !a) {
    return (
      <ErrorNote
        message={
          res.error.status === 404 ? 'There is no audit at this address.' : res.error.message
        }
        onRetry={res.error.status === 404 ? undefined : () => void res.reload()}
      />
    );
  }
  if (!a) return <Skeleton className="h-[480px]" />;

  const currency = a.currency ?? 'USD';
  const r = a.report;
  const counted = r?.leaks.filter((l) => l.kind !== 'unexplained') ?? [];
  const unexplained = r?.leaks.filter((l) => l.kind === 'unexplained') ?? [];

  return (
    <>
      <div className="mb-2 text-[13px]">
        <Link href="/audit" className="text-ink-2 hover:text-ink">
          All audits
        </Link>
      </div>
      <h1 className="serif text-[30px] leading-tight font-medium">{a.agreementTitle ?? 'Audit'}</h1>
      <p className="mt-1 text-[13.5px] text-ink-2">
        Checked against {a.sourceName}
        {a.agreementId && (
          <>
            {' '}
            for{' '}
            <Link href={`/agreements/${a.agreementId}`} className="text-seal hover:underline">
              the agreement
            </Link>
          </>
        )}
        .
      </p>

      {a.status === 'matching' && (
        <div className="sheet mt-8 flex items-center gap-3 px-5 py-4">
          <Spinner className="size-4 text-seal" />
          <div>
            <div className="font-medium text-ink">Matching payments to clauses</div>
            <div className="text-[13px] text-ink-2">
              The model reads each payment note and matches it to the charge it pays. The amounts
              are then compared by code.
            </div>
          </div>
        </div>
      )}
      {a.status === 'failed' && (
        <div className="mt-8">
          <ErrorNote message={a.failure ?? 'The audit failed.'} />
        </div>
      )}

      {r && (
        <>
          <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_1fr_1.2fr]">
            <div className="sheet px-6 py-5">
              <div className="text-[13px] text-ink-2">Owed to you</div>
              <div className="serif num mt-1 text-[40px] leading-none text-seal">
                <Money value={r.owedToYou} currency={currency} />
              </div>
              <div className="mt-2 text-[12.5px] text-ink-3">
                Unbilled or underbilled under the agreement
              </div>
            </div>
            <div className="sheet px-6 py-5">
              <div className="text-[13px] text-ink-2">You owe back</div>
              <div className="serif num mt-1 text-[40px] leading-none text-amber">
                <Money value={r.youOwe} currency={currency} />
              </div>
              <div className="mt-2 text-[12.5px] text-ink-3">
                Overcharged, duplicated or charged after the end date
              </div>
            </div>
            <dl className="sheet grid grid-cols-2 gap-x-4 gap-y-3 px-6 py-5 text-[13px]">
              <div>
                <dt className="text-ink-3">Expected under the plan</dt>
                <dd className="num text-ink">
                  <Money value={r.expectedTotal} currency={currency} />
                </dd>
              </div>
              <div>
                <dt className="text-ink-3">Moved through PayPal</dt>
                <dd className="num text-ink">
                  <Money value={r.actualTotal} currency={currency} />
                </dd>
              </div>
              <div>
                <dt className="text-ink-3">Charges checked</dt>
                <dd className="num text-ink">{r.chargesChecked}</dd>
              </div>
              <div>
                <dt className="text-ink-3">Payments read</dt>
                <dd className="num text-ink">{r.transactionsChecked}</dd>
              </div>
            </dl>
          </div>

          <h2 className="serif mt-10 mb-3 text-[19px] font-medium">What leaked</h2>
          {counted.length === 0 ? (
            <p className="text-ink-2">Every payment matches the agreement.</p>
          ) : (
            <LeakTable leaks={counted} currency={currency} />
          )}

          {unexplained.length > 0 && (
            <>
              <h2 className="serif mt-10 mb-1 text-[19px] font-medium">
                Payments no clause explains
              </h2>
              <p className="mb-3 text-[13px] text-ink-2">
                Not counted above. Check whether they belong to another agreement.
              </p>
              <LeakTable leaks={unexplained} currency={currency} />
            </>
          )}
        </>
      )}

      {a.transactions.length > 0 && (
        <>
          <h2 className="serif mt-10 mb-3 text-[19px] font-medium">Payments read</h2>
          <div className="sheet overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-rule-2 text-left text-[12px] text-ink-3">
                  <th className="px-4 py-2.5 font-normal">Date</th>
                  <th className="px-4 py-2.5 font-normal">Note on the payment</th>
                  <th className="px-4 py-2.5 text-right font-normal">Amount</th>
                  <th className="px-4 py-2.5 font-normal">Matched to</th>
                </tr>
              </thead>
              <tbody>
                {a.transactions.map((t) => (
                  <tr key={t.id} className="border-b border-rule-2 align-top last:border-0">
                    <td className="num px-4 py-2.5 whitespace-nowrap text-ink-2">{day(t.date)}</td>
                    <td className="px-4 py-2.5 text-ink">
                      {t.memo || <span className="text-ink-3">No note</span>}
                    </td>
                    <td className="num px-4 py-2.5 text-right text-ink">
                      <Money value={t.amount} currency={currency} />
                    </td>
                    <td className="px-4 py-2.5">
                      {!t.matchedTo && a.status === 'matching' ? (
                        <span className="text-ink-3">Matching…</span>
                      ) : t.matchedTo ? (
                        <span className="text-ink">{chargeName(t.matchedTo, names)}</span>
                      ) : (
                        <span className="text-amber">Unmatched</span>
                      )}
                      {t.reason && (
                        <span className="block text-[12px] text-ink-3">
                          {humanText(t.reason, undefined, names)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function LeakTable({ leaks, currency }: { leaks: AuditLeakView[]; currency: string }) {
  return (
    <div className="sheet overflow-hidden">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-rule-2 text-left text-[12px] text-ink-3">
            <th className="px-4 py-2.5 font-normal">Finding</th>
            <th className="px-4 py-2.5 text-right font-normal">Expected</th>
            <th className="px-4 py-2.5 text-right font-normal">Paid</th>
            <th className="px-4 py-2.5 text-right font-normal">Difference</th>
            <th className="px-4 py-2.5 font-normal">Clause</th>
            <th className="px-4 py-2.5 font-normal">To recover it</th>
          </tr>
        </thead>
        <tbody>
          {leaks.map((l) => (
            <tr
              key={`${l.kind}:${l.chargeId ?? l.transactionIds.join('-')}`}
              className="border-b border-rule-2 align-top last:border-0"
            >
              <td className="px-4 py-3">
                <Pill tone={KIND[l.kind].tone}>{KIND[l.kind].label}</Pill>
                <div className="mt-1 text-ink">{l.label}</div>
              </td>
              <td className="num px-4 py-3 text-right text-ink-2">
                <Money value={l.expected} currency={currency} />
              </td>
              <td className="num px-4 py-3 text-right text-ink-2">
                <Money value={l.actual} currency={currency} />
              </td>
              <td className="num px-4 py-3 text-right font-semibold text-ink">
                <Money value={l.amount} currency={currency} />
              </td>
              <td className="px-4 py-3 text-ink-2">{uniqueRefs(l.clauseRefs).join(', ') || '—'}</td>
              <td className="px-4 py-3 text-ink-2">{l.recovery}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
