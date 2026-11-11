'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { api } from '@/lib/api';
import { PORTAL_TOKEN_KEY } from '@/lib/portal';
import { useApp } from './app-context';
import { PayPalMark } from './ui';

const NAV = [
  {
    href: '/',
    label: 'Agreements',
    match: (p: string) => p === '/' || p.startsWith('/agreements'),
  },
  { href: '/ledger', label: 'Ledger', match: (p: string) => p.startsWith('/ledger') },
  { href: '/audit', label: 'Audit', match: (p: string) => p.startsWith('/audit') },
];

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`serif inline-flex items-baseline gap-1.5 text-[21px] font-medium tracking-[-0.015em] text-ink ${className}`}
    >
      <span className="text-seal" aria-hidden>
        §
      </span>
      Clausework
    </span>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { metaError } = useApp();
  // The owner's own views: a PayPal checkout started here returns here, not to a party's portal.
  useEffect(() => sessionStorage.removeItem(PORTAL_TOKEN_KEY), []);
  // The ledger dashboard is a canvas of charts and tables; it gets the whole width.
  const wide = path.startsWith('/ledger');
  return (
    <div className="min-h-screen xl:grid xl:grid-cols-[216px_minmax(0,1fr)]">
      {/* Below 1280px the sidebar would take a fifth of the screen; the top bar carries the nav. */}
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-rule bg-[#ebe9e2] px-4 py-5 xl:flex">
        <Link href="/" className="mb-8 px-2">
          <Wordmark />
        </Link>
        <nav className="flex flex-col gap-0.5" aria-label="Main">
          {NAV.map((n) => {
            const active = n.match(path);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={`rounded-md px-3 py-2 text-[14px] font-medium transition-colors ${
                  active
                    ? 'bg-sheet text-ink shadow-[0_1px_0_rgba(22,33,58,0.06)]'
                    : 'text-ink-2 hover:bg-[#e2dfd6] hover:text-ink'
                }`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <Link href="/agreements/new" className="btn btn-primary mt-6 justify-center">
          New agreement
        </Link>
        <div className="mt-auto space-y-2 px-2 text-[12px] text-ink-3">
          {metaError && <p className="text-red">{metaError}</p>}
          <p>Money plans compile from your contracts. Every charge cites its clause.</p>
        </div>
      </aside>
      <div className="flex min-w-0 flex-col">
        <TopBar path={path} />
        <main
          className={`mx-auto w-full flex-1 px-6 pt-8 pb-16 xl:px-8 ${wide ? 'max-w-none' : 'max-w-[1320px]'}`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

function TopBar({ path }: { path: string }) {
  const { meta, metaError } = useApp();
  const mode = meta?.paypal.mode;
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-rule bg-paper/90 px-6 backdrop-blur xl:px-8">
      <div className="flex min-w-0 items-center gap-5 xl:hidden">
        <Link href="/" aria-label="Clausework home">
          <Wordmark className="text-[19px]" />
        </Link>
        <nav className="flex items-center gap-0.5" aria-label="Main">
          {NAV.map((n) => {
            const active = n.match(path);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? 'page' : undefined}
                className={`rounded-md px-2.5 py-1.5 text-[13.5px] font-medium transition-colors ${
                  active ? 'bg-sheet text-ink' : 'text-ink-2 hover:text-ink'
                }`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="ml-auto flex items-center gap-4">
        {metaError && (
          <span className="text-[12px] text-red xl:hidden" title={metaError}>
            API unreachable
          </span>
        )}
        <Link href="/agreements/new" className="btn btn-primary h-8 px-3 text-[12.5px] xl:hidden">
          New agreement
        </Link>
        {mode && (
          <span
            className="inline-flex items-center gap-2 rounded-full border border-paypal/25 bg-paypal-soft px-3 py-1 text-[12.5px] text-paypal-deep"
            title={
              mode === 'live'
                ? 'Calls go to api-m.paypal.com.'
                : 'Calls go to api-m.sandbox.paypal.com.'
            }
          >
            <PayPalMark />
            {mode === 'live' ? 'live' : 'sandbox'}
            {meta?.paypal.usageBilling && (
              <span className="hidden text-paypal xl:inline">with Usage-Based Billing</span>
            )}
          </span>
        )}
        <button
          type="button"
          className="text-[12.5px] text-ink-3 hover:text-ink"
          onClick={async () => {
            await api.signOut().catch(() => {});
            window.location.assign('/login');
          }}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
