'use client';

import dynamic from 'next/dynamic';
import { Component, type ReactNode, useState } from 'react';
import { useApp } from '@/components/app-context';
import { TabPanel, Tabs } from '@/components/tabs';
import { EmptyState, ErrorNote, PageHeader, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { browserToday } from '@/lib/format';
import { useResource } from '@/lib/use-resource';

const StudioDashboard = dynamic(() => import('@/components/ledger/studio-dashboard'), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});
const CashForecast = dynamic(
  () => import('@/components/ledger/cash-forecast').then((m) => m.CashForecast),
  { ssr: false, loading: () => <Skeleton className="h-[600px]" /> },
);
const AskGrid = dynamic(() => import('@/components/ledger/ask-grid').then((m) => m.AskGrid), {
  ssr: false,
  loading: () => <Skeleton className="h-[600px]" />,
});

/** If Studio fails to start (a licence or browser problem), the plain ledger takes over. */
class StudioBoundary extends Component<
  { children: ReactNode; onFail: (message: string) => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error) {
    this.props.onFail(error.message);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

const VIEWS = [
  ['studio', 'Dashboard and agent'],
  ['table', 'Ledger table'],
  ['forecast', 'Cash forecast'],
] as const;

export default function LedgerPage() {
  const { meta } = useApp();
  const ledger = useResource(api.ledger, [], 20_000);
  const [view, setView] = useState<'studio' | 'table' | 'forecast'>('studio');
  const [studioError, setStudioError] = useState<string | null>(null);
  const rows = ledger.data ?? [];

  return (
    <>
      <PageHeader
        title="Ledger"
        lede="Every charge across your live agreements, each tied to the clause that created it. Ask the Clausework agent what is owed, what is at risk and why; it builds the charts for you."
        actions={
          <Tabs
            id="ledger"
            label="Ledger views"
            variant="segmented"
            tabs={VIEWS}
            value={view}
            onChange={setView}
          />
        }
      />

      <TabPanel id="ledger" tab={view}>
        {ledger.error && !ledger.data ? (
          <ErrorNote message={ledger.error.message} onRetry={() => void ledger.reload()} />
        ) : ledger.loading && !ledger.data ? (
          <Skeleton className="h-[640px]" />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No charges yet"
            body="Charges appear here once an agreement is approved by every party and goes live on PayPal."
          />
        ) : view === 'forecast' ? (
          <CashForecast rows={rows} today={meta?.today ?? browserToday()} />
        ) : view === 'studio' && !studioError ? (
          <div className="sheet h-[calc(100vh-14rem)] min-h-[640px] overflow-hidden">
            <StudioBoundary
              onFail={(m) => {
                setStudioError(m);
                setView('table');
              }}
            >
              <StudioDashboard rows={rows} today={meta?.today ?? browserToday()} />
            </StudioBoundary>
          </div>
        ) : (
          <>
            {studioError && (
              <div className="mb-4">
                <ErrorNote
                  message={`The dashboard could not start (${studioError}). The ledger table works without it.`}
                />
              </div>
            )}
            <AskGrid rows={rows} />
          </>
        )}
      </TabPanel>
    </>
  );
}
