'use client';

import type { ChargeView, LedgerRow } from '@clausework/core';
import type {
  ColDef,
  ExcelStyle,
  GridApi,
  GridReadyEvent,
  IAggFuncParams,
  ICellRendererParams,
  ValueFormatterParams,
} from 'ag-grid-community';
import { AgGridProvider, AgGridReact } from 'ag-grid-react';
import { type Ref, useMemo, useState } from 'react';
import {
  chargeStatus,
  day,
  KIND_LABEL,
  minorDigits,
  money,
  PRODUCT_LABEL,
  retainageNote,
  tidyLabel,
  uniqueRefs,
} from '@/lib/format';
import { ChargeStatusPill } from '../ui';
import { ChargeTrace } from './charge-trace';
import { GRID_LICENSE, GRID_MODULES, ledgerTheme } from './setup';

export type Row = ChargeView &
  Partial<Pick<LedgerRow, 'agreementTitle' | 'counterparty' | 'daysOverdue'>>;

/** Minor units as a number for sorting; the formatter turns it back into money. */
const minorNumber = (r: Row | undefined) => (r?.amount ? Number(r.amount) : null);

/**
 * Group and grand totals, added exactly in minor units from each row's own string. Amounts in
 * different currencies are never added together: such a group shows no total.
 */
function sumAmounts(params: IAggFuncParams<Row>): number | null {
  const leaves = params.rowNode.allLeafChildren ?? [];
  const currencies = new Set(leaves.map((n) => n.data?.currency));
  if (currencies.size > 1) return null;
  let total = 0n;
  for (const n of leaves) if (n.data?.amount) total += BigInt(n.data.amount);
  return Number(total);
}

function StatusCell(p: ICellRendererParams<Row>) {
  const r = p.data;
  if (!r) return p.value ? <span className="text-ink-2">{String(p.value)}</span> : null;
  return <ChargeStatusPill charge={r} />;
}

/** The net amount, with the retainage held back from it on a second line. */
function AmountCell(p: ICellRendererParams<Row>) {
  const r = p.data;
  const text = p.valueFormatted ?? '';
  const note = r ? retainageNote(r) : null;
  return (
    <span
      className="num flex h-full flex-col justify-center text-right leading-tight"
      title={note ?? undefined}
    >
      <span>{text}</span>
      {note && <span className="text-[11px] text-ink-3">{note}</span>}
    </span>
  );
}

function PayPalRefCell(p: ICellRendererParams<Row>) {
  const r = p.data;
  if (!r?.paypalRef) return <span className="text-ink-3">—</span>;
  const href = r.payUrl ?? null;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="num text-paypal hover:underline">
      {r.paypalRef}
    </a>
  ) : (
    <span className="num text-ink-2">{r.paypalRef}</span>
  );
}

function DirectionCell(p: ICellRendererParams<Row>) {
  const d = p.data?.direction;
  if (!d) return null;
  return (
    <span className={d === 'in' ? 'text-seal' : d === 'out' ? 'text-amber' : 'text-ink-3'}>
      {d === 'in' ? 'In' : d === 'out' ? 'Out' : 'Between others'}
    </span>
  );
}

/** Excel keeps amounts as numbers, in major units with two decimals, so they sum in a sheet. */
const EXCEL_STYLES: ExcelStyle[] = [
  { id: 'amount', numberFormat: { format: '#,##0.00' } },
  { id: 'header', font: { bold: true } },
];

/** Every column a reviewer needs to check a charge, including those hidden in the grid. */
const EXPORT_COLUMNS = [
  'agreementTitle',
  'counterparty',
  'label',
  'kind',
  'direction',
  'payerName',
  'payeeName',
  'amount',
  'currency',
  'status',
  'dueDate',
  'daysOverdue',
  'paidOn',
  'clauseRefs',
  'basis',
  'paypalProduct',
  'paypalRef',
];

function exportToExcel(api: GridApi<Row>) {
  const on = new Date().toISOString().slice(0, 10);
  api.exportDataAsExcel({
    fileName: `clausework-ledger-${on}.xlsx`,
    sheetName: 'Charges',
    columnKeys: EXPORT_COLUMNS.filter((k) => api.getColumn(k)),
    skipRowGroups: true,
    // Leaves only: group rows and totals are rebuilt in the sheet from the numbers.
    shouldRowBeSkipped: (p) => !p.node.data,
    processCellCallback: (p) => {
      const r = p.node?.data as Row | undefined;
      const id = p.column.getColId();
      if (!r) return p.value;
      // The one place money leaves minor units: a spreadsheet needs a number it can add up.
      if (id === 'amount')
        return r.amount === null ? '' : Number(r.amount) / 10 ** minorDigits(r.currency);
      if (id === 'label') return tidyLabel(r.label);
      if (id === 'kind') return KIND_LABEL[r.kind];
      if (id === 'status') return chargeStatus(r).label;
      if (id === 'paypalProduct') return r.paypalProduct ? PRODUCT_LABEL[r.paypalProduct] : '';
      if (id === 'direction')
        return r.direction === 'in' ? 'In' : r.direction === 'out' ? 'Out' : 'Between others';
      return p.value ?? '';
    },
    author: 'Clausework',
  });
}

export function ChargesGrid({
  rows,
  portfolio = false,
  gridRef,
  onReady,
  height = 520,
}: {
  rows: Row[];
  portfolio?: boolean;
  gridRef?: Ref<AgGridReact<Row>>;
  onReady?: (e: GridReadyEvent<Row>) => void;
  height?: number;
}) {
  const currency = rows[0]?.currency ?? 'USD';
  // Periods with nothing to bill, and charges from before the plan ran here, are kept for the record but hidden until asked for.
  const [showSkipped, setShowSkipped] = useState(false);
  const [api, setApi] = useState<GridApi<Row> | null>(null);
  const skipped = rows.filter((r) => r.status === 'cancelled').length;
  const shown = useMemo(
    () => (showSkipped ? rows : rows.filter((r) => r.status !== 'cancelled')),
    [rows, showSkipped],
  );
  const columns = useMemo<ColDef<Row>[]>(
    () => [
      ...(portfolio
        ? ([
            {
              colId: 'agreementTitle',
              field: 'agreementTitle',
              headerName: 'Agreement',
              minWidth: 200,
              enableRowGroup: true,
            },
            {
              colId: 'counterparty',
              field: 'counterparty',
              headerName: 'Counterparty',
              minWidth: 150,
              enableRowGroup: true,
            },
          ] satisfies ColDef<Row>[])
        : []),
      {
        colId: 'label',
        field: 'label',
        headerName: 'Charge',
        minWidth: 250,
        flex: 1.4,
        // The chevron that opens the charge's trace: its clause, tests and history.
        cellRenderer: 'agGroupCellRenderer',
        valueFormatter: (p: ValueFormatterParams<Row>) => tidyLabel(String(p.value ?? '')),
        tooltipValueGetter: (p) => tidyLabel(String(p.value ?? '')),
      },
      {
        colId: 'kind',
        field: 'kind',
        headerName: 'Type',
        width: 130,
        enableRowGroup: true,
        valueFormatter: (p: ValueFormatterParams<Row>) =>
          p.value ? KIND_LABEL[p.value as Row['kind']] : '',
      },
      {
        colId: 'direction',
        field: 'direction',
        headerName: 'Direction',
        width: 110,
        enableRowGroup: true,
        cellRenderer: DirectionCell,
      },
      {
        colId: 'payerName',
        field: 'payerName',
        headerName: 'Payer',
        width: 160,
        enableRowGroup: true,
      },
      {
        colId: 'payeeName',
        field: 'payeeName',
        headerName: 'Payee',
        width: 160,
        enableRowGroup: true,
      },
      {
        // Not AG Grid's rightAligned type: its header puts the menu button first, which reads
        // as an empty column beside Amount. The cell aligns right; the header stays as the others.
        colId: 'amount',
        headerName: 'Amount',
        width: 245,
        headerTooltip: 'What is asked for or was paid, after any retainage held back',
        cellRenderer: AmountCell,
        valueGetter: (p) => minorNumber(p.data),
        aggFunc: sumAmounts,
        enableValue: true,
        cellClass: 'amount',
        valueFormatter: (p: ValueFormatterParams<Row>) =>
          p.value === null || p.value === undefined
            ? 'Variable'
            : money(String(Math.round(p.value as number)), p.data?.currency ?? currency),
      },
      { colId: 'currency', field: 'currency', headerName: 'Currency', hide: true },
      {
        colId: 'status',
        field: 'status',
        headerName: 'Status',
        width: 160,
        enableRowGroup: true,
        cellRenderer: StatusCell,
        // Filter and group on what the pill says, so "PayPal refused" can be picked out.
        filterValueGetter: (p) => (p.data ? chargeStatus(p.data).label : null),
        filter: 'agSetColumnFilter',
      },
      {
        colId: 'dueDate',
        field: 'dueDate',
        headerName: 'Due',
        width: 120,
        sort: 'asc',
        filter: 'agDateColumnFilter',
        valueFormatter: (p: ValueFormatterParams<Row>) => day(p.value as string | null),
        cellClass: 'num',
      },
      ...(portfolio
        ? ([
            {
              colId: 'daysOverdue',
              field: 'daysOverdue',
              headerName: 'Days late',
              width: 105,
              cellStyle: { textAlign: 'right' },
              filter: 'agNumberColumnFilter',
              cellClass: 'num',
              valueFormatter: (p: ValueFormatterParams<Row>) => (p.value ? String(p.value) : ''),
            },
          ] satisfies ColDef<Row>[])
        : []),
      {
        colId: 'paidOn',
        field: 'paidOn',
        headerName: 'Paid',
        width: 115,
        valueFormatter: (p: ValueFormatterParams<Row>) => (p.value ? day(p.value as string) : ''),
        cellClass: 'num',
      },
      {
        colId: 'clauseRefs',
        headerName: 'Clause',
        width: 150,
        valueGetter: (p) => uniqueRefs(p.data?.clauseRefs ?? []).join(', '),
        tooltipValueGetter: (p) => String(p.value ?? ''),
      },
      {
        colId: 'paypalProduct',
        field: 'paypalProduct',
        headerName: 'PayPal product',
        width: 160,
        enableRowGroup: true,
        valueFormatter: (p: ValueFormatterParams<Row>) =>
          p.value ? PRODUCT_LABEL[p.value as NonNullable<Row['paypalProduct']>] : '',
      },
      {
        colId: 'paypalRef',
        field: 'paypalRef',
        headerName: 'PayPal reference',
        width: 190,
        cellRenderer: PayPalRefCell,
      },
      {
        colId: 'basis',
        field: 'basis',
        headerName: 'How it was computed',
        minWidth: 220,
        hide: !portfolio,
        flex: 1,
      },
    ],
    [portfolio, currency],
  );

  const defaultColDef = useMemo<ColDef<Row>>(
    () => ({ sortable: true, resizable: true, filter: true, suppressHeaderFilterButton: true }),
    [],
  );

  return (
    <AgGridProvider modules={GRID_MODULES} licenseKey={GRID_LICENSE}>
      <div className="mb-2 flex items-center justify-end gap-4 text-[12.5px] text-ink-2">
        <span className="mr-auto text-ink-3">
          Open a charge to see its clause, tests and history.
        </span>
        {skipped > 0 && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showSkipped}
              onChange={(e) => setShowSkipped(e.target.checked)}
            />
            Show skipped periods ({skipped})
          </label>
        )}
        <button
          type="button"
          className="btn btn-quiet h-7 text-[12.5px]"
          disabled={!api}
          onClick={() => api && exportToExcel(api)}
          title="Every charge with its clause, how it was computed and its PayPal reference"
        >
          Export to Excel
        </button>
      </div>
      <div style={{ height }}>
        <AgGridReact<Row>
          ref={gridRef}
          theme={ledgerTheme}
          rowData={shown}
          columnDefs={columns}
          defaultColDef={defaultColDef}
          getRowId={(p) => p.data.id}
          rowGroupPanelShow={portfolio ? 'always' : 'never'}
          // Groups open; a charge's trace opens only when asked for.
          isGroupOpenByDefault={(p) => p.rowNode.group === true && p.level === 0}
          grandTotalRow={portfolio ? 'bottom' : undefined}
          suppressAggFuncInHeader
          animateRows
          cellSelection={portfolio}
          enableCharts={portfolio}
          sideBar={
            portfolio ? { toolPanels: ['columns', 'filters'], hiddenByDefault: true } : undefined
          }
          masterDetail
          detailCellRenderer={ChargeTrace}
          excelStyles={EXCEL_STYLES}
          onGridReady={(e) => {
            setApi(e.api);
            onReady?.(e);
          }}
          overlayNoRowsTemplate='<span style="color:#858d9e">No charges yet. They appear here once the plan goes live.</span>'
        />
      </div>
    </AgGridProvider>
  );
}
