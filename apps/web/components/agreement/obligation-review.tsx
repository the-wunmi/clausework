'use client';

import type { AgreementDetail, ObligationView } from '@clausework/core';
import { useState } from 'react';
import { api } from '@/lib/api';
import { minorDigits } from '@/lib/format';
import { AMOUNT_FIELDS, BPS_FIELDS, termLabel } from '@/lib/plan';
import { useApp } from '../app-context';
import { Spinner } from '../ui';

const COUNT = new Set(['included', 'cap', 'units', 'cycles', 'netDays', 'graceDays']);

/** "1,500.50" as minor units, exactly; null when it is not an amount in this currency. */
function parseMoney(input: string, currency: string): string | null {
  const digits = minorDigits(currency);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(input.replace(/[,\s$€£]/g, ''));
  if (!m || (m[2] ?? '').length > digits) return null;
  return BigInt((m[1] ?? '0') + (m[2] ?? '').padEnd(digits, '0')).toString();
}

function minorToDecimal(minor: string, currency: string): string {
  const digits = minorDigits(currency);
  const s = minor.padStart(digits + 1, '0');
  return digits === 0 ? s : `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

/** The terms a person can correct in place. Dates and links between lines stay with the contract. */
function editableFields(o: ObligationView): string[] {
  const fields = Object.keys(o).filter(
    (f) =>
      (AMOUNT_FIELDS.has(f) || BPS_FIELDS.has(f) || COUNT.has(f)) &&
      (o[f] === null || typeof o[f] !== 'object'),
  );
  const amount = o.amount as { kind?: string } | string | undefined;
  if (typeof amount === 'string' || (amount && amount.kind === 'fixed')) fields.unshift('amount');
  return fields;
}

function initial(o: ObligationView, field: string, currency: string): string {
  const v =
    field === 'amount' && typeof o.amount === 'object'
      ? (o.amount as { amount: string }).amount
      : o[field];
  if (v === null || v === undefined) return '';
  if (field === 'amount' || AMOUNT_FIELDS.has(field)) return minorToDecimal(String(v), currency);
  if (BPS_FIELDS.has(field)) return String(Number(v) / 100);
  return String(v);
}

/**
 * The review step for a line the model was unsure of: confirm it as written, or correct its
 * amounts and counts. Either way a person, not the model, settles it before approval.
 */
export function ObligationReview({
  detail,
  obligation: o,
  onChange,
}: {
  detail: AgreementDetail;
  obligation: ObligationView;
  onChange: (d: AgreementDetail) => void;
}) {
  const { run, toast } = useApp();
  const currency = detail.version?.plan.currency ?? 'USD';
  const fields = editableFields(o);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(o.title);
  const [values, setValues] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<string | null>(null);
  const id = detail.agreement.id;

  const confirm = async () => {
    setBusy(true);
    const d = await run(() => api.confirmObligation(id, o.key), 'The line was not confirmed');
    setBusy(false);
    if (d) {
      onChange(d);
      toast({ tone: 'success', title: `Confirmed: ${o.title}` });
    }
  };

  const save = async () => {
    const next: ObligationView = { ...o, title: title.trim() || o.title };
    for (const f of fields) {
      const raw = (values[f] ?? initial(o, f, currency)).trim();
      if (raw === '') {
        next[f] = null;
        continue;
      }
      if (f === 'amount' || AMOUNT_FIELDS.has(f)) {
        const minor = parseMoney(raw, currency);
        if (minor === null)
          return setInvalid(`${termLabel(f)} must be an amount such as 1500 or 1500.50.`);
        next[f] =
          f === 'amount' && typeof o.amount === 'object' ? { kind: 'fixed', amount: minor } : minor;
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) return setInvalid(`${termLabel(f)} must be a number.`);
        next[f] = BPS_FIELDS.has(f) ? Math.round(n * 100) : n;
      }
    }
    setInvalid(null);
    setBusy(true);
    const d = await run(
      () => api.editObligation(id, o.key, { obligation: next, note: `Owner corrected ${o.title}` }),
      'The correction was not saved',
    );
    setBusy(false);
    if (d) {
      onChange(d);
      setEditing(false);
      toast({
        tone: 'success',
        title: `Corrected: ${next.title}`,
        body: 'The tests ran again on the new version.',
      });
    }
  };

  if (!editing) {
    return (
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary h-8 px-3 text-[12.5px]"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy && <Spinner className="size-3" />}
          Confirm as written
        </button>
        <button
          type="button"
          className="btn btn-quiet h-8 px-3 text-[12.5px]"
          disabled={busy}
          onClick={() => setEditing(true)}
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <form
      className="mt-3 space-y-2 rounded-md border border-rule bg-[#faf9f6] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="block">
        <span className="label">Name</span>
        <input
          className="field mt-1 h-8 py-0 text-[13px]"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        {fields.map((f) => (
          <label key={f} className="block">
            <span className="label">
              {termLabel(f)}
              {f === 'amount' || AMOUNT_FIELDS.has(f)
                ? ` (${currency})`
                : BPS_FIELDS.has(f)
                  ? ' (%)'
                  : ''}
            </span>
            <input
              className="field num mt-1 h-8 py-0 text-[13px]"
              inputMode="decimal"
              value={values[f] ?? initial(o, f, currency)}
              onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      {fields.length === 0 && (
        <p className="text-[12px] text-ink-3">
          This line has no amounts to correct here; change its wording in the contract.
        </p>
      )}
      {invalid && (
        <p role="alert" className="text-[12px] text-red">
          {invalid}
        </p>
      )}
      <p className="text-[12px] text-ink-3">
        Saving creates a new version, re-runs the tests and restarts approvals.
      </p>
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary h-8 px-3 text-[12.5px]" disabled={busy}>
          {busy && <Spinner className="size-3" />}
          Save correction
        </button>
        <button
          type="button"
          className="btn btn-quiet h-8 px-3 text-[12.5px]"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
