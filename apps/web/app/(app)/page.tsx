'use client';

import type { AgreementSummary, LedgerRow } from '@clausework/core';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useApp } from '@/components/app-context';
import { SampleCards } from '@/components/sample-cards';
import { EmptyState, ErrorNote, Money, PageHeader, Pill, Skeleton, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { addDays, day, refused, stageOf, sumMinor, tidyLabel } from '@/lib/format';
import { useResource } from '@/lib/use-resource';

export default function AgreementsPage() {
  const { meta } = useApp();
  const list = useResource(api.agreements, [], (d) =>
    d?.some((a) => a.stage === 'reading' || a.stage === 'compiling') ? 3000 : 20_000,
  );
  const ledger = useResource(api.ledger, [list.data?.length]);

  const agreements = list.data ?? [];
  const contracts = meta?.samples.filter((s) => s.kind === 'contract') ?? [];

  return (
    <>
      <PageHeader
        title="Agreements"
        lede="Each agreement compiles into a money plan both sides approve. Once live, PayPal runs it and every charge points back to its clause."
        actions={
          <Link href="/agreements/new" className="btn btn-primary">
            Upload an agreement
          </Link>
        }
      />

      <Kpis
        agreements={agreements}
        rows={ledger.data}
        today={meta?.today ?? null}
        loading={list.loading && !list.data}
      />

      <div className="mt-9">
        {list.error && !list.data ? (
          <ErrorNote message={list.error.message} onRetry={() => void list.reload()} />
        ) : list.loading && !list.data ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-[74px]" />
            ))}
          </div>
        ) : agreements.length === 0 ? (
          <EmptyState
            title="No agreements yet"
            body="Upload a contract, statement of work or order form. Clausework reads it, finds every payment clause and builds the PayPal billing for you to check."
            action={
              <Link href="/agreements/new" className="btn btn-primary">
                Upload an agreement
              </Link>
            }
          />
        ) : (
          <Register agreements={agreements} rows={ledger.data ?? []} />
        )}
      </div>

      {contracts.length > 0 && (
        <div className="mt-12">
          <h2 className="serif mb-1 text-[19px] font-medium">Try a sample agreement</h2>
          <p className="mb-4 text-ink-2">
            Real-world wording, compiled live by the model. Each takes about a minute.
          </p>
          <SampleCards samples={contracts} />
        </div>
      )}
    </>
  );
}

function Kpis({
  agreements,
  rows,
  today,
  loading,
}: {
  agreements: AgreementSummary[];
  rows: LedgerRow[] | null;
  today: string | null;
  loading: boolean;
}) {
  const currency = agreements.find((a) => a.currency)?.currency ?? 'USD';
  const same = agreements.filter((a) => (a.currency ?? currency) === currency);
  const collected = sumMinor(same.map((a) => a.totals.collected));
  const overdue = sumMinor(same.map((a) => a.totals.overdue));
  // Refused by PayPal but not yet late: still at risk. Overdue ones are already in `overdue`.
  const refusedRows = (rows ?? []).filter(
    (r) => r.currency === currency && refused(r) && r.status !== 'overdue',
  );
  const atRisk = sumMinor([overdue, ...refusedRows.map((r) => r.amount)]);
  const horizon = today ? addDays(today, 30) : null;
  const upcoming =
    rows && today && horizon
      ? sumMinor(
          rows
            .filter(
              (r) =>
                r.currency === currency &&
                r.direction === 'in' &&
                r.dueDate !== null &&
                r.dueDate >= today &&
                r.dueDate <= horizon &&
                ['scheduled', 'issued', 'awaiting_approval', 'authorized'].includes(r.status),
            )
            .map((r) => r.amount),
        )
      : null;
  // Running means PayPal is collecting: payers have finished setup, and the plan has not ended.
  const live = agreements.filter(
    (a) => a.activatedAt !== null && a.stage !== 'completed' && a.stage !== 'awaiting_payer_setup',
  ).length;

  const cells: { label: string; value: ReactNode; note: string; tone?: string }[] = [
    {
      label: 'Collected through PayPal',
      value: <Money value={collected} currency={currency} />,
      note: 'All live agreements',
    },
    {
      label: 'Due to you in 30 days',
      value: upcoming === null ? '—' : <Money value={upcoming} currency={currency} />,
      note: horizon ? `Through ${day(horizon, true)}` : 'Scheduled charges',
    },
    {
      label: 'At risk',
      value: <Money value={atRisk} currency={currency} />,
      note:
        atRisk === '0'
          ? 'Nothing late or refused'
          : refusedRows.length > 0
            ? `${refusedRows.length} refused by PayPal${overdue === '0' ? '' : ', the rest overdue'}`
            : 'Overdue; late fees accrue per clause',
      tone: atRisk === '0' ? undefined : 'text-red',
    },
    {
      label: 'Running on PayPal',
      value: <span className="num">{live}</span>,
      note: `of ${agreements.length} agreements`,
    },
  ];

  return (
    <div className="sheet grid grid-cols-2 divide-rule-2 overflow-hidden lg:grid-cols-4 lg:divide-x">
      {cells.map((c) => (
        <div key={c.label} className="px-5 py-4">
          <div className="text-[12.5px] text-ink-2">{c.label}</div>
          <div className={`serif mt-1 text-[27px] leading-tight ${c.tone ?? 'text-ink'}`}>
            {loading ? <Skeleton className="mt-1 h-7 w-28" /> : c.value}
          </div>
          <div className="mt-0.5 text-[12px] text-ink-3">{c.note}</div>
        </div>
      ))}
    </div>
  );
}

const COLS =
  'grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,1.4fr)_110px] gap-4';

function Register({ agreements, rows }: { agreements: AgreementSummary[]; rows: LedgerRow[] }) {
  return (
    <div className="sheet overflow-hidden">
      <div className={`${COLS} border-b border-rule-2 px-5 py-2.5 text-[12px] text-ink-3`}>
        <span>Agreement</span>
        <span>Stage</span>
        <span>Approvals</span>
        <span>Next charge</span>
        <span className="text-right">Collected</span>
      </div>
      <ul>
        {agreements.map((a) => {
          const ended = a.stage === 'completed';
          const refusal = rows.find((r) => r.agreementId === a.id && refused(r));
          return (
            <li
              key={a.id}
              className="relative border-b border-rule-2 transition-colors last:border-0 hover:bg-[#faf9f6]"
            >
              <div className={`${COLS} items-center px-5 py-4`}>
                <span className="min-w-0">
                  {/* The title link covers the whole row; the audit link sits above it. */}
                  <Link
                    href={`/agreements/${a.id}`}
                    className="serif block truncate text-[16.5px] text-ink after:absolute after:inset-0"
                  >
                    {a.title}
                  </Link>
                  <span className="block truncate text-[12.5px] text-ink-3">
                    {a.counterparties.length > 0
                      ? `With ${a.counterparties.join(', ')}`
                      : a.sourceName}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {(a.stage === 'reading' || a.stage === 'compiling') && (
                    <Spinner className="size-3.5 text-ink-3" />
                  )}
                  <Pill tone={stageOf(a).tone}>{stageOf(a).label}</Pill>
                </span>
                <span className="text-[13px] text-ink-2">
                  {ended ? (
                    <Link
                      href={`/audit?agreement=${encodeURIComponent(a.id)}`}
                      className="relative z-10 font-medium text-seal hover:underline"
                    >
                      Audit only
                    </Link>
                  ) : a.approvals.required > 0 ? (
                    <>
                      <span className="num">
                        {a.approvals.approved} of {a.approvals.required}
                      </span>{' '}
                      signed the money
                    </>
                  ) : (
                    '—'
                  )}
                </span>
                <span className="min-w-0 text-[13px]">
                  {refusal ? (
                    <span className="block" title={refusal.problem ?? undefined}>
                      <span className="block truncate text-ink">{tidyLabel(refusal.label)}</span>
                      <span className="mt-0.5 inline-flex items-center gap-1.5 text-red">
                        <Pill tone="red">PayPal refused</Pill>
                        <Money value={refusal.amount} currency={refusal.currency} />
                      </span>
                    </span>
                  ) : a.nextCharge && !ended ? (
                    <>
                      <span className="block truncate text-ink">
                        {tidyLabel(a.nextCharge.label)}
                      </span>
                      <span className="block text-ink-3">
                        {day(a.nextCharge.dueDate, true)}
                        {a.nextCharge.amount && (
                          <>
                            , <Money value={a.nextCharge.amount} currency={a.currency} />
                          </>
                        )}
                      </span>
                    </>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </span>
                <span className="text-right text-[14px] text-ink">
                  <Money value={a.totals.collected} currency={a.currency} />
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
