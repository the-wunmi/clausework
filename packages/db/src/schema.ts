import { toJson } from '@clausework/core';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const money = (name: string) => bigint(name, { mode: 'bigint' });
const day = (name: string) => date(name, { mode: 'string' });
/** Postgres JSON, written so that amounts held as bigint are stored as strings of minor units. */
const jsonb = customType<{ data: unknown; driverData: string }>({
  dataType: () => 'jsonb',
  toDriver: toJson,
});
const agreementRef = () =>
  uuid('agreement_id')
    .notNull()
    .references(() => agreements.id, { onDelete: 'cascade' });

// ── Agreements and their plans ─────────────────────────────────────────────

export const agreementStatus = pgEnum('agreement_status', [
  'reading',
  'compiling',
  'review',
  'active',
  'completed',
  'failed',
]);

export const agreements = pgTable('agreements', {
  id: id(),
  title: text('title').notNull(),
  status: agreementStatus('status').notNull().default('reading'),
  sourceKind: text('source_kind', { enum: ['pdf', 'text', 'thread'] }).notNull(),
  sourceName: text('source_name').notNull(),
  /** The document's text, exactly as clause spans index into it. */
  sourceText: text('source_text').notNull(),
  /** The original PDF, base64, when one was uploaded. */
  sourcePdf: text('source_pdf'),
  /** Which party the workspace owner is. Set during review; "you" in every view. */
  ownerParty: text('owner_party'),
  currentVersionId: uuid('current_version_id'),
  /** The version all parties approved and that runs on PayPal. */
  liveVersionId: uuid('live_version_id'),
  failure: text('failure'),
  /** While reading and compiling: what the compiler is doing and the clauses found so far. */
  progress: jsonb('progress'),
  /** Names the current compile, so each compile or recompile is its own durable workflow. */
  compileRun: text('compile_run'),
  /** Set when a sample was used, so the UI can offer the matching demo inputs. */
  sampleKey: text('sample_key'),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const planVersions = pgTable(
  'plan_versions',
  {
    id: id(),
    agreementId: agreementRef(),
    version: integer('version').notNull(),
    plan: jsonb('plan').notNull(),
    /** sha256 of the canonical plan. Approvals bind to it. */
    hash: text('hash').notNull(),
    origin: text('origin', { enum: ['compile', 'repair', 'amendment', 'edit'] }).notNull(),
    note: text('note'),
    /** Clause id to { start, end } in the source text, or null when the quote was not found. */
    spans: jsonb('spans').notNull(),
    testResults: jsonb('test_results').notNull(),
    issues: jsonb('issues').notNull(),
    /** Against the previous version. */
    diff: jsonb('diff'),
    /** For amendments: the message the change came from. */
    evidence: jsonb('evidence'),
    /** For amendments: the day the change applies from. Earlier periods keep the old terms. */
    effectiveFrom: day('effective_from'),
    model: jsonb('model'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('plan_versions_agreement_version').on(t.agreementId, t.version)],
);

export const partyLinks = pgTable(
  'party_links',
  {
    id: id(),
    agreementId: agreementRef(),
    partyKey: text('party_key').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('party_links_party').on(t.agreementId, t.partyKey),
    uniqueIndex('party_links_token').on(t.tokenHash),
  ],
);

/** Append-only. The latest row per party and version is that party's position. */
export const approvals = pgTable(
  'approvals',
  {
    id: id(),
    agreementId: agreementRef(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => planVersions.id),
    planHash: text('plan_hash').notNull(),
    partyKey: text('party_key').notNull(),
    decision: text('decision', { enum: ['approved', 'changes_requested'] }).notNull(),
    comment: text('comment'),
    createdAt: createdAt(),
  },
  (t) => [index('approvals_agreement').on(t.agreementId, t.versionId)],
);

/** Where each phase really sits. The plan holds the original dates; this holds the current ones. */
export const phaseDates = pgTable(
  'phase_dates',
  {
    agreementId: agreementRef(),
    phaseKey: text('phase_key').notNull(),
    start: day('start'),
    end: day('end'),
    /** Set when the phase was delivered and accepted. */
    completedOn: day('completed_on'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.agreementId, t.phaseKey] })],
);

// ── Money ──────────────────────────────────────────────────────────────────

export const bindings = pgTable(
  'paypal_bindings',
  {
    id: id(),
    agreementId: agreementRef(),
    obligationKey: text('obligation_key').notNull(),
    product: text('product').notNull(),
    /** Plan, subscription, order, meter or wallet id at PayPal. */
    paypalId: text('paypal_id').notNull(),
    role: text('role').notNull(),
    state: text('state').notNull(),
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('paypal_bindings_role').on(t.agreementId, t.obligationKey, t.role),
    index('paypal_bindings_paypal_id').on(t.paypalId),
  ],
);

export const chargeStatus = pgEnum('charge_status', [
  'scheduled',
  'awaiting_approval',
  'issued',
  'authorized',
  'paid',
  'overdue',
  'failed',
  'cancelled',
  'held',
  'released',
  'refunded',
  'unclaimed',
]);

/**
 * Every charge, payout, hold and credit the plan raises. Its status mirrors PayPal; the money that
 * actually moved is in `ledger_entries`.
 */
export const charges = pgTable(
  'charges',
  {
    id: id(),
    agreementId: agreementRef(),
    /** The plan version whose terms this charge follows; an amendment re-lays charges from its date. */
    versionId: uuid('version_id'),
    /** `ProjectedCharge.id`, or an event-raised key such as `late_fee:phase_2:1`. */
    chargeKey: text('charge_key').notNull(),
    obligationKey: text('obligation_key').notNull(),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    payer: text('payer').notNull(),
    payee: text('payee').notNull(),
    amount: money('amount'),
    currency: text('currency').notNull(),
    status: chargeStatus('status').notNull().default('scheduled'),
    issueDate: day('issue_date'),
    dueDate: day('due_date'),
    paidOn: day('paid_on'),
    periodIndex: integer('period_index'),
    periodStart: day('period_start'),
    periodEnd: day('period_end'),
    clauseIds: jsonb('clause_ids').$type<string[]>().notNull(),
    paypalProduct: text('paypal_product'),
    paypalRef: text('paypal_ref'),
    /** What PayPal sent back, kept for the activity view. */
    paypalData: jsonb('paypal_data'),
    /** How the amount was computed: "6 × $40.00 above 20 hours (§3.3)". */
    basis: text('basis'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('charges_key').on(t.agreementId, t.chargeKey),
    index('charges_paypal_ref').on(t.paypalRef),
    index('charges_status').on(t.status, t.dueDate),
  ],
);

/** Append-only record of money that moved. Corrected with reversing entries, never edited. */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: id(),
    agreementId: agreementRef(),
    chargeId: uuid('charge_id').references(() => charges.id),
    obligationKey: text('obligation_key').notNull(),
    kind: text('kind', {
      enum: ['collected', 'paid_out', 'refunded', 'credited', 'held', 'released', 'reversal'],
    }).notNull(),
    fromParty: text('from_party').notNull(),
    toParty: text('to_party').notNull(),
    amount: money('amount').notNull(),
    currency: text('currency').notNull(),
    paypalRef: text('paypal_ref'),
    /** One movement at PayPal is recorded once, whatever retries or webhooks repeat it. */
    dedupeKey: text('dedupe_key').notNull(),
    memo: text('memo').notNull(),
    occurredOn: day('occurred_on').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ledger_entries_dedupe').on(t.dedupeKey),
    index('ledger_entries_agreement').on(t.agreementId, t.occurredOn),
  ],
);

export const usageEvents = pgTable(
  'usage_events',
  {
    id: id(),
    agreementId: agreementRef(),
    obligationKey: text('obligation_key').notNull(),
    quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
    occurredOn: day('occurred_on').notNull(),
    note: text('note'),
    idempotencyKey: text('idempotency_key').notNull(),
    paypalRef: text('paypal_ref'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('usage_events_idem').on(t.idempotencyKey)],
);

// ── What happened, and why ─────────────────────────────────────────────────

/** Append-only activity for an agreement: the story the UI tells. */
export const events = pgTable(
  'events',
  {
    id: id(),
    agreementId: agreementRef(),
    /** system, agent, owner, paypal, or party:<key>. */
    actor: text('actor').notNull(),
    type: text('type').notNull(),
    summary: text('summary').notNull(),
    clauseIds: jsonb('clause_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    data: jsonb('data').notNull().default(sql`'{}'::jsonb`),
    occurredOn: day('occurred_on').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('events_agreement').on(t.agreementId, t.createdAt)],
);

/** Each runtime decision: what triggered it, what the agent saw, what it chose, what code allowed. */
export const agentDecisions = pgTable(
  'agent_decisions',
  {
    id: id(),
    agreementId: agreementRef(),
    /** One decision per situation: a phase's gate on a start date, an invoice's month overdue. */
    triggerKey: text('trigger_key').notNull(),
    /** The day the decision was made. */
    occurredOn: day('occurred_on').notNull(),
    trigger: jsonb('trigger').notNull(),
    view: jsonb('view').notNull(),
    proposal: jsonb('proposal'),
    outcome: jsonb('outcome').notNull(),
    decidedBy: text('decided_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('agent_decisions_agreement').on(t.agreementId, t.createdAt),
    uniqueIndex('agent_decisions_trigger').on(t.agreementId, t.triggerKey),
  ],
);

export const audits = pgTable('audits', {
  id: id(),
  agreementId: uuid('agreement_id').references(() => agreements.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['matching', 'done', 'failed'] }).notNull(),
  perspective: text('perspective').notNull(),
  sourceName: text('source_name').notNull(),
  transactions: jsonb('transactions').notNull(),
  matches: jsonb('matches'),
  report: jsonb('report'),
  failure: text('failure'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── Plumbing ───────────────────────────────────────────────────────────────

export const webhookEvents = pgTable('webhook_events', {
  /** PayPal's event id. Deliveries repeat; this is how they are recognised. */
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  resourceId: text('resource_id'),
  payload: jsonb('payload').notNull(),
  verified: boolean('verified').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
});

/** Uses of costly routes (model calls) per hour, so a limit holds across server processes. */
export const rateWindows = pgTable(
  'rate_windows',
  {
    bucket: text('bucket').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    uses: integer('uses').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] })],
);
