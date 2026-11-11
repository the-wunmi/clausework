'use client';

import type { ChargeStatus, Minor } from '@clausework/core';
import type { ReactNode } from 'react';
import type { Tone } from '@/lib/format';
import { chargeStatus, money, retainageNote } from '@/lib/format';

const TONE: Record<Tone, string> = {
  ink: 'bg-[#e9ecf3] text-ink',
  seal: 'bg-seal-soft text-seal-deep',
  amber: 'bg-amber-soft text-amber',
  red: 'bg-red-soft text-red',
  paypal: 'bg-paypal-soft text-paypal-deep',
  muted: 'bg-rule-2 text-ink-2',
};

const DOT: Record<Tone, string> = {
  ink: 'bg-ink',
  seal: 'bg-seal',
  amber: 'bg-amber',
  red: 'bg-red',
  paypal: 'bg-paypal',
  muted: 'bg-ink-3',
};

export function Pill({
  tone = 'muted',
  children,
  dot = true,
}: {
  tone?: Tone;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[1px] text-[12px] font-medium leading-5 whitespace-nowrap ${TONE[tone]}`}
    >
      {dot && <span className={`size-1.5 rounded-full ${DOT[tone]}`} aria-hidden />}
      {children}
    </span>
  );
}

/**
 * A charge's status as a pill. When PayPal refused to move the money, the pill says so in red and
 * carries PayPal's reason; `inline` also prints the reason under it, for places without hover.
 */
export function ChargeStatusPill({
  charge,
  inline = false,
}: {
  charge: { status: ChargeStatus; problem?: string | null };
  inline?: boolean;
}) {
  const s = chargeStatus(charge);
  return (
    <span className="inline-flex flex-col items-start" title={s.reason ?? undefined}>
      <Pill tone={s.tone}>{s.label}</Pill>
      {inline && s.reason && (
        <span className="mt-1 max-w-[32ch] text-[12px] leading-snug text-red">{s.reason}</span>
      )}
    </span>
  );
}

/** What a charge asks for, net of retainage, with the gross and the holdback noted under it. */
export function ChargeAmount({
  charge,
  className = '',
}: {
  charge: { amount: Minor | null; grossAmount?: Minor | null; currency: string };
  className?: string;
}) {
  const note = retainageNote(charge);
  if (charge.amount === null) return <span className="text-ink-3">Variable</span>;
  return (
    <span className={`inline-flex flex-col ${className}`}>
      <span className="num">{money(charge.amount, charge.currency)}</span>
      {note && <span className="num text-[11.5px] leading-snug text-ink-3">{note}</span>}
    </span>
  );
}

export function Money({
  value,
  currency = 'USD',
  className = '',
}: {
  value: string | null | undefined;
  currency?: string | null;
  className?: string;
}) {
  return <span className={`num ${className}`}>{money(value, currency ?? 'USD')}</span>;
}

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-rule-2 ${className}`} />;
}

/** A failure to show. Pass `onRetry` only when trying again could help (not for a bad link). */
export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-red/30 bg-red-soft px-4 py-3 text-[13.5px] text-red"
    >
      <span className="flex-1">{message}</span>
      {onRetry && (
        <button
          type="button"
          className="font-semibold underline underline-offset-2"
          onClick={onRetry}
        >
          Try again
        </button>
      )}
    </div>
  );
}

export function PageHeader({
  title,
  lede,
  actions,
}: {
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="serif text-[30px] leading-tight font-medium tracking-[-0.01em] text-ink">
          {title}
        </h1>
        {lede && <p className="mt-1.5 max-w-[68ch] text-[14.5px] text-ink-2">{lede}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** PayPal's name in its own blue, marking the places where PayPal acts. */
export function PayPalMark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-bold italic tracking-[-0.02em] ${className}`}>
      <span className="text-paypal-deep">Pay</span>
      <span className="text-paypal">Pal</span>
    </span>
  );
}

export function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const tone = value >= 0.9 ? 'bg-seal' : value >= 0.8 ? 'bg-[#5d8f6f]' : 'bg-amber';
  return (
    <span className="inline-flex items-center gap-2" title={`Model confidence ${pct}%`}>
      <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-rule-2">
        <span className={`absolute inset-y-0 left-0 ${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="num text-[12px] text-ink-2">{pct}%</span>
    </span>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="sheet flex flex-col items-center px-8 py-14 text-center">
      <p className="serif text-[20px] text-ink">{title}</p>
      {body && <p className="mt-2 max-w-[52ch] text-ink-2">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
