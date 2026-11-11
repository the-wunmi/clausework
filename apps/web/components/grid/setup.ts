'use client';

import { AgChartsEnterpriseModule } from 'ag-charts-enterprise';
import { themeQuartz } from 'ag-grid-community';
import { AllEnterpriseModule } from 'ag-grid-enterprise';

/** Registered once per page through `AgGridProvider`. */
export const GRID_MODULES = [AllEnterpriseModule.with(AgChartsEnterpriseModule)];

/** AG Grid dressed as a ledger page: paper header, hairline rules, ink type, verdigris accent. */
export const ledgerTheme = themeQuartz.withParams({
  backgroundColor: '#ffffff',
  foregroundColor: '#16213a',
  accentColor: '#0d6b57',
  borderColor: '#ebe9e3',
  chromeBackgroundColor: '#faf9f6',
  headerBackgroundColor: '#faf9f6',
  headerTextColor: '#4a5468',
  headerFontWeight: 500,
  headerFontSize: 12.5,
  fontFamily: 'var(--font-geist), ui-sans-serif, system-ui, sans-serif',
  fontSize: 13.5,
  rowHeight: 44,
  headerHeight: 38,
  spacing: 7,
  borderRadius: 7,
  wrapperBorderRadius: 10,
  wrapperBorder: { color: '#dedbd2' },
  rowHoverColor: '#f7f6f1',
  selectedRowBackgroundColor: '#e2efe9',
  oddRowBackgroundColor: '#ffffff',
  columnBorder: false,
  rowBorder: { color: '#efede8' },
});

export const GRID_LICENSE = process.env.NEXT_PUBLIC_AG_GRID_LICENSE;
