/**
 * Everything clausework asks of PayPal, as deterministic adapter calls. The engine never builds a
 * PayPal request itself, and no model ever calls these: a model proposes a typed action, code
 * validates it against the approved plan, then calls exactly one of these methods.
 *
 * Amounts cross this boundary as bigint minor units with a currency. Implementations convert to
 * PayPal's decimal strings. Every call that creates or moves money takes a `requestId`, sent as
 * `PayPal-Request-Id` where PayPal supports it and used as the natural key where it does not
 * (invoice numbers, payout batch ids, usage event transaction ids), so a retry never doubles money.
 */

export interface Money {
  amount: bigint;
  currency: string;
}

export interface PartyRef {
  name: string;
  email: string;
}

export type GatewayMode = 'mock' | 'sandbox' | 'live';

export interface Capabilities {
  /** Usage-Based Billing v1 (limited release). When false, usage is billed through Invoicing. */
  usageBilling: boolean;
  /** Transaction Search (reporting). When false, audits take an uploaded activity export. */
  transactionSearch: boolean;
}

// ── Orders and payments ──────────────────────────────────────────────────────

export interface CreateOrderInput {
  requestId: string;
  intent: 'AUTHORIZE' | 'CAPTURE';
  amount: Money;
  /** Shown to the buyer. Cites the clause: "Deposit, §3.2 (30% of project fees)". */
  description: string;
  /** Our charge id. Comes back on every webhook about this order. */
  customId: string;
  /** Unique per order at PayPal; a second order with the same invoice id is refused. */
  invoiceId: string;
  payee: PartyRef;
  returnUrl: string;
  cancelUrl: string;
}

export interface OrderResult {
  id: string;
  status: 'CREATED' | 'APPROVED' | 'COMPLETED' | 'VOIDED' | 'PAYER_ACTION_REQUIRED' | 'SAVED';
  /** Where the payer approves. Null once approved. */
  approveUrl: string | null;
}

export interface AuthorizationResult {
  id: string;
  status: 'CREATED' | 'CAPTURED' | 'DENIED' | 'PARTIALLY_CAPTURED' | 'VOIDED' | 'PENDING';
  /** End of the honor period (3 days); a capture after it may be declined. */
  honorUntil: string | null;
  expiresAt: string | null;
}

export interface CaptureResult {
  id: string;
  status: 'COMPLETED' | 'DECLINED' | 'PARTIALLY_REFUNDED' | 'PENDING' | 'REFUNDED' | 'FAILED';
  amount: Money;
}

export interface RefundResult {
  id: string;
  status: 'CANCELLED' | 'FAILED' | 'PENDING' | 'COMPLETED';
  amount: Money;
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export interface CreatePlanInput {
  requestId: string;
  productName: string;
  productDescription: string;
  planName: string;
  amount: Money;
  interval: 'WEEK' | 'MONTH' | 'YEAR';
  intervalCount: number;
  /** null for until cancelled. */
  cycles: number | null;
}

export interface PlanResult {
  productId: string;
  planId: string;
  status: 'CREATED' | 'ACTIVE' | 'INACTIVE';
}

export interface CreateSubscriptionInput {
  requestId: string;
  planId: string;
  subscriber: PartyRef;
  /** ISO timestamp of the first billing. */
  startTime: string;
  customId: string;
  returnUrl: string;
  cancelUrl: string;
}

export type SubscriptionStatus =
  | 'APPROVAL_PENDING'
  | 'APPROVED'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface SubscriptionResult {
  id: string;
  status: SubscriptionStatus;
  approveUrl: string | null;
  nextBillingTime: string | null;
}

// ── Invoicing ────────────────────────────────────────────────────────────────

export interface InvoiceLine {
  name: string;
  /** Shown under the line: the clause and how the amount was computed. */
  description: string;
  /** Up to two decimals ("6", "1.5"). */
  quantity: string;
  unitAmount: Money;
}

export interface CreateInvoiceInput {
  requestId: string;
  /** Our own number, unique per merchant: CW-<agreement>-<charge>. */
  invoiceNumber: string;
  invoicer: PartyRef;
  recipient: PartyRef;
  lines: InvoiceLine[];
  /** YYYY-MM-DD, for Clausework's records. PayPal dates the invoice itself. */
  invoiceDate: string;
  dueDate: string;
  note: string;
  /** Our charge id. */
  reference: string;
}

export type InvoiceStatus =
  | 'DRAFT'
  | 'SENT'
  | 'SCHEDULED'
  | 'PAID'
  | 'MARKED_AS_PAID'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'PARTIALLY_PAID'
  | 'PARTIALLY_REFUNDED'
  | 'MARKED_AS_REFUNDED'
  | 'UNPAID'
  | 'PAYMENT_PENDING';

export interface InvoiceResult {
  id: string;
  number: string;
  status: InvoiceStatus;
  /** Where the recipient pays. */
  payerViewUrl: string | null;
  amount: Money;
  paid: Money | null;
}

// ── Payouts ──────────────────────────────────────────────────────────────────

export interface PayoutItemInput {
  /** Our charge id; unique within the batch. */
  senderItemId: string;
  receiver: PartyRef;
  amount: Money;
  /** Shown to the recipient: the statement line. */
  note: string;
}

export interface CreatePayoutInput {
  /** Unique for 30 days at PayPal. */
  senderBatchId: string;
  emailSubject: string;
  emailMessage: string;
  items: PayoutItemInput[];
}

export type PayoutItemStatus =
  | 'SUCCESS'
  | 'FAILED'
  | 'PENDING'
  | 'UNCLAIMED'
  | 'RETURNED'
  | 'ONHOLD'
  | 'BLOCKED'
  | 'REFUNDED'
  | 'REVERSED';

export interface PayoutResult {
  batchId: string;
  batchStatus: 'DENIED' | 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'CANCELED';
  items: { itemId: string; senderItemId: string; status: PayoutItemStatus }[];
}

// ── Usage-Based Billing ──────────────────────────────────────────────────────

export interface MeterInput {
  /** lower_snake_case, unique per merchant. */
  metricCode: string;
  name: string;
  customer: PartyRef & { externalId: string };
  /** Our id for the usage subscription. */
  externalSubscriptionId: string;
  /** Price above the included units, per unit. */
  rate: Money;
  includedUnits: number;
  interval: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  /** Alert when usage in a period reaches this many units. */
  alertAtUnits: number | null;
}

export interface MeterResult {
  metricId: string;
  externalSubscriptionId: string;
  alertCode: string | null;
}

export interface UsageEventInput {
  /** Idempotency key at PayPal. */
  transactionId: string;
  externalSubscriptionId: string;
  metricCode: string;
  quantity: number;
  timestamp: string;
}

// ── Reporting ────────────────────────────────────────────────────────────────

export interface ReportedTransaction {
  id: string;
  /** When it happened, as an ISO instant in UTC. */
  at: string;
  /** Positive for money in, negative for money out. */
  amount: Money;
  counterpartyEmail: string | null;
  counterpartyName: string | null;
  invoiceId: string | null;
  customField: string | null;
  note: string;
  status: string;
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

/** A PayPal webhook event, as delivered. */
export interface WebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  summary?: string;
  create_time: string;
  resource: Record<string, unknown>;
}

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  rawBody: string;
}

// ── The gateway ──────────────────────────────────────────────────────────────

export interface PayPalGateway {
  readonly mode: GatewayMode;
  capabilities(): Promise<Capabilities>;

  createOrder(input: CreateOrderInput): Promise<OrderResult>;
  getOrder(
    orderId: string,
  ): Promise<OrderResult & { authorizationId: string | null; captureId: string | null }>;
  authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationResult>;
  captureAuthorization(
    authorizationId: string,
    requestId: string,
    amount: Money | null,
  ): Promise<CaptureResult>;
  /** For a CAPTURE-intent order the payer has approved. */
  captureOrder(orderId: string, requestId: string): Promise<CaptureResult>;
  reauthorize(authorizationId: string, requestId: string): Promise<AuthorizationResult>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<void>;
  refundCapture(
    captureId: string,
    requestId: string,
    amount: Money | null,
    note: string,
  ): Promise<RefundResult>;

  createPlan(input: CreatePlanInput): Promise<PlanResult>;
  /** Changes the price of the plan's regular cycle, for every subscription on it. */
  updatePlanPrice(planId: string, amount: Money): Promise<void>;
  createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionResult>;
  getSubscription(subscriptionId: string): Promise<SubscriptionResult>;
  cancelSubscription(subscriptionId: string, reason: string): Promise<void>;

  createAndSendInvoice(input: CreateInvoiceInput): Promise<InvoiceResult>;
  getInvoice(invoiceId: string): Promise<InvoiceResult>;
  remindInvoice(invoiceId: string, note: string): Promise<void>;
  cancelInvoice(invoiceId: string, note: string): Promise<void>;

  createPayout(input: CreatePayoutInput): Promise<PayoutResult>;
  getPayout(batchId: string): Promise<PayoutResult>;

  /** Only when `capabilities().usageBilling`. */
  createMeter(input: MeterInput): Promise<MeterResult>;
  recordUsage(event: UsageEventInput): Promise<void>;

  /** Only when `capabilities().transactionSearch`. From `from` up to `until`, at most 31 days. */
  searchTransactions(from: Date, until: Date): Promise<ReportedTransaction[]>;

  /** Checks a delivery really came from PayPal. */
  verifyWebhook(request: WebhookRequest): Promise<boolean>;
}

/** A PayPal call that failed. `retryable` is false when repeating the same request cannot help. */
export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issue: string | null,
    readonly debugId: string | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PayPalError';
  }
}
