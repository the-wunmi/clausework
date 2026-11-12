'use client';

import type { ChargeStatus, LedgerRow, Minor } from '@clausework/core';
import type { ColDef, ValueFormatterParams } from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { addDays, chartAmount, money, sumMinor } from '@/lib/format';
import { GRID_LICENSE, GRID_MODULES, ledgerTheme } from '../grid/setup';

const MONTHS = 18;

/** Money that has moved or never will is history, not forecast. */
const SETTLED = new Set<ChargeStatus>(['paid', 'released', 'cancelled', 'refunded', 'unclaimed']);

const monthKey = (iso: string) => iso.slice(0, 7);
const monthName = (key: string, short = false) =>
  new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    year: short ? '2-digit' : 'numeric',
    timeZone: 'UTC',
  });

function nextMonths(today: string, n: number): string[] {
  const out: string[] = [];
  let d = `${monthKey(today)}-01`;
  for (let i = 0; i < n; i++) {
    out.push(monthKey(d));
    d = addDays(`${monthKey(d)}-28`, 5);
  }
  return out;
}

/** In is money to us, out is money from us; charges between other parties are not our cash. */
const signed = (r: LedgerRow): Minor | null =>
  r.amount === null || r.direction === 'other'
    ? null
    : r.direction === 'out'
      ? (`-${r.amount}` as Minor)
      : r.amount;

interface ForecastRow {
  agreement: string;
  counterparties: string;
  currency: string;
  overdue: Minor;
  in12: Minor;
  out12: Minor;
  net12: Minor;
  months: { month: string; net: number; currency: string }[];
  variable: number;
}

function forecast(rows: LedgerRow[], today: string): ForecastRow[] {
  const months = nextMonths(today, MONTHS);
  const first12 = new Set(months.slice(0, 12));
  const byAgreement = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    if (SETTLED.has(r.status) || !r.dueDate) continue;
    byAgreement.set(r.agreementId, [...(byAgreement.get(r.agreementId) ?? []), r]);
  }
  return [...byAgreement.values()].map((list) => {
    const head = list[0] as LedgerRow;
    const currency = head.currency;
    const due = (r: LedgerRow) => monthKey(r.dueDate ?? '');
    const late = list.filter((r) => (r.dueDate ?? '') < today && signed(r));
    const ahead = list.filter((r) => (r.dueDate ?? '') >= today);
    const year = ahead.filter((r) => first12.has(due(r)));
    return {
      agreement: head.agreementTitle,
      counterparties: [...new Set(list.map((r) => r.counterparty))].join(', '),
      currency,
      overdue: sumMinor(late.map(signed)),
      in12: sumMinor(year.filter((r) => r.direction === 'in').map((r) => r.amount)),
      out12: sumMinor(year.filter((r) => r.direction === 'out').map((r) => r.amount)),
      net12: sumMinor(year.map(signed)),
      months: months.map((m) => ({
        month: monthName(m, true),
        net: chartAmount(sumMinor(ahead.filter((r) => due(r) === m).map(signed)), currency),
        currency,
      })),
      variable: ahead.filter((r) => r.amount === null).length,
    };
  });
}

const moneyCol = (
  field: keyof ForecastRow,
  headerName: string,
  tip: string,
): ColDef<ForecastRow> => ({
  field,
  headerName,
  headerTooltip: tip,
  width: 128,
  // Not the rightAligned type: its header puts the menu first, which reads as an empty column.
  cellStyle: { textAlign: 'right' },
  cellClass: 'num',
  comparator: (a: Minor, b: Minor) => Number(a) - Number(b),
  valueFormatter: (p: ValueFormatterParams<ForecastRow>) =>
    money(p.value as Minor, p.data?.currency ?? 'USD'),
});

/** Chart and pivot figures are display numbers, rounded to whole units for reading at a glance. */
const wholeMoney = (v: number, currency: string) =>
  v.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 });

const SEAL = '#0d6b57';
const AMBER = '#b7791f';

/** One row per agreement: what is still to come in and go out, and when. */
function ByAgreement({ rows, today }: { rows: LedgerRow[]; today: string }) {
  const data = useMemo(() => forecast(rows, today), [rows, today]);
  const columns = useMemo<ColDef<ForecastRow>[]>(
    () => [
      {
        field: 'agreement',
        headerName: 'Agreement',
        width: 220,
        tooltipField: 'agreement',
      },
      { field: 'counterparties', headerName: 'With', width: 170, tooltipField: 'counterparties' },
      moneyCol('overdue', 'Late now', 'Due before today and not yet paid, net of what we owe'),
      moneyCol('in12', 'In, 12 months', 'Fixed amounts due to us in the next 12 months'),
      moneyCol('out12', 'Out, 12 months', 'Fixed amounts we pay out in the next 12 months'),
      moneyCol('net12', 'Net, 12 months', 'In less out'),
      {
        field: 'months',
        headerName: `Next ${MONTHS} months`,
        headerTooltip: 'Net cash by month: up for money in, down for money out',
        minWidth: 260,
        flex: 1,
        sortable: false,
        cellRenderer: 'agSparklineCellRenderer',
        cellRendererParams: {
          sparklineOptions: {
            type: 'bar',
            direction: 'vertical',
            xKey: 'month',
            yKey: 'net',
            fill: SEAL,
            itemStyler: (p: { datum: { net: number } }) => ({
              fill: p.datum.net < 0 ? AMBER : SEAL,
            }),
            axis: { stroke: '#dedbd2' },
            tooltip: {
              renderer: (p: { datum: { month: string; net: number; currency: string } }) => ({
                title: p.datum.month,
                content: wholeMoney(p.datum.net, p.datum.currency),
              }),
            },
          },
        },
      },
      {
        field: 'variable',
        headerName: 'Variable',
        headerTooltip:
          'Usage and revenue shares: their amount is known only when their period closes',
        width: 110,
        cellStyle: { textAlign: 'right' },
        valueFormatter: (p) => (p.value ? `${p.value} to come` : ''),
      },
    ],
    [],
  );
  return (
    <AgGridReact<ForecastRow>
      theme={ledgerTheme}
      rowData={data}
      columnDefs={columns}
      defaultColDef={{ sortable: true, resizable: true }}
      rowHeight={64}
      getRowId={(p) => p.data.agreement}
      overlayNoRowsTemplate='<span style="color:#858d9e">Nothing left to come in or go out.</span>'
    />
  );
}

interface MonthRow {
  agreement: string;
  counterparty: string;
  month: string;
  net: number;
}

/** The same charges as a pivot: agreements down, months across, net cash in each cell. */
function ByMonth({ rows, today }: { rows: LedgerRow[]; today: string }) {
  const months = useMemo(() => new Set(nextMonths(today, MONTHS)), [today]);
  const data = useMemo<MonthRow[]>(
    () =>
      rows.flatMap((r) => {
        const s = signed(r);
        if (SETTLED.has(r.status) || !r.dueDate || !s || r.dueDate < today) return [];
        if (!months.has(monthKey(r.dueDate))) return [];
        return [
          {
            agreement: r.agreementTitle,
            counterparty: r.counterparty,
            month: monthKey(r.dueDate),
            net: chartAmount(s, r.currency),
          },
        ];
      }),
    [rows, today, months],
  );
  const currency = rows[0]?.currency ?? 'USD';
  const columns = useMemo<ColDef<MonthRow>[]>(
    () => [
      { field: 'agreement', headerName: 'Agreement', rowGroup: true, hide: true },
      { field: 'counterparty', headerName: 'Counterparty', rowGroup: true, hide: true },
      { field: 'month', headerName: 'Month', pivot: true },
      {
        field: 'net',
        headerName: 'Net',
        aggFunc: 'sum',
        cellStyle: { textAlign: 'right' },
        valueFormatter: (p) => (typeof p.value === 'number' ? wholeMoney(p.value, currency) : ''),
      },
    ],
    [currency],
  );
  return (
    <AgGridReact<MonthRow>
      theme={ledgerTheme}
      rowData={data}
      columnDefs={columns}
      pivotMode
      removePivotHeaderRowWhenSingleValueColumn
      autoGroupColumnDef={{ headerName: 'Agreement', minWidth: 300, pinned: 'left' }}
      groupDefaultExpanded={0}
      grandTotalRow="bottom"
      suppressAggFuncInHeader
      cellSelection
      enableCharts
      sideBar={{ toolPanels: ['columns'], hiddenByDefault: true }}
      processPivotResultColDef={(c) => {
        const key = c.pivotKeys?.[0];
        if (key) c.headerName = monthName(key, true);
        c.width = 112;
      }}
    />
  );
}

/** Cash still to come in and go out under every live agreement, from the charges the plans laid out. */
export function CashForecast({ rows, today }: { rows: LedgerRow[]; today: string }) {
  const [view, setView] = useState<'agreement' | 'month'>('agreement');
  return (
    <AgGridProvider modules={GRID_MODULES} licenseKey={GRID_LICENSE}>
      <div className="mb-3 flex items-center gap-3 text-[12.5px] text-ink-2">
        <p className="mr-auto max-w-[70ch] text-ink-3">
          What every live agreement still brings in and pays out, month by month, from the charges
          its plan laid out. Escalators and retainage releases are included; usage and revenue
          shares count once their period closes. Green is money in, amber is money out.
        </p>
        {(['agreement', 'month'] as const).map((v) => (
          <button
            key={v}
            type="button"
            className={`btn h-7 text-[12.5px] ${view === v ? 'btn-primary' : 'btn-quiet'}`}
            onClick={() => setView(v)}
          >
            {v === 'agreement' ? 'By agreement' : 'By month'}
          </button>
        ))}
      </div>
      <div style={{ height: 560 }}>
        {view === 'agreement' ? (
          <ByAgreement rows={rows} today={today} />
        ) : (
          <ByMonth rows={rows} today={today} />
        )}
      </div>
    </AgGridProvider>
  );
}
