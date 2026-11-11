'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { useApp } from '@/components/app-context';
import { ErrorNote, Money, PageHeader, Pill, Skeleton, Spinner } from '@/components/ui';
import { type AuditHistory, api } from '@/lib/api';
import { stamp } from '@/lib/format';
import { useResource } from '@/lib/use-resource';

export default function AuditPage() {
  return (
    <Suspense>
      <Audit />
    </Suspense>
  );
}

function Audit() {
  const search = useSearchParams();
  const router = useRouter();
  const { meta, run } = useApp();
  const agreements = useResource(api.agreements, []);
  const audits = useResource(api.audits, [], (d) =>
    d?.some((a) => a.status === 'matching') ? 2000 : null,
  );
  const compiled = (agreements.data ?? []).filter(
    (a) => a.stage !== 'reading' && a.stage !== 'compiling' && a.stage !== 'failed',
  );
  const [agreementId, setAgreementId] = useState('');
  const [picked, setSource] = useState<'sample' | 'csv'>('sample');
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const histories = meta?.samples.filter((s) => s.kind === 'history') ?? [];
  // The agreement asked for in the link, else one there is a payment history to audit against.
  const fallback =
    compiled.find((a) => a.id === search.get('agreement')) ??
    compiled.find((a) => histories.some((h) => h.forSample === a.sampleKey)) ??
    compiled[0] ??
    null;
  const chosen = compiled.find((a) => a.id === agreementId) ?? fallback;
  // A sample history belongs to the sample agreement it was written for, and to nothing else.
  const matching = chosen?.sampleKey
    ? histories.filter((h) => h.forSample === chosen.sampleKey)
    : [];
  const source = matching.length > 0 ? picked : 'csv';
  const [historyKey, setHistoryKey] = useState('');
  const history = matching.find((h) => h.key === historyKey) ?? matching[0] ?? null;

  const start = async () => {
    if (!chosen) return;
    let h: AuditHistory;
    if (source === 'csv') {
      if (!csv) return;
      h = { kind: 'csv', name: csv.name, text: csv.text };
    } else {
      if (!history) return;
      h = { kind: 'sample', key: history.key };
    }
    setBusy(true);
    const res = await run(
      () => api.startAudit({ agreementId: chosen.id, history: h }),
      'The audit did not start',
    );
    setBusy(false);
    if (res) router.push(`/audit/${res.id}`);
  };

  return (
    <>
      <PageHeader
        title="Audit"
        lede="Compare what an agreement says should have been paid with what PayPal shows was paid. Every gap points to its clause, in both directions: money owed to you and money you owe back."
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="sheet space-y-5 p-6">
          <h2 className="serif text-[19px] font-medium">Start an audit</h2>
          {agreements.loading && !agreements.data ? (
            <Skeleton className="h-10" />
          ) : compiled.length === 0 ? (
            <p className="text-ink-2">
              Compile an agreement first. The audit checks payments against its money plan.{' '}
              <Link href="/agreements/new" className="font-medium text-seal">
                Upload an agreement
              </Link>
            </p>
          ) : (
            <>
              <label className="block">
                <span className="label">Agreement</span>
                <select
                  className="field mt-1"
                  value={chosen?.id ?? ''}
                  onChange={(e) => {
                    setAgreementId(e.target.value);
                    setHistoryKey('');
                  }}
                >
                  {compiled.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend className="label">Payment history</legend>
                <div className="mt-2 space-y-2">
                  {matching.length > 0 && (
                    <label className="flex items-start gap-2.5 text-[13.5px]">
                      <input
                        type="radio"
                        className="mt-1"
                        checked={source === 'sample'}
                        onChange={() => setSource('sample')}
                      />
                      <span>
                        <span className="font-medium text-ink">Sample PayPal history</span>
                        <span className="block text-ink-3">
                          Twelve months of activity for this sample agreement.
                        </span>
                        {source === 'sample' && matching.length > 1 && (
                          <select
                            className="field mt-2"
                            value={history?.key ?? ''}
                            onChange={(e) => setHistoryKey(e.target.value)}
                          >
                            {matching.map((h) => (
                              <option key={h.key} value={h.key}>
                                {h.title}
                              </option>
                            ))}
                          </select>
                        )}
                      </span>
                    </label>
                  )}
                  <label className="flex items-start gap-2.5 text-[13.5px]">
                    <input
                      type="radio"
                      className="mt-1"
                      checked={source === 'csv'}
                      onChange={() => setSource('csv')}
                    />
                    <span>
                      <span className="font-medium text-ink">PayPal activity export (CSV)</span>
                      <span className="block text-ink-3">
                        Download it from PayPal under Activity, then upload it here.
                      </span>
                      {source === 'csv' && (
                        <span className="mt-2 flex items-center gap-3">
                          <button
                            type="button"
                            className="btn btn-quiet h-8"
                            onClick={() => file.current?.click()}
                          >
                            {csv ? 'Choose another file' : 'Choose a CSV'}
                          </button>
                          {csv && <span className="text-ink-2">{csv.name}</span>}
                          <input
                            ref={file}
                            type="file"
                            accept=".csv,text/csv"
                            className="hidden"
                            onChange={async (e) => {
                              const f = e.target.files?.[0];
                              if (f) setCsv({ name: f.name, text: await f.text() });
                            }}
                          />
                        </span>
                      )}
                    </span>
                  </label>
                </div>
              </fieldset>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !chosen || (source === 'sample' ? !history : !csv)}
                onClick={() => void start()}
              >
                {busy && <Spinner className="size-3.5" />}
                Run the audit
              </button>
            </>
          )}
        </div>

        <div>
          <h2 className="serif mb-3 text-[19px] font-medium">Past audits</h2>
          {audits.error && !audits.data ? (
            <ErrorNote message={audits.error.message} onRetry={() => void audits.reload()} />
          ) : audits.loading && !audits.data ? (
            <Skeleton className="h-32" />
          ) : (audits.data ?? []).length === 0 ? (
            <p className="text-ink-2">No audits yet.</p>
          ) : (
            <ul className="sheet divide-y divide-rule-2">
              {(audits.data ?? []).map((a) => (
                <li key={a.id}>
                  <Link
                    href={`/audit/${a.id}`}
                    className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-[#faf9f6]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">
                        {a.agreementTitle ?? a.sourceName}
                      </span>
                      <span className="block text-[12.5px] text-ink-3">
                        {a.sourceName}, {stamp(a.createdAt)}
                      </span>
                    </span>
                    {a.status === 'matching' ? (
                      <Pill tone="muted">Matching</Pill>
                    ) : a.status === 'failed' ? (
                      <Pill tone="red">Failed</Pill>
                    ) : a.report ? (
                      <span className="text-right text-[13px]">
                        <span className="block text-seal">
                          <Money value={a.report.owedToYou} currency={a.currency} /> owed to you
                        </span>
                        <span className="block text-amber">
                          <Money value={a.report.youOwe} currency={a.currency} /> you owe
                        </span>
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
