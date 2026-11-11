'use client';

import type { LedgerRow } from '@clausework/core';
import {
  type AgAiHarnessSetup,
  type AgAiPromptStarter,
  type AgDataSourcesDefinition,
  type AgReportState,
  AgStudioAiModule,
  type AgStudioApi,
  createAiHarness,
  directLlmRunner,
  studioTheme,
} from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { useMemo, useRef } from 'react';
import { api as clausework } from '@/lib/api';
import {
  atRisk,
  chargeStatus,
  chartAmount,
  day,
  daysBetween,
  isAwaitingPayment,
  money,
  STATUS_LABEL,
  tidyLabel,
  uniqueRefs,
} from '@/lib/format';
import { claudeAdapter } from './claude-adapter';

const LICENSE = process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE;
const MODULES = [AgStudioAiModule];
/** Studio's chat is our agent; it is named as one. */
const LOCALE = {
  panelTitleAi: 'Clausework agent',
  aiMessageInputPlaceholder: 'Ask about money owed, at risk or late...',
};

/** Matches the rest of the product: paper, ink, a verdigris accent, hairline rules. */
const theme = studioTheme.withParams({
  backgroundColor: '#ffffff',
  foregroundColor: '#16213a',
  accentColor: '#0d6b57',
  borderColor: '#e3e0d8',
  fontFamily: 'var(--font-geist), ui-sans-serif, system-ui, sans-serif',
  fontSize: 13.5,
  borderRadius: 8,
  // Seal, ink, PayPal blue, then quieter steps; red is last so it never stands for a routine status.
  chartPaletteFills1Color: '#0d6b57',
  chartPaletteFills2Color: '#26365c',
  chartPaletteFills3Color: '#0070e0',
  chartPaletteFills4Color: '#9aa1b0',
  chartPaletteFills5Color: '#c08a2b',
  chartPaletteFills6Color: '#7fa99b',
  chartPaletteFills7Color: '#b4232a',
});

/**
 * Starters worded around what an owner actually asks of their contracts. A chip sends exactly what
 * it shows; how to answer each lives in the agent's instructions, not in the person's message.
 */
const STARTERS: AgAiPromptStarter[] = [
  "What's at risk this month?",
  'Cash in and out by month',
  'Which clients owe escalator increases?',
].map((q) => ({ label: q, prompt: q }));

/** How the Clausework tools read in the chat, instead of their names. */
const TOOL_DISPLAY = {
  explain_charge: {
    label: ({ status }: { status: string }) => ({
      text:
        status === 'done'
          ? 'Read the clause behind the charge'
          : 'Reading the clause behind the charge',
    }),
  },
  remind_payer: {
    label: ({ status }: { status: string }) => ({
      text: status === 'done' ? 'PayPal reminder' : 'Sending a PayPal reminder',
    }),
  },
  whats_at_risk: {
    label: ({ status }: { status: string }) => ({
      text: status === 'done' ? 'Checked money at risk' : 'Checking money at risk',
    }),
  },
};

/** "Brightline × Northwind brand system…" reads as "Brightline × Northwind". */
function shortTitle(title: string): string {
  const [left, right] = title.split(' × ');
  if (!left || !right) return title.length > 32 ? `${title.slice(0, 31)}…` : title;
  return `${left} × ${right.split(/\s+/)[0]?.replace(/[,.;:]$/, '')}`;
}

/** The one currency every row is in, or null when they are mixed. */
function singleCurrency(rows: LedgerRow[]): string | null {
  const currencies = new Set(rows.map((r) => r.currency));
  return currencies.size === 1 ? ([...currencies][0] ?? null) : null;
}

/**
 * Charges as a Studio table. Studio charts need numbers, so `amount` is major units for display
 * only; every amount that moves money stays in minor units in the API.
 */
function sourcesFor(rows: LedgerRow[]): AgDataSourcesDefinition {
  // One currency across the ledger: amounts and axes carry its symbol. Mixed: plain numbers.
  const only = singleCurrency(rows);
  const amountFormat = only
    ? {
        format: 'currencyFormat' as const,
        formatOptions: {
          format: new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: only,
            maximumFractionDigits: 0,
          }),
        },
      }
    : { format: 'decimalFormat' as const };
  return {
    sources: [
      {
        id: 'charges',
        name: 'Charges',
        description:
          'Every charge, payout and hold compiled from the agreements, one row each. amount is net of any retainage held back; grossAmount is before it.',
        fields: [
          { id: 'id', name: 'Charge id', format: 'textFormat', hide: true },
          { id: 'agreementId', name: 'Agreement id', format: 'textFormat', hide: true },
          { id: 'agreementFull', name: 'Agreement (full title)', format: 'textFormat' },
          { id: 'agreement', name: 'Agreement', format: 'textFormat' },
          { id: 'counterparty', name: 'Counterparty', format: 'textFormat' },
          { id: 'charge', name: 'Charge', format: 'textFormat' },
          { id: 'kind', name: 'Type', format: 'textFormat' },
          { id: 'status', name: 'Status', format: 'textFormat' },
          { id: 'problem', name: 'PayPal refusal', format: 'textFormat' },
          { id: 'atRisk', name: 'At risk', format: 'textFormat' },
          { id: 'direction', name: 'Direction', format: 'textFormat' },
          { id: 'payer', name: 'Payer', format: 'textFormat' },
          { id: 'payee', name: 'Payee', format: 'textFormat' },
          { id: 'amount', name: 'Amount', blankValue: 'Variable', ...amountFormat },
          { id: 'grossAmount', name: 'Before retainage', ...amountFormat },
          { id: 'currency', name: 'Currency', format: 'textFormat' },
          { id: 'dueDate', name: 'Due', format: 'textFormat' },
          { id: 'dueMonth', name: 'Due month', format: 'textFormat' },
          { id: 'paidOn', name: 'Paid on', format: 'textFormat' },
          { id: 'daysOverdue', name: 'Days late', format: 'integerFormat' },
          { id: 'clause', name: 'Clause', format: 'textFormat' },
          { id: 'paypalProduct', name: 'PayPal product', format: 'textFormat' },
          { id: 'paypalRef', name: 'PayPal reference', format: 'textFormat' },
        ],
        // Skipped periods carry no money; they would only add zero-height bars.
        data: rows
          .filter((r) => r.status !== 'cancelled')
          .map((r) => ({
            id: r.id,
            agreementId: r.agreementId,
            agreementFull: r.agreementTitle,
            // The parties' names are enough to tell agreements apart in a legend or a narrow column.
            agreement: shortTitle(r.agreementTitle),
            counterparty: r.counterparty,
            charge: tidyLabel(r.label),
            kind: r.kind,
            status: chargeStatus(r).label,
            problem: r.problem,
            atRisk: atRisk(r) ? 'Yes' : 'No',
            direction:
              r.direction === 'in'
                ? 'Money in'
                : r.direction === 'out'
                  ? 'Money out'
                  : 'Between others',
            payer: r.payerName,
            payee: r.payeeName,
            amount: r.amount === null ? null : chartAmount(r.amount, r.currency),
            grossAmount: r.grossAmount === null ? null : chartAmount(r.grossAmount, r.currency),
            currency: r.currency,
            // As people read it; dueMonth keeps a sortable form for grouping by month.
            dueDate: r.dueDate ? day(r.dueDate) : null,
            dueMonth: r.dueDate ? r.dueDate.slice(0, 7) : null,
            paidOn: r.paidOn,
            daysOverdue: r.daysOverdue,
            clause: uniqueRefs(r.clauseRefs).join(', '),
            paypalProduct: r.paypalProduct,
            paypalRef: r.paypalRef,
          })),
      },
    ],
  };
}

/** The opening report. `narrow` screens open with the chat folded so the charts get the width. */
const initialState = (narrow: boolean, currency: string | null): AgReportState => {
  const amountUnit = currency ? `Amount (${currencySymbol(currency)})` : 'Amount';
  return {
    pages: [
      {
        id: 'main',
        widgets: {
          // Money in and money out side by side, never stacked into one total.
          'by-month': {
            type: 'column-chart-grouped',
            dataMapping: {
              categoryKey: [{ id: 'charges.dueMonth' }],
              valueKey: [{ id: 'charges.amount', aggregation: 'sum' }],
              legendKey: [{ id: 'charges.direction' }],
            },
            format: {
              title: { enabled: true, text: 'In and out by month' },
              // Studio abbreviates axis numbers ("20K"); the axis title says what they are in.
              style: { custom: { valueAxis: { title: { enabled: true, text: amountUnit } } } },
            },
          },
          'by-status': {
            type: 'donut-chart',
            dataMapping: {
              categoryKey: [{ id: 'charges.status' }],
              valueKey: [{ id: 'charges.amount', aggregation: 'sum' }],
            },
            format: { title: { enabled: true, text: 'By status' } },
          },
          charges: {
            type: 'grid',
            dataMapping: {
              cols: [
                { id: 'charges.charge' },
                { id: 'charges.status' },
                { id: 'charges.amount' },
                { id: 'charges.dueDate' },
                { id: 'charges.counterparty' },
                { id: 'charges.clause' },
              ],
            },
            format: { title: { enabled: true, text: 'Charges' }, style: { columnAutoSize: true } },
          },
        },
        widgetLayout: {
          'by-month': { xTrack: 0, yTrack: 0, xSpan: 14, ySpan: 18 },
          'by-status': { xTrack: 14, yTrack: 0, xSpan: 10, ySpan: 18 },
          charges: { xTrack: 0, yTrack: 18, xSpan: 24, ySpan: 26 },
        },
      },
    ],
    selectedPageId: 'main',
    // The agent and the canvas lead; the editing panels stay a click away.
    panels: {
      ai: { collapsed: narrow, width: 300 },
      filters: { collapsed: true },
      edit: { collapsed: true },
      data: { collapsed: true },
    },
  };
};

/** "$" for USD, "€" for EUR: the symbol people expect beside an amount. */
function currencySymbol(currency: string): string {
  const part = new Intl.NumberFormat('en-US', { style: 'currency', currency })
    .formatToParts(0)
    .find((p) => p.type === 'currency');
  return part?.value ?? currency;
}

/** The tools that reach Clausework itself. Everything else the agent does stays inside Studio. */
function clauseworkTools(
  api: AgStudioApi,
  live: { current: { rows: LedgerRow[]; today: string } },
) {
  // Read at call time: Studio keeps the tools it was given, while the ledger keeps refreshing.
  const rowById = (id: string) => live.current.rows.find((r) => r.id === id);
  return [
    api.defineAiTool({
      name: 'explain_charge',
      description:
        'Explain why a charge exists: the clause it comes from (quoted exactly), the obligation, and how the amount was computed. Takes the charge id from the charges table.',
      params: (s) =>
        s.object({ chargeId: s.string({ description: 'The id column of the charges table' }) }),
      execute: async ({ chargeId }, ctx) => {
        const row = rowById(chargeId);
        if (!row) return ctx.error(`No charge with id ${chargeId}.`);
        const detail = await clausework.agreement(row.agreementId);
        const plan = detail.version?.plan;
        const clauses = plan?.clauses.filter((c) => row.clauseIds.includes(c.id)) ?? [];
        return ctx.success(
          `${row.label} (${money(row.amount, row.currency)}, ${STATUS_LABEL[row.status]}) comes from ${clauses.map((c) => `${c.ref}: "${c.quote}"`).join(' ') || 'no recorded clause'}. ${row.basis ?? ''}`.trim(),
          { clauses, basis: row.basis },
        );
      },
    }),
    api.defineAiTool({
      name: 'remind_payer',
      description:
        'Send the payer a PayPal reminder for an issued or overdue invoice. Only for charges whose status is Issued or Overdue. Tell the user before calling it.',
      params: (s) =>
        s.object({ chargeId: s.string({ description: 'The id column of the charges table' }) }),
      execute: async ({ chargeId }, ctx) => {
        const row = rowById(chargeId);
        if (!row) return ctx.error(`No charge with id ${chargeId}.`);
        if (row.status !== 'issued' && row.status !== 'overdue') {
          return ctx.error(
            `${row.label} is ${STATUS_LABEL[row.status].toLowerCase()}; only issued or overdue invoices get reminders.`,
          );
        }
        // The model may only propose a reminder. Sending one contacts a real payer, so a person
        // confirms it here, in code, whatever the conversation said.
        const ok = window.confirm(
          `Send ${row.payerName} a PayPal reminder for "${row.label}" (${money(row.amount, row.currency)})?`,
        );
        if (!ok)
          return ctx.error(
            'The user chose not to send this reminder. Do not ask again unless they do.',
          );
        await clausework.remind(row.agreementId, row.id);
        return ctx.success(`Sent ${row.payerName} a PayPal reminder for ${row.label}.`);
      },
    }),
    api.defineAiTool({
      name: 'whats_at_risk',
      description:
        'List money at risk: overdue, failed or unclaimed charges, payments PayPal refused to move (with its reason; they are still owed and retried automatically), and money due to the user within the given number of days.',
      params: (s) =>
        s.object({ withinDays: s.number({ description: 'Look ahead this many days' }) }),
      execute: async ({ withinDays }, ctx) => {
        const { rows, today } = live.current;
        const risky = rows
          .filter((r) => {
            if (atRisk(r)) return true;
            if (!r.dueDate || !(isAwaitingPayment(r) || r.status === 'scheduled')) return false;
            const d = daysBetween(today, r.dueDate);
            return d >= 0 && d <= withinDays && r.direction === 'in';
          })
          .map((r) => ({
            chargeId: r.id,
            agreement: r.agreementTitle,
            charge: tidyLabel(r.label),
            counterparty: r.counterparty,
            status: chargeStatus(r).label,
            paypalRefusal: r.problem,
            amount: money(r.amount, r.currency),
            dueDate: r.dueDate,
            daysOverdue: r.daysOverdue,
            clause: uniqueRefs(r.clauseRefs).join(', '),
          }));
        return ctx.success(
          risky.length === 0
            ? 'Nothing is at risk in that window.'
            : `${risky.length} charges are at risk.`,
          { risky },
        );
      },
    }),
  ];
}

export default function StudioDashboard({ rows, today }: { rows: LedgerRow[]; today: string }) {
  const live = useRef({ rows, today });
  live.current = { rows, today };
  // The ledger is polled; Studio reloads its data only when a row actually changed.
  const fingerprint = JSON.stringify(rows);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the rows' content, not identity.
  const data = useMemo(() => sourcesFor(rows), [fingerprint]);

  // Read once: Studio takes its initial state when it is created.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the opening state is built once.
  const initial = useMemo(() => initialState(window.innerWidth < 1280, singleCurrency(rows)), []);

  // Studio reads `ai` once when it is created; the tools read live rows through the ref.
  const ai = useMemo<AgAiHarnessSetup>(() => {
    const adapter = claudeAdapter('/api/ai');
    return (params) => {
      // The setup callback is typed with Studio's core API; at runtime it is the full Studio API
      // that createAiHarness and defineAiTool expect.
      const api = params.api as AgStudioApi;
      return createAiHarness(api, ({ builtIn, tools }) => ({
        agents: [
          // Studio's own five agents, on Claude: they plan, query, and build pages and widgets.
          ...Object.values(builtIn).map((d) => directLlmRunner({ ...d, adapter })),
          // Ours leads. It knows the contracts and reaches Clausework, and hands dashboard building
          // to Studio's agents; the built-in lead would never delegate to it.
          directLlmRunner({
            id: 'clausework',
            name: 'Clausework',
            description:
              'Answers questions about contract money: what is owed, why, and what is at risk.',
            adapter,
            schema: (s) => s.undefined(),
            instructions: () =>
              [
                'You are the Clausework analyst. Every row in the charges table was compiled from a clause of a signed agreement and runs on PayPal.',
                `Today is ${live.current.today}. Amounts in the table are in major units of their currency.`,
                'Answer with numbers from the data, never estimates. When you explain a charge, call explain_charge and quote the clause exactly.',
                'For questions about late or at-risk money, call whats_at_risk with the rest of the month as the window unless the user names another. List each charge by agreement with the clause it comes from; a "PayPal refused" charge is still owed, so give PayPal\'s reason. When there is money at risk, ask the widget agent for a chart of it by counterparty.',
                'For cash in and out by month, ask the widget agent for a grouped column chart of amount by due month, split by direction, so money in and money out stand side by side.',
                'For escalator questions, find recurring charges whose amount rose between periods under an escalator clause, and show them with their clients in a grid.',
                'Use remind_payer only after telling the user which charge you will remind.',
                'Write dates the way people read them ("Nov 11, 2026"), never as 2026-11-11. Never name a tool, field id or internal key in a reply.',
                'For a chart, grid or page change, delegate to the page or widget agent with a precise request. Keep replies short and plain.',
                'The chat shows plain text and short lists only: never use markdown tables or headings.',
                'Open with a one-sentence answer, then the detail. Never print internal references such as @widget[...] or @field[...], widget ids, column ids or grid coordinates; name things the way the user sees them.',
                'Amounts in different currencies are never added together: when the currency column holds more than one value, group or filter by currency first.',
              ].join('\n'),
            tools: () => [
              tools.studio.viewSchema(),
              tools.studio.viewPage(),
              tools.studio.executeQuery(),
              ...clauseworkTools(api, live),
              tools.delegateTo(['planning', 'data', 'page', 'widget']),
            ],
          }),
        ],
        primary: 'clausework',
        promptStarters: STARTERS,
      }));
    };
  }, []);

  return (
    <AgStudioProvider modules={MODULES} licenseKey={LICENSE}>
      <AgStudio
        style={{ height: '100%' }}
        localeText={LOCALE}
        data={data}
        theme={theme}
        mode="edit"
        initialState={initial}
        ai={ai}
        aiToolDisplay={TOOL_DISPLAY}
      />
    </AgStudioProvider>
  );
}
