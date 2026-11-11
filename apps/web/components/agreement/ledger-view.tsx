'use client';

import type { AgreementDetail } from '@clausework/core';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { api } from '@/lib/api';
import { atRisk, isAwaitingPayment, isLive, money, refused, sumMinor } from '@/lib/format';
import { useApp } from '../app-context';
import { Skeleton, Spinner } from '../ui';

const ChargesGrid = dynamic(() => import('../grid/charges-grid').then((m) => m.ChargesGrid), {
  ssr: false,
  loading: () => <Skeleton className="h-[520px]" />,
});

export function LedgerView({
  detail,
  onChange,
}: {
  detail: AgreementDetail;
  onChange: (d: AgreementDetail) => void;
}) {
  const currency = detail.agreement.currency ?? 'USD';
  const c = detail.charges;
  // Cash that arrived, as the API counts it; a charge's amount is what was asked for.
  const paid = detail.agreement.totals.collected;
  const out = sumMinor(
    c
      .filter((x) => (x.status === 'paid' || x.status === 'released') && x.direction === 'out')
      .map((x) => x.amount),
  );
  const owedIn = sumMinor(
    c.filter((x) => isAwaitingPayment(x) && x.direction === 'in').map((x) => x.amount),
  );
  const owedOut = sumMinor(
    c.filter((x) => isAwaitingPayment(x) && x.direction === 'out').map((x) => x.amount),
  );
  const risky = c.filter(atRisk);
  const refusedCount = risky.filter(refused).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          {[
            ['Collected', paid, 'text-seal'],
            ['Paid out', out, 'text-ink'],
            ['Owed to you', owedIn, 'text-ink'],
            ['You owe', owedOut, 'text-ink'],
          ].map(([label, value, tone]) => (
            <div key={label}>
              <dt className="text-[12px] text-ink-3">{label}</dt>
              <dd className={`serif num text-[22px] ${tone}`}>{money(value, currency)}</dd>
            </div>
          ))}
          {risky.length > 0 && (
            <div>
              <dt className="text-[12px] text-ink-3">At risk</dt>
              <dd className="serif num text-[22px] text-red">
                {risky.length} charge{risky.length === 1 ? '' : 's'}
              </dd>
              {refusedCount > 0 && (
                <dd className="text-[12px] text-red">
                  {refusedCount} refused by PayPal, retried automatically
                </dd>
              )}
            </div>
          )}
        </dl>
        <UsageForm detail={detail} onChange={onChange} />
      </div>
      <ChargesGrid rows={detail.charges} />
    </div>
  );
}

function UsageForm({
  detail,
  onChange,
}: {
  detail: AgreementDetail;
  onChange: (d: AgreementDetail) => void;
}) {
  const { run, toast } = useApp();
  // Usage is recorded against what runs on PayPal now, not an amendment still awaiting approval.
  const running = detail.liveObligations ?? detail.version?.plan.obligations ?? [];
  const metered = running.filter((o) => o.kind === 'usage' || o.kind === 'prepaid');
  const [picked, setKey] = useState<string | null>(null);
  const [qty, setQty] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (metered.length === 0 || !isLive(detail.agreement)) return null;
  // Derived on every render: an amendment can add or remove metered obligations.
  const chosen = metered.find((o) => o.key === picked) ?? metered[0];
  const key = chosen?.key ?? '';
  const unit = (chosen?.unit as string | undefined) ?? 'units';
  // The field asks for a count of the unit: "Hours", not "Hour".
  const unitLabel = unit.endsWith('s') ? unit : `${unit}s`;

  return (
    <form
      className="relative flex items-end gap-2 rounded-[10px] border border-rule bg-sheet px-3 py-2.5"
      onSubmit={async (e) => {
        e.preventDefault();
        const quantity = Number(qty);
        if (!/^\d+(\.\d{1,2})?$/.test(qty.trim()) || quantity <= 0) {
          setInvalid('Enter a positive number with at most two decimals, such as 3 or 1.5.');
          return;
        }
        setInvalid(null);
        setBusy(true);
        const d = await run(
          () => api.recordUsage(detail.agreement.id, { obligationKey: key, quantity }),
          'Usage was not recorded',
        );
        setBusy(false);
        if (d) {
          onChange(d);
          setQty('');
          toast({
            tone: 'success',
            title: `Recorded ${quantity} ${unit}${quantity === 1 || unit.endsWith('s') ? '' : 's'}`,
            body: 'Sent to PayPal as a usage event.',
          });
        }
      }}
    >
      <label className="block">
        <span className="label">Record usage</span>
        <select
          className="field mt-1 h-8 py-0 text-[13px]"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        >
          {metered.map((o) => (
            <option key={o.key} value={o.key}>
              {o.title}
            </option>
          ))}
        </select>
      </label>
      <label className="block w-28">
        <span className="label capitalize">{unitLabel}</span>
        <input
          className="field num mt-1 h-8 py-0 text-[13px]"
          inputMode="decimal"
          placeholder="0"
          value={qty}
          onChange={(e) => {
            setQty(e.target.value);
            setInvalid(null);
          }}
          aria-invalid={invalid !== null}
          aria-describedby={invalid ? 'usage-error' : undefined}
        />
      </label>
      <button type="submit" className="btn btn-quiet h-8" disabled={busy || !qty}>
        {busy && <Spinner className="size-3" />}
        Record
      </button>
      {invalid && (
        <p
          id="usage-error"
          role="alert"
          className="absolute top-full right-0 mt-1 text-[12px] text-red"
        >
          {invalid}
        </p>
      )}
    </form>
  );
}
