/**
 * What the API sends. Amounts are strings of minor units (JSON has no bigint): "1440000" is
 * $14,400.00 in USD. Dates are YYYY-MM-DD; timestamps are ISO 8601.
 */

import type { ClauseKind, ObligationKind, Party, PayPalProduct, Phase } from './plan.ts';
import type { Span } from './quote.ts';

export type Minor = string;

export type AgreementStatus =
  | 'reading'
  | 'compiling'
  | 'review'
  | 'active'
  | 'completed'
  | 'failed';

/** Where the agreement is, in the words the UI shows. */
export type Stage =
  | 'reading'
  | 'compiling'
  | 'failed'
  | 'needs_owner'
  | 'needs_review'
  | 'awaiting_approvals'
  | 'ready_to_activate'
  | 'awaiting_payer_setup'
  | 'live'
  | 'completed';

export interface PayPalInfo {
  mode: 'mock' | 'sandbox' | 'live';
  usageBilling: boolean;
  transactionSearch: boolean;
}

export interface SampleView {
  key: string;
  title: string;
  description: string;
  kind: 'contract' | 'thread' | 'history';
  /** For threads and histories: the sample agreement they belong to. */
  forSample: string | null;
}

export interface MetaView {
  paypal: PayPalInfo;
  /** The workspace's today, which the rules schedule against. */
  today: string;
  model: string | null;
  samples: SampleView[];
}

export interface Totals {
  /** Money collected from payers, to the owner. */
  collected: Minor;
  /** Money the owner paid out to others. */
  paidOut: Minor;
  /** Scheduled with a known amount, not yet due. */
  scheduled: Minor;
  overdue: Minor;
}

export interface AgreementSummary {
  id: string;
  title: string;
  status: AgreementStatus;
  stage: Stage;
  sourceKind: 'pdf' | 'text' | 'thread';
  sourceName: string;
  currency: string | null;
  ownerParty: string | null;
  /** Names of the other parties. */
  counterparties: string[];
  obligationCount: number;
  totals: Totals;
  nextCharge: { label: string; dueDate: string; amount: Minor | null } | null;
  approvals: { required: number; approved: number };
  createdAt: string;
  activatedAt: string | null;
  sampleKey: string | null;
}

export interface ClauseView {
  id: string;
  ref: string;
  kind: ClauseKind;
  quote: string;
  span: Span | null;
}

/** An obligation as JSON: the `Obligation` union with amounts as Minor strings. */
export type ObligationView = {
  kind: ObligationKind;
  key: string;
  title: string;
  clauseIds: string[];
  payer: string;
  payee: string;
  confidence: number;
  ambiguities: string[];
} & Record<string, unknown>;

export interface TestView {
  obligation: string;
  name: string;
  given: Record<string, number | Minor | null>;
  expect: Minor;
  actual: Minor | null;
  pass: boolean;
  error: string | null;
}

export interface IssueView {
  subject: string | null;
  code: string;
  message: string;
}

export interface FieldChangeView {
  field: string;
  before: unknown;
  after: unknown;
}

export interface DiffView {
  plan: FieldChangeView[];
  added: ObligationView[];
  removed: ObligationView[];
  changed: { key: string; title: string; changes: FieldChangeView[] }[];
  phases: { key: string; changes: FieldChangeView[] }[];
  affectedParties: string[];
  empty: boolean;
}

export interface PlanView {
  title: string;
  currency: string;
  effectiveDate: string | null;
  endDate: string | null;
  contractValue: Minor | null;
  parties: Party[];
  clauses: ClauseView[];
  phases: Phase[];
  obligations: ObligationView[];
}

export interface VersionView {
  id: string;
  version: number;
  origin: 'compile' | 'repair' | 'amendment' | 'edit';
  note: string | null;
  hash: string;
  createdAt: string;
  /** For amendments: from when the change applies. */
  effectiveFrom: string | null;
  plan: PlanView;
  tests: TestView[];
  issues: IssueView[];
  diff: DiffView | null;
  /** For amendments: the message it came from. */
  evidence: { source: string; quote: string; from: string | null; date: string | null } | null;
  /** The PayPal product each obligation runs on, by key; null when it is tracked, not moved. */
  products: Record<string, PayPalProduct | null>;
  /** Obligations the compiler was unsure about; the owner confirms or corrects each before going live. */
  unconfirmed: string[];
  /** How each obligation is explained in one line: "$3,000.00 a month, +3% each anniversary". */
  explanations: Record<string, string>;
}

export interface ApprovalView {
  decision: 'approved' | 'changes_requested';
  comment: string | null;
  at: string;
  versionId: string;
  /** True when the approval is for the version now under review. */
  current: boolean;
}

export interface PartyView extends Party {
  isOwner: boolean;
  /** True when the party pays or is paid under the plan, so must approve it. */
  mustApprove: boolean;
  approval: ApprovalView | null;
  /** The party's portal link. Only sent to the owner. */
  portalUrl: string | null;
}

export interface PhaseView extends Phase {
  /** Where the phase sits now, after any moves. */
  current: { start: string | null; end: string | null; completedOn: string | null };
  /** Set when the phase is waiting on a payment: the charge that gates it. */
  blockedBy: { chargeId: string; label: string; status: ChargeStatus } | null;
}

export type ChargeStatus =
  | 'scheduled'
  | 'awaiting_approval'
  | 'issued'
  | 'authorized'
  | 'paid'
  | 'overdue'
  | 'failed'
  | 'cancelled'
  | 'held'
  | 'released'
  | 'refunded'
  | 'unclaimed';

export interface ChargeView {
  id: string;
  agreementId: string;
  chargeKey: string;
  obligationKey: string;
  kind: ObligationKind;
  label: string;
  payer: string;
  payee: string;
  payerName: string;
  payeeName: string;
  /** What is asked for or was paid: net of any retainage withheld from it. */
  amount: Minor | null;
  /** The charge before retainage, when retainage was withheld (`amount` is then less). */
  grossAmount: Minor | null;
  currency: string;
  status: ChargeStatus;
  /**
   * Why PayPal would not move this money, when it refused (a payout short of funds, say). The
   * charge is still owed and is retried; show it as at risk, with this reason.
   */
  problem: string | null;
  issueDate: string | null;
  dueDate: string | null;
  paidOn: string | null;
  periodIndex: number | null;
  clauseIds: string[];
  /** "§3.2 Deposit" for each clause. */
  clauseRefs: string[];
  paypalProduct: PayPalProduct | null;
  paypalRef: string | null;
  /** How the amount was computed. */
  basis: string | null;
  /** Where the payer pays, when PayPal gave one. */
  payUrl: string | null;
  /** From the owner's side: money coming in, going out, or between others. */
  direction: 'in' | 'out' | 'other';
}

/** A charge in the portfolio ledger, across agreements. */
export interface LedgerRow extends ChargeView {
  agreementTitle: string;
  counterparty: string;
  daysOverdue: number | null;
}

/** What the payer must do on PayPal before the plan can run: approve a deposit, a subscription. */
export interface SetupStep {
  obligationKey: string;
  title: string;
  product: PayPalProduct;
  party: string;
  status: 'waiting' | 'done' | 'not_needed';
  /** PayPal's approval link. */
  actionUrl: string | null;
}

export interface EventView {
  id: string;
  actor: string;
  type: string;
  summary: string;
  clauseIds: string[];
  data: Record<string, unknown>;
  occurredOn: string;
  createdAt: string;
}

export interface DecisionView {
  id: string;
  trigger: { kind: string; summary: string } & Record<string, unknown>;
  proposal: {
    action: string;
    rationale: string;
    clauseId: string | null;
    clauseQuote: string | null;
  } & Record<string, unknown>;
  outcome: { status: 'executed' | 'rejected' | 'escalated' | 'no_action'; reason: string } & Record<
    string,
    unknown
  >;
  decidedBy: string;
  /** The day the decision was made. */
  occurredOn: string;
  createdAt: string;
}

export interface AgreementDetail {
  agreement: AgreementSummary & {
    sourceText: string;
    hasPdf: boolean;
    failure: string | null;
  };
  /** The version under review or running. Null while reading or compiling. */
  version: VersionView | null;
  /** The version all parties approved and that runs on PayPal. */
  liveVersionId: string | null;
  /** Obligations of the live version, which usage is recorded against while an amendment waits. */
  liveObligations: ObligationView[] | null;
  versions: Pick<
    VersionView,
    'id' | 'version' | 'origin' | 'note' | 'createdAt' | 'effectiveFrom'
  >[];
  parties: PartyView[];
  phases: PhaseView[];
  charges: ChargeView[];
  setup: SetupStep[];
  /** While reading: the clauses found so far, so they can highlight as they arrive. */
  progress: { step: string; clauses: ClauseView[] } | null;
}

export interface PortalView {
  agreementId: string;
  title: string;
  party: PartyView;
  owner: Party | null;
  stage: Stage;
  /** True when a plan is running on PayPal, even while an amendment awaits approval. */
  live: boolean;
  version: VersionView | null;
  /** Obligations this party pays or is paid under. */
  obligationKeys: string[];
  charges: ChargeView[];
  setup: SetupStep[];
  /** Payee statements: one line per payout, "$412 under §6.2: 15% of $2,746". */
  statements: {
    chargeId: string;
    date: string | null;
    amount: Minor;
    line: string;
    status: ChargeStatus;
  }[];
}

export interface AuditLeakView {
  kind:
    | 'unbilled'
    | 'underbilled'
    | 'overbilled'
    | 'escalator_misapplied'
    | 'duplicate'
    | 'after_termination'
    | 'unexplained';
  obligationKey: string | null;
  chargeId: string | null;
  clauseIds: string[];
  clauseRefs: string[];
  label: string;
  expected: Minor;
  actual: Minor;
  amount: Minor;
  owedTo: string | null;
  owedBy: string | null;
  transactionIds: string[];
  recovery: string;
}

export interface AuditView {
  id: string;
  agreementId: string | null;
  agreementTitle: string | null;
  status: 'matching' | 'done' | 'failed';
  perspective: string;
  sourceName: string;
  currency: string | null;
  failure: string | null;
  createdAt: string;
  report: {
    owedToYou: Minor;
    youOwe: Minor;
    expectedTotal: Minor;
    actualTotal: Minor;
    chargesChecked: number;
    transactionsChecked: number;
    leaks: AuditLeakView[];
  } | null;
  transactions: {
    id: string;
    date: string;
    amount: Minor;
    memo: string;
    matchedTo: string | null;
    reason: string | null;
  }[];
}

export interface LedgerAnswer {
  answer: string;
  /** AG Grid state to apply: filters, sort, grouping, visible columns. */
  grid: {
    filter: Record<string, unknown> | null;
    sort: { colId: string; sort: 'asc' | 'desc' }[];
    groupBy: string[];
    columns: string[] | null;
  };
}
