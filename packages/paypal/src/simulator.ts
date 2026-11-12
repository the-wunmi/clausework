import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalJson } from '@clausework/core';
import type {
  AuthorizationResult,
  Capabilities,
  CaptureResult,
  CreateInvoiceInput,
  CreateOrderInput,
  CreatePayoutInput,
  CreatePlanInput,
  CreateSubscriptionInput,
  InvoiceResult,
  InvoiceStatus,
  MeterInput,
  MeterResult,
  Money,
  OrderResult,
  PartyRef,
  PayoutItemStatus,
  PayoutResult,
  PayPalGateway,
  PlanResult,
  RefundResult,
  ReportedTransaction,
  SubscriptionResult,
  SubscriptionStatus,
  UsageEventInput,
  WebhookEvent,
  WebhookRequest,
} from './gateway.ts';
import { PayPalError } from './gateway.ts';
import { quantityString, toPayPal } from './money.ts';

/**
 * A stateful stand-in for the PayPal sandbox, for tests. It keeps PayPal's ids, statuses,
 * lifecycles and webhook shapes, so the engine runs the same code paths as against the sandbox.
 * The control methods (`approveOrder`, `payInvoice`, …) play the buyer and the payee, which in
 * the sandbox would be a person clicking through PayPal's pages.
 */

// ── Storage ──────────────────────────────────────────────────────────────────

export interface SimStore {
  get(id: string): Promise<{ type: string; data: unknown } | null>;
  put(id: string, type: string, data: unknown): Promise<void>;
  list(type: string): Promise<{ id: string; data: unknown }[]>;
}

export class MemorySimStore implements SimStore {
  readonly #rows = new Map<string, { type: string; data: unknown }>();

  async get(id: string) {
    const row = this.#rows.get(id);
    return row ? { type: row.type, data: structuredClone(row.data) } : null;
  }

  async put(id: string, type: string, data: unknown) {
    this.#rows.set(id, { type, data: structuredClone(data) });
  }

  async list(type: string) {
    return [...this.#rows]
      .filter(([, row]) => row.type === type)
      .map(([id, row]) => ({ id, data: structuredClone(row.data) }));
  }
}

/** Money as the simulator stores it: JSON has no bigint. */
interface StoredMoney {
  minor: string;
  currency: string;
}

const store = (m: Money): StoredMoney => ({ minor: m.amount.toString(), currency: m.currency });
const load = (m: StoredMoney): Money => ({ amount: BigInt(m.minor), currency: m.currency });
const pp = (m: StoredMoney) => toPayPal(load(m));

interface SimOrder {
  id: string;
  intent: 'AUTHORIZE' | 'CAPTURE';
  status: OrderResult['status'];
  amount: StoredMoney;
  description: string;
  customId: string;
  invoiceId: string;
  payee: PartyRef;
  payer: PartyRef | null;
  authorizationId: string | null;
  captureId: string | null;
  createTime: string;
}

interface SimAuthorization {
  id: string;
  orderId: string;
  status: AuthorizationResult['status'];
  amount: StoredMoney;
  captured: string;
  customId: string;
  invoiceId: string;
  createTime: string;
  /** Set when this authorization replaced an earlier one. */
  reauthorizedFrom: string | null;
}

interface SimCapture {
  id: string;
  status: CaptureResult['status'];
  amount: StoredMoney;
  refunded: string;
  customId: string;
  invoiceId: string;
  orderId: string;
  authorizationId: string | null;
  payer: PartyRef | null;
  createTime: string;
}

interface SimRefund {
  id: string;
  captureId: string;
  status: RefundResult['status'];
  amount: StoredMoney;
  customId: string;
  invoiceId: string;
  payer: PartyRef | null;
  createTime: string;
}

interface SimPlan {
  id: string;
  productId: string;
  name: string;
  status: PlanResult['status'];
  amount: StoredMoney;
  interval: CreatePlanInput['interval'];
  intervalCount: number;
  cycles: number | null;
}

interface SimSubscription {
  id: string;
  planId: string;
  status: SubscriptionStatus;
  subscriber: PartyRef;
  payer: PartyRef | null;
  customId: string;
  startTime: string;
  cyclesCompleted: number;
  failedPayments: number;
  nextBillingTime: string | null;
  lastPayment: { amount: StoredMoney; time: string } | null;
  createTime: string;
}

interface SimSale {
  id: string;
  subscriptionId: string;
  amount: StoredMoney;
  customId: string;
  payer: PartyRef | null;
  createTime: string;
}

interface SimInvoice {
  id: string;
  number: string;
  status: InvoiceStatus;
  invoicer: PartyRef;
  recipient: PartyRef;
  lines: { name: string; description: string; quantity: string; unitAmount: StoredMoney }[];
  total: StoredMoney;
  paid: StoredMoney | null;
  invoiceDate: string;
  dueDate: string;
  note: string;
  reference: string;
  reminders: string[];
  payer: PartyRef | null;
  paidTime: string | null;
  createTime: string;
}

interface SimPayoutItem {
  itemId: string;
  senderItemId: string;
  status: PayoutItemStatus;
  receiver: PartyRef;
  amount: StoredMoney;
  note: string;
  time: string;
}

interface SimPayout {
  batchId: string;
  senderBatchId: string;
  status: PayoutResult['batchStatus'];
  emailSubject: string;
  items: SimPayoutItem[];
  createTime: string;
}

interface SimMeter {
  externalSubscriptionId: string;
  metricId: string;
  metricCode: string;
  name: string;
  customer: MeterInput['customer'];
  rate: StoredMoney;
  includedUnits: number;
  interval: MeterInput['interval'];
  alertAtUnits: number | null;
  alertCode: string | null;
  /** Hundredths of a unit per period, keyed by period. */
  usage: Record<string, number>;
  alerted: string[];
}

type SimType =
  | 'order'
  | 'authorization'
  | 'capture'
  | 'refund'
  | 'product'
  | 'plan'
  | 'subscription'
  | 'sale'
  | 'invoice'
  | 'payout'
  | 'payout_item'
  | 'meter'
  | 'usage_event'
  | 'idempotency'
  | 'webhook';

export type SimObjectType = Exclude<SimType, 'idempotency' | 'usage_event'>;

export type SimOperation =
  | 'createOrder'
  | 'authorize'
  | 'capture'
  | 'refund'
  | 'invoice'
  | 'payout'
  | 'subscription';

export interface PayPalSimulatorOptions {
  store: SimStore;
  /** Origin of the approval and payment links it hands out; no page serves them. */
  publicUrl: string;
  now?: () => Date;
  usageBilling?: boolean;
  /** Payout items settle (or go unclaimed) as soon as the batch is created. Default true. */
  autoProcessPayouts?: boolean;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
function code(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALNUM[(bytes[i] as number) % ALNUM.length];
  return out;
}

const DAY = 86_400_000;
const HONOR_DAYS = 3;
const EXPIRY_DAYS = 29;

function fail(status: number, issue: string, message: string): never {
  throw new PayPalError(message, status, issue, `sim-${code(12).toLowerCase()}`, false);
}

const minorOf = (m: StoredMoney) => BigInt(m.minor);

export class PayPalSimulator implements PayPalGateway {
  readonly mode = 'mock' as const;
  readonly #store: SimStore;
  readonly #publicUrl: string;
  readonly #now: () => Date;
  readonly #usageBilling: boolean;
  readonly #autoProcessPayouts: boolean;
  readonly #sinks: ((e: WebhookEvent) => Promise<void>)[] = [];
  readonly #failures = new Map<SimOperation, { status: number; issue: string }>();
  readonly #withoutAccount = new Set<string>();

  constructor(opts: PayPalSimulatorOptions) {
    this.#store = opts.store;
    this.#publicUrl = opts.publicUrl.replace(/\/$/, '');
    this.#now = opts.now ?? (() => new Date());
    this.#usageBilling = opts.usageBilling ?? true;
    this.#autoProcessPayouts = opts.autoProcessPayouts ?? true;
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  /** Every webhook the simulator sends goes to each sink, awaited, after the state change. */
  onWebhook(sink: (e: WebhookEvent) => Promise<void>): void {
    this.#sinks.push(sink);
  }

  /** The next call of this kind fails as PayPal would, e.g. `failNext('capture', 'INSTRUMENT_DECLINED')`. */
  failNext(operation: SimOperation, issue: string, status = 422): void {
    this.#failures.set(operation, { status, issue });
  }

  /** Payouts to this address go UNCLAIMED, as for a recipient with no PayPal account. */
  markReceiverWithoutAccount(email: string): void {
    this.#withoutAccount.add(email.toLowerCase());
  }

  async listObjects(type: SimObjectType): Promise<{ id: string; data: unknown }[]> {
    return this.#store.list(type);
  }

  #iso(offsetMs = 0): string {
    return new Date(this.#now().getTime() + offsetMs).toISOString();
  }

  #maybeFail(operation: SimOperation): void {
    const failure = this.#failures.get(operation);
    if (!failure) return;
    this.#failures.delete(operation);
    fail(failure.status, failure.issue, `Simulated PayPal failure: ${failure.issue}`);
  }

  async #get<T>(type: SimType, id: string): Promise<T | null> {
    const row = await this.#store.get(`${type}:${id}`);
    return row ? (row.data as T) : null;
  }

  async #must<T>(type: SimType, id: string, label: string): Promise<T> {
    const found = await this.#get<T>(type, id);
    if (!found) fail(404, 'RESOURCE_NOT_FOUND', `${label} ${id} does not exist`);
    return found;
  }

  #put(type: SimType, id: string, data: unknown): Promise<void> {
    return this.#store.put(`${type}:${id}`, type, data);
  }

  /** PayPal-Request-Id: a repeated key returns the object the first request made. */
  async #idempotent<T>(
    scope: string,
    requestId: string,
    create: () => Promise<{ id: string; value: T }>,
    read: (id: string) => Promise<T>,
  ): Promise<T> {
    const key = `${scope}:${requestId}`;
    const seen = await this.#get<{ objectId: string }>('idempotency', key);
    if (seen) return read(seen.objectId);
    const { id, value } = await create();
    await this.#put('idempotency', key, { objectId: id });
    return value;
  }

  async #emit(
    eventType: string,
    resourceType: string,
    summary: string,
    resource: Record<string, unknown>,
  ): Promise<void> {
    const event: WebhookEvent = {
      id: `WH-${code(17)}-${code(17)}`,
      event_type: eventType,
      resource_type: resourceType,
      summary,
      create_time: this.#iso(),
      resource,
    };
    await this.#put('webhook', event.id, event);
    for (const sink of this.#sinks) await sink(structuredClone(event));
  }

  async capabilities(): Promise<Capabilities> {
    return { usageBilling: this.#usageBilling, transactionSearch: true };
  }

  async verifyWebhook(request: WebhookRequest): Promise<boolean> {
    let id: unknown;
    try {
      id = (JSON.parse(request.rawBody) as { id?: unknown }).id;
    } catch {
      return false;
    }
    if (typeof id !== 'string') return false;
    const emitted = await this.#get<WebhookEvent>('webhook', id);
    // The store may reorder keys (Postgres jsonb does), so compare canonically.
    return (
      emitted !== null && canonicalJson(emitted) === canonicalJson(JSON.parse(request.rawBody))
    );
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  async createOrder(input: CreateOrderInput): Promise<OrderResult> {
    return this.#idempotent(
      'order',
      input.requestId,
      async () => {
        this.#maybeFail('createOrder');
        if (input.amount.amount <= 0n)
          fail(422, 'CANNOT_BE_ZERO_OR_NEGATIVE', 'Amount must be positive');
        const others = await this.#store.list('order');
        if (others.some((o) => (o.data as SimOrder).invoiceId === input.invoiceId)) {
          fail(422, 'DUPLICATE_INVOICE_ID', `Invoice id ${input.invoiceId} was used before`);
        }
        const order: SimOrder = {
          id: code(17),
          intent: input.intent,
          status: 'CREATED',
          amount: store(input.amount),
          description: input.description.slice(0, 127),
          customId: input.customId,
          invoiceId: input.invoiceId,
          payee: input.payee,
          payer: null,
          authorizationId: null,
          captureId: null,
          createTime: this.#iso(),
        };
        await this.#put('order', order.id, order);
        return { id: order.id, value: this.#orderResult(order) };
      },
      async (id) => this.#orderResult(await this.#must<SimOrder>('order', id, 'Order')),
    );
  }

  #orderResult(o: SimOrder): OrderResult {
    return {
      id: o.id,
      status: o.status,
      approveUrl: o.status === 'CREATED' ? `${this.#publicUrl}/sim/checkout/order/${o.id}` : null,
    };
  }

  #orderResource(o: SimOrder): Record<string, unknown> {
    return {
      id: o.id,
      intent: o.intent,
      status: o.status,
      create_time: o.createTime,
      purchase_units: [
        {
          reference_id: 'default',
          custom_id: o.customId,
          invoice_id: o.invoiceId,
          description: o.description,
          amount: pp(o.amount),
          payee: { email_address: o.payee.email },
        },
      ],
      payer: o.payer
        ? { email_address: o.payer.email, name: { given_name: o.payer.name } }
        : undefined,
    };
  }

  async getOrder(orderId: string) {
    const o = await this.#must<SimOrder>('order', orderId, 'Order');
    return { ...this.#orderResult(o), authorizationId: o.authorizationId, captureId: o.captureId };
  }

  /** The buyer approves on PayPal's page. */
  async approveOrder(orderId: string, payer: PartyRef): Promise<OrderResult> {
    const o = await this.#must<SimOrder>('order', orderId, 'Order');
    if (o.status !== 'CREATED')
      fail(422, 'ORDER_ALREADY_APPROVED', `Order ${orderId} is ${o.status}`);
    o.status = 'APPROVED';
    o.payer = payer;
    await this.#put('order', o.id, o);
    await this.#emit(
      'CHECKOUT.ORDER.APPROVED',
      'checkout-order',
      `An order has been approved by buyer`,
      this.#orderResource(o),
    );
    return this.#orderResult(o);
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationResult> {
    return this.#idempotent(
      'authorize',
      requestId,
      async () => {
        this.#maybeFail('authorize');
        const o = await this.#must<SimOrder>('order', orderId, 'Order');
        if (o.intent !== 'AUTHORIZE')
          fail(422, 'ACTION_DOES_NOT_MATCH_INTENT', 'Order intent is CAPTURE');
        if (o.status !== 'APPROVED')
          fail(422, 'ORDER_NOT_APPROVED', 'The payer has not approved this order');
        const auth: SimAuthorization = {
          id: code(17),
          orderId,
          status: 'CREATED',
          amount: o.amount,
          captured: '0',
          customId: o.customId,
          invoiceId: o.invoiceId,
          createTime: this.#iso(),
          reauthorizedFrom: null,
        };
        o.status = 'COMPLETED';
        o.authorizationId = auth.id;
        await this.#put('authorization', auth.id, auth);
        await this.#put('order', o.id, o);
        await this.#emit(
          'PAYMENT.AUTHORIZATION.CREATED',
          'authorization',
          `Payment authorization of ${pp(auth.amount).value} ${auth.amount.currency} created`,
          this.#authResource(auth),
        );
        return { id: auth.id, value: this.#authResult(auth) };
      },
      async (id) =>
        this.#authResult(await this.#must<SimAuthorization>('authorization', id, 'Authorization')),
    );
  }

  #authResult(a: SimAuthorization): AuthorizationResult {
    const created = Date.parse(a.createTime);
    return {
      id: a.id,
      status: a.status,
      honorUntil: new Date(created + HONOR_DAYS * DAY).toISOString(),
      expiresAt: new Date(created + EXPIRY_DAYS * DAY).toISOString(),
    };
  }

  #authResource(a: SimAuthorization): Record<string, unknown> {
    return {
      id: a.id,
      status: a.status,
      amount: pp(a.amount),
      custom_id: a.customId,
      invoice_id: a.invoiceId,
      create_time: a.createTime,
      expiration_time: this.#authResult(a).expiresAt,
      supplementary_data: { related_ids: { order_id: a.orderId } },
    };
  }

  async captureAuthorization(
    authorizationId: string,
    requestId: string,
    amount: Money | null,
  ): Promise<CaptureResult> {
    return this.#idempotent(
      'capture',
      requestId,
      async () => {
        this.#maybeFail('capture');
        const a = await this.#must<SimAuthorization>(
          'authorization',
          authorizationId,
          'Authorization',
        );
        if (a.status === 'VOIDED') fail(422, 'AUTHORIZATION_VOIDED', 'Authorization was voided');
        if (a.status === 'CAPTURED')
          fail(422, 'PREVIOUSLY_CAPTURED', 'Authorization was already captured');
        if (this.#now().getTime() > Date.parse(a.createTime) + EXPIRY_DAYS * DAY) {
          a.status = 'VOIDED';
          await this.#put('authorization', a.id, a);
          fail(422, 'AUTHORIZATION_EXPIRED', 'Authorization has expired');
        }
        const remaining = minorOf(a.amount) - BigInt(a.captured);
        const take = amount?.amount ?? remaining;
        if (amount && amount.currency !== a.amount.currency)
          fail(422, 'AUTH_CURRENCY_MISMATCH', 'Currency differs from the authorization');
        if (take > remaining || take <= 0n)
          fail(422, 'MAX_CAPTURE_AMOUNT_EXCEEDED', 'Capture exceeds the authorized amount');
        const o = await this.#must<SimOrder>('order', a.orderId, 'Order');
        const capture: SimCapture = {
          id: code(17),
          status: 'COMPLETED',
          amount: { minor: take.toString(), currency: a.amount.currency },
          refunded: '0',
          customId: a.customId,
          invoiceId: a.invoiceId,
          orderId: a.orderId,
          authorizationId: a.id,
          payer: o.payer,
          createTime: this.#iso(),
        };
        a.captured = (BigInt(a.captured) + take).toString();
        // Captures here are always final: what is left of the authorization is released.
        a.status =
          take === remaining && BigInt(a.captured) === minorOf(a.amount)
            ? 'CAPTURED'
            : 'PARTIALLY_CAPTURED';
        o.captureId = capture.id;
        await this.#put('capture', capture.id, capture);
        await this.#put('authorization', a.id, a);
        await this.#put('order', o.id, o);
        await this.#emitCapture(capture);
        return { id: capture.id, value: this.#captureResult(capture) };
      },
      async (id) => this.#captureResult(await this.#must<SimCapture>('capture', id, 'Capture')),
    );
  }

  async captureOrder(orderId: string, requestId: string): Promise<CaptureResult> {
    return this.#idempotent(
      'capture-order',
      requestId,
      async () => {
        this.#maybeFail('capture');
        const o = await this.#must<SimOrder>('order', orderId, 'Order');
        if (o.intent !== 'CAPTURE')
          fail(422, 'ACTION_DOES_NOT_MATCH_INTENT', 'Order intent is AUTHORIZE');
        if (o.status === 'COMPLETED')
          fail(422, 'ORDER_ALREADY_CAPTURED', 'Order was already captured');
        if (o.status !== 'APPROVED')
          fail(422, 'ORDER_NOT_APPROVED', 'The payer has not approved this order');
        const capture: SimCapture = {
          id: code(17),
          status: 'COMPLETED',
          amount: o.amount,
          refunded: '0',
          customId: o.customId,
          invoiceId: o.invoiceId,
          orderId: o.id,
          authorizationId: null,
          payer: o.payer,
          createTime: this.#iso(),
        };
        o.status = 'COMPLETED';
        o.captureId = capture.id;
        await this.#put('capture', capture.id, capture);
        await this.#put('order', o.id, o);
        await this.#emitCapture(capture);
        return { id: capture.id, value: this.#captureResult(capture) };
      },
      async (id) => this.#captureResult(await this.#must<SimCapture>('capture', id, 'Capture')),
    );
  }

  #captureResult(c: SimCapture): CaptureResult {
    return { id: c.id, status: c.status, amount: load(c.amount) };
  }

  #emitCapture(c: SimCapture): Promise<void> {
    return this.#emit(
      'PAYMENT.CAPTURE.COMPLETED',
      'capture',
      `Payment completed for ${pp(c.amount).value} ${c.amount.currency}`,
      {
        id: c.id,
        status: c.status,
        amount: pp(c.amount),
        final_capture: true,
        custom_id: c.customId,
        invoice_id: c.invoiceId,
        create_time: c.createTime,
        supplementary_data: {
          related_ids: {
            order_id: c.orderId,
            ...(c.authorizationId ? { authorization_id: c.authorizationId } : {}),
          },
        },
      },
    );
  }

  async reauthorize(authorizationId: string, requestId: string): Promise<AuthorizationResult> {
    return this.#idempotent(
      'reauthorize',
      requestId,
      async () => {
        const a = await this.#must<SimAuthorization>(
          'authorization',
          authorizationId,
          'Authorization',
        );
        const age = this.#now().getTime() - Date.parse(a.createTime);
        if (age < HONOR_DAYS * DAY)
          fail(422, 'REAUTHORIZATION_TOO_SOON', 'Still inside the honor period');
        if (age > EXPIRY_DAYS * DAY)
          fail(422, 'AUTHORIZATION_EXPIRED', 'Authorization has expired');
        if (a.reauthorizedFrom)
          fail(422, 'MAX_NUMBER_OF_REAUTHORIZATIONS_EXCEEDED', 'Already reauthorized once');
        if (a.status !== 'CREATED')
          fail(422, 'AUTHORIZATION_ALREADY_CAPTURED', `Authorization is ${a.status}`);
        const next: SimAuthorization = {
          ...a,
          id: code(17),
          createTime: this.#iso(),
          reauthorizedFrom: a.id,
        };
        a.status = 'VOIDED';
        const o = await this.#must<SimOrder>('order', a.orderId, 'Order');
        o.authorizationId = next.id;
        await this.#put('authorization', a.id, a);
        await this.#put('authorization', next.id, next);
        await this.#put('order', o.id, o);
        await this.#emit(
          'PAYMENT.AUTHORIZATION.CREATED',
          'authorization',
          'Payment reauthorized',
          this.#authResource(next),
        );
        return { id: next.id, value: this.#authResult(next) };
      },
      async (id) =>
        this.#authResult(await this.#must<SimAuthorization>('authorization', id, 'Authorization')),
    );
  }

  async voidAuthorization(authorizationId: string, requestId: string): Promise<void> {
    await this.#idempotent(
      'void',
      requestId,
      async () => {
        const a = await this.#must<SimAuthorization>(
          'authorization',
          authorizationId,
          'Authorization',
        );
        if (a.status === 'CAPTURED')
          fail(422, 'PREVIOUSLY_CAPTURED', 'A captured authorization cannot be voided');
        if (a.status !== 'VOIDED') {
          a.status = 'VOIDED';
          await this.#put('authorization', a.id, a);
          await this.#emit(
            'PAYMENT.AUTHORIZATION.VOIDED',
            'authorization',
            'A payment authorization was voided',
            this.#authResource(a),
          );
        }
        return { id: a.id, value: undefined };
      },
      async () => undefined,
    );
  }

  async refundCapture(
    captureId: string,
    requestId: string,
    amount: Money | null,
    note: string,
  ): Promise<RefundResult> {
    return this.#idempotent(
      'refund',
      requestId,
      async () => {
        this.#maybeFail('refund');
        const c = await this.#must<SimCapture>('capture', captureId, 'Capture');
        const remaining = minorOf(c.amount) - BigInt(c.refunded);
        const take = amount?.amount ?? remaining;
        if (take <= 0n || take > remaining)
          fail(422, 'REFUND_AMOUNT_EXCEEDED', 'Refund exceeds what is left of the capture');
        const refund: SimRefund = {
          id: code(17),
          captureId,
          status: 'COMPLETED',
          amount: { minor: take.toString(), currency: c.amount.currency },
          customId: c.customId,
          invoiceId: c.invoiceId,
          payer: c.payer,
          createTime: this.#iso(),
        };
        c.refunded = (BigInt(c.refunded) + take).toString();
        c.status = BigInt(c.refunded) === minorOf(c.amount) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        await this.#put('refund', refund.id, refund);
        await this.#put('capture', c.id, c);
        await this.#emit(
          'PAYMENT.CAPTURE.REFUNDED',
          'refund',
          `A ${pp(refund.amount).value} ${refund.amount.currency} capture payment was refunded`,
          {
            id: refund.id,
            status: refund.status,
            amount: pp(refund.amount),
            note_to_payer: note,
            custom_id: refund.customId,
            invoice_id: refund.invoiceId,
            create_time: refund.createTime,
            links: [
              {
                rel: 'up',
                method: 'GET',
                href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}`,
              },
            ],
          },
        );
        return {
          id: refund.id,
          value: { id: refund.id, status: refund.status, amount: load(refund.amount) },
        };
      },
      async (id) => {
        const r = await this.#must<SimRefund>('refund', id, 'Refund');
        return { id: r.id, status: r.status, amount: load(r.amount) };
      },
    );
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  async createPlan(input: CreatePlanInput): Promise<PlanResult> {
    return this.#idempotent(
      'plan',
      input.requestId,
      async () => {
        const productId = `PROD-${code(17)}`;
        await this.#put('product', productId, {
          id: productId,
          name: input.productName,
          description: input.productDescription,
          type: 'SERVICE',
        });
        const plan: SimPlan = {
          id: `P-${code(24)}`,
          productId,
          name: input.planName,
          status: 'ACTIVE',
          amount: store(input.amount),
          interval: input.interval,
          intervalCount: input.intervalCount,
          cycles: input.cycles,
        };
        await this.#put('plan', plan.id, plan);
        return { id: plan.id, value: { productId, planId: plan.id, status: plan.status } };
      },
      async (id) => {
        const plan = await this.#must<SimPlan>('plan', id, 'Plan');
        return { productId: plan.productId, planId: plan.id, status: plan.status };
      },
    );
  }

  async updatePlanPrice(planId: string, amount: Money): Promise<void> {
    const plan = await this.#must<SimPlan>('plan', planId, 'Plan');
    if (amount.currency !== plan.amount.currency)
      fail(422, 'CURRENCY_MISMATCH', 'A plan keeps its currency');
    plan.amount = store(amount);
    await this.#put('plan', plan.id, plan);
    await this.#emit(
      'BILLING.PLAN.PRICING-CHANGE.ACTIVATED',
      'plan',
      'A billing plan pricing change has been activated',
      {
        id: plan.id,
        product_id: plan.productId,
        status: plan.status,
        billing_cycles: [
          { tenure_type: 'REGULAR', sequence: 1, pricing_scheme: { fixed_price: pp(plan.amount) } },
        ],
      },
    );
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionResult> {
    return this.#idempotent(
      'subscription',
      input.requestId,
      async () => {
        this.#maybeFail('subscription');
        await this.#must<SimPlan>('plan', input.planId, 'Plan');
        const sub: SimSubscription = {
          id: `I-${code(12)}`,
          planId: input.planId,
          status: 'APPROVAL_PENDING',
          subscriber: input.subscriber,
          payer: null,
          customId: input.customId,
          startTime: input.startTime,
          cyclesCompleted: 0,
          failedPayments: 0,
          nextBillingTime: null,
          lastPayment: null,
          createTime: this.#iso(),
        };
        await this.#put('subscription', sub.id, sub);
        return { id: sub.id, value: this.#subscriptionResult(sub) };
      },
      async (id) =>
        this.#subscriptionResult(
          await this.#must<SimSubscription>('subscription', id, 'Subscription'),
        ),
    );
  }

  #subscriptionResult(s: SimSubscription): SubscriptionResult {
    return {
      id: s.id,
      status: s.status,
      approveUrl:
        s.status === 'APPROVAL_PENDING'
          ? `${this.#publicUrl}/sim/checkout/subscription/${s.id}`
          : null,
      nextBillingTime: s.nextBillingTime,
    };
  }

  async #subscriptionResource(s: SimSubscription): Promise<Record<string, unknown>> {
    const plan = await this.#must<SimPlan>('plan', s.planId, 'Plan');
    return {
      id: s.id,
      plan_id: s.planId,
      status: s.status,
      custom_id: s.customId,
      start_time: s.startTime,
      create_time: s.createTime,
      subscriber: {
        email_address: (s.payer ?? s.subscriber).email,
        name: { given_name: (s.payer ?? s.subscriber).name },
      },
      billing_info: {
        outstanding_balance: { currency_code: plan.amount.currency, value: '0.00' },
        cycle_executions: [
          {
            tenure_type: 'REGULAR',
            sequence: 1,
            cycles_completed: s.cyclesCompleted,
            cycles_remaining:
              plan.cycles === null ? 0 : Math.max(0, plan.cycles - s.cyclesCompleted),
            total_cycles: plan.cycles ?? 0,
          },
        ],
        last_payment: s.lastPayment
          ? { amount: pp(s.lastPayment.amount), time: s.lastPayment.time }
          : undefined,
        next_billing_time: s.nextBillingTime ?? undefined,
        failed_payments_count: s.failedPayments,
      },
    };
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionResult> {
    return this.#subscriptionResult(
      await this.#must<SimSubscription>('subscription', subscriptionId, 'Subscription'),
    );
  }

  async cancelSubscription(subscriptionId: string, reason: string): Promise<void> {
    const s = await this.#must<SimSubscription>('subscription', subscriptionId, 'Subscription');
    if (s.status === 'CANCELLED' || s.status === 'EXPIRED') return;
    s.status = 'CANCELLED';
    s.nextBillingTime = null;
    await this.#put('subscription', s.id, s);
    await this.#emit(
      'BILLING.SUBSCRIPTION.CANCELLED',
      'subscription',
      `Subscription cancelled: ${reason}`,
      await this.#subscriptionResource(s),
    );
  }

  #advance(time: string, plan: SimPlan, cycles: number): string {
    const d = new Date(time);
    const n = plan.intervalCount * cycles;
    if (plan.interval === 'WEEK') d.setUTCDate(d.getUTCDate() + 7 * n);
    else if (plan.interval === 'MONTH') d.setUTCMonth(d.getUTCMonth() + n);
    else d.setUTCFullYear(d.getUTCFullYear() + n);
    return d.toISOString();
  }

  /**
   * The subscriber approves on PayPal's page. Like PayPal, the first cycle is billed at the start
   * time: straight away when it has passed, otherwise by `billDueCycles` once it arrives.
   */
  async approveSubscription(subscriptionId: string, payer: PartyRef): Promise<SubscriptionResult> {
    const s = await this.#must<SimSubscription>('subscription', subscriptionId, 'Subscription');
    if (s.status !== 'APPROVAL_PENDING')
      fail(422, 'SUBSCRIPTION_STATUS_INVALID', `Subscription is ${s.status}`);
    s.status = 'ACTIVE';
    s.payer = payer;
    s.nextBillingTime = s.startTime;
    await this.#put('subscription', s.id, s);
    await this.#emit(
      'BILLING.SUBSCRIPTION.ACTIVATED',
      'subscription',
      'Subscription activated',
      await this.#subscriptionResource(s),
    );
    await this.billDueCycles(subscriptionId);
    return this.#subscriptionResult(
      await this.#must<SimSubscription>('subscription', subscriptionId, 'Subscription'),
    );
  }

  /** Bills every cycle whose billing time has come, as PayPal's own scheduler would. */
  async billDueCycles(subscriptionId: string): Promise<number> {
    let billed = 0;
    for (let i = 0; i < 120; i++) {
      const s = await this.#must<SimSubscription>('subscription', subscriptionId, 'Subscription');
      if (s.status !== 'ACTIVE' || !s.nextBillingTime || s.nextBillingTime > this.#iso()) break;
      await this.billSubscription(subscriptionId);
      billed++;
    }
    return billed;
  }

  /** Bills the next cycle at the plan's current price. */
  async billSubscription(subscriptionId: string): Promise<{ saleId: string; amount: Money }> {
    const s = await this.#must<SimSubscription>('subscription', subscriptionId, 'Subscription');
    if (s.status !== 'ACTIVE')
      fail(422, 'SUBSCRIPTION_STATUS_INVALID', `Subscription is ${s.status}`);
    const plan = await this.#must<SimPlan>('plan', s.planId, 'Plan');
    const time = this.#iso();
    const sale: SimSale = {
      id: code(17),
      subscriptionId: s.id,
      amount: plan.amount,
      customId: s.customId,
      payer: s.payer,
      createTime: time,
    };
    s.cyclesCompleted += 1;
    s.lastPayment = { amount: plan.amount, time };
    s.failedPayments = 0;
    const done = plan.cycles !== null && s.cyclesCompleted >= plan.cycles;
    s.nextBillingTime = done ? null : this.#advance(s.startTime, plan, s.cyclesCompleted);
    if (done) s.status = 'EXPIRED';
    await this.#put('sale', sale.id, sale);
    await this.#put('subscription', s.id, s);
    await this.#emit(
      'PAYMENT.SALE.COMPLETED',
      'sale',
      `Payment completed for ${pp(sale.amount).value} ${sale.amount.currency}`,
      {
        id: sale.id,
        state: 'completed',
        amount: { total: pp(sale.amount).value, currency: sale.amount.currency },
        payment_mode: 'INSTANT_TRANSFER',
        billing_agreement_id: s.id,
        custom: s.customId,
        create_time: time,
        update_time: time,
      },
    );
    if (done) {
      await this.#emit(
        'BILLING.SUBSCRIPTION.EXPIRED',
        'subscription',
        'Subscription expired',
        await this.#subscriptionResource(s),
      );
    }
    return { saleId: sale.id, amount: load(sale.amount) };
  }

  async failSubscriptionPayment(subscriptionId: string): Promise<void> {
    const s = await this.#must<SimSubscription>('subscription', subscriptionId, 'Subscription');
    if (s.status !== 'ACTIVE')
      fail(422, 'SUBSCRIPTION_STATUS_INVALID', `Subscription is ${s.status}`);
    s.failedPayments += 1;
    await this.#put('subscription', s.id, s);
    await this.#emit(
      'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
      'subscription',
      'Subscription payment failed',
      await this.#subscriptionResource(s),
    );
  }

  // ── Invoicing ──────────────────────────────────────────────────────────────

  async createAndSendInvoice(input: CreateInvoiceInput): Promise<InvoiceResult> {
    const existing = (await this.#store.list('invoice')).find(
      (r) => (r.data as SimInvoice).number === input.invoiceNumber,
    );
    if (existing) return this.#invoiceResult(existing.data as SimInvoice);
    this.#maybeFail('invoice');
    if (input.lines.length === 0) fail(400, 'MISSING_REQUIRED_PARAMETER', 'An invoice needs items');
    const currency = input.lines[0]?.unitAmount.currency as string;
    let total = 0n;
    for (const l of input.lines) {
      if (l.unitAmount.currency !== currency)
        fail(422, 'CURRENCY_MISMATCH', 'All items share one currency');
      // Quantities carry up to two decimals; amounts round half up to the minor unit.
      const hundredths = BigInt(Math.round(Number(l.quantity) * 100));
      total += (l.unitAmount.amount * hundredths + 50n) / 100n;
    }
    const inv: SimInvoice = {
      id: `INV2-${code(4)}-${code(4)}-${code(4)}-${code(4)}`,
      number: input.invoiceNumber,
      status: 'SENT',
      invoicer: input.invoicer,
      recipient: input.recipient,
      lines: input.lines.map((l) => ({
        name: l.name,
        description: l.description,
        quantity: l.quantity,
        unitAmount: store(l.unitAmount),
      })),
      total: { minor: total.toString(), currency },
      paid: null,
      invoiceDate: input.invoiceDate,
      dueDate: input.dueDate,
      note: input.note,
      reference: input.reference,
      reminders: [],
      payer: null,
      paidTime: null,
      createTime: this.#iso(),
    };
    await this.#put('invoice', inv.id, inv);
    return this.#invoiceResult(inv);
  }

  #invoiceResult(inv: SimInvoice): InvoiceResult {
    return {
      id: inv.id,
      number: inv.number,
      status: inv.status,
      payerViewUrl: `${this.#publicUrl}/sim/invoice/${inv.id}`,
      amount: load(inv.total),
      paid: inv.paid ? load(inv.paid) : null,
    };
  }

  #invoiceResource(inv: SimInvoice): Record<string, unknown> {
    return {
      id: inv.id,
      status: inv.status,
      detail: {
        invoice_number: inv.number,
        reference: inv.reference,
        invoice_date: inv.invoiceDate,
        currency_code: inv.total.currency,
        note: inv.note,
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: inv.dueDate },
        metadata: { recipient_view_url: `${this.#publicUrl}/sim/invoice/${inv.id}` },
      },
      invoicer: { email_address: inv.invoicer.email },
      primary_recipients: [{ billing_info: { email_address: inv.recipient.email } }],
      items: inv.lines.map((l) => ({
        name: l.name,
        description: l.description,
        quantity: l.quantity,
        unit_amount: pp(l.unitAmount),
      })),
      amount: { currency_code: inv.total.currency, value: pp(inv.total).value },
      payments: inv.paid
        ? {
            paid_amount: pp(inv.paid),
            transactions: [
              {
                payment_id: inv.id.replaceAll('-', '').slice(4, 21),
                method: 'PAYPAL',
                payment_date: inv.paidTime?.slice(0, 10),
                amount: pp(inv.paid),
              },
            ],
          }
        : undefined,
    };
  }

  async getInvoice(invoiceId: string): Promise<InvoiceResult> {
    return this.#invoiceResult(await this.#must<SimInvoice>('invoice', invoiceId, 'Invoice'));
  }

  /** The recipient pays on PayPal's invoice page, in full unless an amount is given. */
  async payInvoice(invoiceId: string, payer: PartyRef, amount?: Money): Promise<InvoiceResult> {
    const inv = await this.#must<SimInvoice>('invoice', invoiceId, 'Invoice');
    if (!['SENT', 'UNPAID', 'PARTIALLY_PAID', 'SCHEDULED'].includes(inv.status)) {
      fail(422, 'INVALID_INVOICE_STATUS', `Invoice is ${inv.status}`);
    }
    const already = inv.paid ? minorOf(inv.paid) : 0n;
    const due = minorOf(inv.total) - already;
    const take = amount?.amount ?? due;
    if (take <= 0n || take > due)
      fail(422, 'PAYMENT_AMOUNT_EXCEEDED', 'Payment exceeds what is due');
    inv.paid = { minor: (already + take).toString(), currency: inv.total.currency };
    inv.status = already + take === minorOf(inv.total) ? 'PAID' : 'PARTIALLY_PAID';
    inv.payer = payer;
    inv.paidTime = this.#iso();
    await this.#put('invoice', inv.id, inv);
    if (inv.status === 'PAID') {
      await this.#emit(
        'INVOICING.INVOICE.PAID',
        'invoices',
        `An invoice was paid`,
        this.#invoiceResource(inv),
      );
    } else {
      await this.#emit(
        'INVOICING.INVOICE.UPDATED',
        'invoices',
        `An invoice was partially paid`,
        this.#invoiceResource(inv),
      );
    }
    return this.#invoiceResult(inv);
  }

  async remindInvoice(invoiceId: string, _note: string): Promise<void> {
    const inv = await this.#must<SimInvoice>('invoice', invoiceId, 'Invoice');
    if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status))
      fail(422, 'INVALID_INVOICE_STATUS', `Invoice is ${inv.status}`);
    const today = this.#iso().slice(0, 10);
    if (inv.reminders.filter((r) => r.startsWith(today)).length >= 2) {
      throw new PayPalError('At most two reminders a day', 429, 'RATE_LIMIT_REACHED', null, true);
    }
    inv.reminders.push(this.#iso());
    await this.#put('invoice', inv.id, inv);
  }

  async cancelInvoice(invoiceId: string, _note: string): Promise<void> {
    const inv = await this.#must<SimInvoice>('invoice', invoiceId, 'Invoice');
    if (inv.status === 'CANCELLED') return;
    if (inv.status === 'PAID' || inv.status === 'MARKED_AS_PAID')
      fail(422, 'CANT_CANCEL_PAID_INVOICE', 'A paid invoice cannot be cancelled');
    inv.status = 'CANCELLED';
    await this.#put('invoice', inv.id, inv);
    await this.#emit(
      'INVOICING.INVOICE.CANCELLED',
      'invoices',
      'An invoice was cancelled',
      this.#invoiceResource(inv),
    );
  }

  // ── Payouts ────────────────────────────────────────────────────────────────

  async createPayout(input: CreatePayoutInput): Promise<PayoutResult> {
    return this.#idempotent(
      'payout',
      input.senderBatchId,
      async () => {
        this.#maybeFail('payout');
        if (input.items.length === 0) fail(400, 'VALIDATION_ERROR', 'A payout needs items');
        const seen = new Set<string>();
        for (const i of input.items) {
          if (seen.has(i.senderItemId))
            fail(400, 'DUPLICATE_SENDER_ITEM_ID', `Item ${i.senderItemId} repeats`);
          seen.add(i.senderItemId);
        }
        const batch: SimPayout = {
          batchId: code(13),
          senderBatchId: input.senderBatchId,
          status: 'PENDING',
          emailSubject: input.emailSubject,
          items: input.items.map((i) => ({
            itemId: code(13),
            senderItemId: i.senderItemId,
            status: 'PENDING',
            receiver: i.receiver,
            amount: store(i.amount),
            note: i.note,
            time: this.#iso(),
          })),
          createTime: this.#iso(),
        };
        await this.#savePayout(batch);
        if (this.#autoProcessPayouts) {
          batch.status = 'SUCCESS';
          await this.#savePayout(batch);
          await this.#emit(
            'PAYMENT.PAYOUTSBATCH.SUCCESS',
            'payouts',
            'Payouts batch completed successfully',
            this.#batchResource(batch),
          );
          for (const item of batch.items) {
            const status = this.#withoutAccount.has(item.receiver.email.toLowerCase())
              ? 'UNCLAIMED'
              : 'SUCCESS';
            await this.#settleItem(batch.batchId, item.itemId, status);
          }
        }
        const fresh = await this.#must<SimPayout>('payout', batch.batchId, 'Payout batch');
        return { id: batch.batchId, value: this.#payoutResult(fresh) };
      },
      async (id) => this.#payoutResult(await this.#must<SimPayout>('payout', id, 'Payout batch')),
    );
  }

  async #savePayout(batch: SimPayout): Promise<void> {
    await this.#put('payout', batch.batchId, batch);
    for (const item of batch.items)
      await this.#put('payout_item', item.itemId, { batchId: batch.batchId });
  }

  #payoutResult(b: SimPayout): PayoutResult {
    return {
      batchId: b.batchId,
      batchStatus: b.status,
      items: b.items.map((i) => ({
        itemId: i.itemId,
        senderItemId: i.senderItemId,
        status: i.status,
      })),
    };
  }

  #batchResource(b: SimPayout): Record<string, unknown> {
    const total = b.items.reduce((s, i) => s + minorOf(i.amount), 0n);
    const currency = b.items[0]?.amount.currency ?? 'USD';
    return {
      batch_header: {
        payout_batch_id: b.batchId,
        batch_status: b.status,
        time_created: b.createTime,
        sender_batch_header: { sender_batch_id: b.senderBatchId, email_subject: b.emailSubject },
        amount: { value: toPayPal({ amount: total, currency }).value, currency },
      },
    };
  }

  async getPayout(batchId: string): Promise<PayoutResult> {
    return this.#payoutResult(await this.#must<SimPayout>('payout', batchId, 'Payout batch'));
  }

  static readonly #ITEM_EVENT: Partial<Record<PayoutItemStatus, string>> = {
    SUCCESS: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
    UNCLAIMED: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
    RETURNED: 'PAYMENT.PAYOUTS-ITEM.RETURNED',
    FAILED: 'PAYMENT.PAYOUTS-ITEM.FAILED',
  };

  async #settleItem(batchId: string, itemId: string, status: PayoutItemStatus): Promise<void> {
    const batch = await this.#must<SimPayout>('payout', batchId, 'Payout batch');
    const item = batch.items.find((i) => i.itemId === itemId);
    if (!item) fail(404, 'RESOURCE_NOT_FOUND', `Payout item ${itemId} does not exist`);
    item.status = status;
    item.time = this.#iso();
    if (batch.status === 'PENDING') batch.status = 'PROCESSING';
    await this.#savePayout(batch);
    const eventType = PayPalSimulator.#ITEM_EVENT[status];
    if (!eventType) return;
    await this.#emit(eventType, 'payouts_item', `A payout item is ${status.toLowerCase()}`, {
      payout_item_id: item.itemId,
      payout_batch_id: batch.batchId,
      transaction_id: status === 'SUCCESS' ? code(17) : undefined,
      transaction_status: status,
      time_processed: item.time,
      payout_item: {
        recipient_type: 'EMAIL',
        receiver: item.receiver.email,
        sender_item_id: item.senderItemId,
        note: item.note,
        amount: { value: pp(item.amount).value, currency: item.amount.currency },
      },
    });
  }

  async #item(itemId: string): Promise<{ batchId: string; status: PayoutItemStatus }> {
    const ref = await this.#must<{ batchId: string }>('payout_item', itemId, 'Payout item');
    const batch = await this.#must<SimPayout>('payout', ref.batchId, 'Payout batch');
    const item = batch.items.find((i) => i.itemId === itemId) as SimPayoutItem;
    return { batchId: ref.batchId, status: item.status };
  }

  /** The recipient claims the money (signs up or logs in). */
  async claimPayoutItem(itemId: string): Promise<void> {
    const { batchId, status } = await this.#item(itemId);
    if (status !== 'PENDING' && status !== 'UNCLAIMED')
      fail(422, 'ITEM_ALREADY_PROCESSED', `Payout item is ${status}`);
    await this.#settleItem(batchId, itemId, 'SUCCESS');
  }

  /** The recipient has no PayPal account: the money waits up to 30 days. */
  async unclaimPayoutItem(itemId: string): Promise<void> {
    const { batchId, status } = await this.#item(itemId);
    if (status !== 'PENDING') fail(422, 'ITEM_ALREADY_PROCESSED', `Payout item is ${status}`);
    await this.#settleItem(batchId, itemId, 'UNCLAIMED');
  }

  /** Unclaimed for 30 days: PayPal returns the money to the sender. */
  async returnPayoutItem(itemId: string): Promise<void> {
    const { batchId, status } = await this.#item(itemId);
    if (status !== 'UNCLAIMED') fail(422, 'ITEM_NOT_UNCLAIMED', `Payout item is ${status}`);
    await this.#settleItem(batchId, itemId, 'RETURNED');
  }

  // ── Usage-Based Billing ────────────────────────────────────────────────────

  async createMeter(input: MeterInput): Promise<MeterResult> {
    if (!this.#usageBilling) fail(403, 'NOT_AUTHORIZED', 'Usage-based billing is not enabled');
    const existing = await this.#get<SimMeter>('meter', input.externalSubscriptionId);
    if (existing) {
      return {
        metricId: existing.metricId,
        externalSubscriptionId: existing.externalSubscriptionId,
        alertCode: existing.alertCode,
      };
    }
    const meter: SimMeter = {
      externalSubscriptionId: input.externalSubscriptionId,
      metricId: randomUUID(),
      metricCode: input.metricCode,
      name: input.name,
      customer: input.customer,
      rate: store(input.rate),
      includedUnits: input.includedUnits,
      interval: input.interval,
      alertAtUnits: input.alertAtUnits,
      alertCode: input.alertAtUnits === null ? null : `${input.metricCode}_alert`.slice(0, 64),
      usage: {},
      alerted: [],
    };
    await this.#put('meter', meter.externalSubscriptionId, meter);
    return {
      metricId: meter.metricId,
      externalSubscriptionId: meter.externalSubscriptionId,
      alertCode: meter.alertCode,
    };
  }

  #period(timestamp: string, interval: MeterInput['interval']): string {
    const d = new Date(timestamp);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    switch (interval) {
      case 'YEARLY':
        return `${y}`;
      case 'QUARTERLY':
        return `${y}-Q${Math.floor(m / 3) + 1}`;
      case 'MONTHLY':
        return `${y}-${String(m + 1).padStart(2, '0')}`;
      case 'WEEKLY': {
        const monday = new Date(Date.UTC(y, m, d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
        return `W${monday.toISOString().slice(0, 10)}`;
      }
    }
  }

  async recordUsage(event: UsageEventInput): Promise<void> {
    if (!this.#usageBilling) fail(403, 'NOT_AUTHORIZED', 'Usage-based billing is not enabled');
    if (await this.#get('usage_event', event.transactionId)) return;
    const meter = await this.#must<SimMeter>(
      'meter',
      event.externalSubscriptionId,
      'Usage subscription',
    );
    // PayPal silently disregards events for a metric code it does not know.
    if (meter.metricCode !== event.metricCode) return;
    const period = this.#period(event.timestamp, meter.interval);
    const before = meter.usage[period] ?? 0;
    const after = before + Math.round(event.quantity * 100);
    meter.usage[period] = after;
    await this.#put('usage_event', event.transactionId, { ...event, period });
    const threshold = meter.alertAtUnits === null ? null : Math.round(meter.alertAtUnits * 100);
    const crosses =
      threshold !== null &&
      before < threshold &&
      after >= threshold &&
      !meter.alerted.includes(period);
    if (crosses) meter.alerted.push(period);
    await this.#put('meter', meter.externalSubscriptionId, meter);
    if (crosses && meter.alertAtUnits !== null) {
      await this.#emit(
        'USAGE-BILLING.SUBSCRIPTION-ALERT.TRIGGERED',
        'alert',
        'A usage alert threshold was crossed',
        {
          id: randomUUID(),
          external_subscription_id: meter.externalSubscriptionId,
          metric_code: meter.metricCode,
          type: 'METRIC_CURRENT_USAGE_UNITS',
          code: meter.alertCode,
          name: `${meter.name} at ${meter.alertAtUnits}`,
          current_value: quantityString(after / 100),
          previous_value: quantityString(before / 100),
          crossed_thresholds: [
            { code: 'warn', value: String(meter.alertAtUnits), recurring: false },
          ],
          triggered_at: this.#iso(),
        },
      );
    }
  }

  /** Units recorded on a usage subscription in the period containing `at`. */
  async meterUsage(externalSubscriptionId: string, at: string): Promise<number> {
    const meter = await this.#must<SimMeter>('meter', externalSubscriptionId, 'Usage subscription');
    return (meter.usage[this.#period(at, meter.interval)] ?? 0) / 100;
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  async searchTransactions(from: Date, until: Date): Promise<ReportedTransaction[]> {
    const inRange = (time: string) => {
      const at = new Date(time).getTime();
      return at >= from.getTime() && at < until.getTime();
    };
    const out: ReportedTransaction[] = [];
    for (const { data } of await this.#store.list('capture')) {
      const c = data as SimCapture;
      if (!inRange(c.createTime)) continue;
      out.push({
        id: c.id,
        at: new Date(c.createTime).toISOString(),
        amount: load(c.amount),
        counterpartyEmail: c.payer?.email ?? null,
        counterpartyName: c.payer?.name ?? null,
        invoiceId: c.invoiceId,
        customField: c.customId,
        note: '',
        status: 'S',
      });
    }
    for (const { data } of await this.#store.list('refund')) {
      const r = data as SimRefund;
      if (!inRange(r.createTime)) continue;
      out.push({
        id: r.id,
        at: new Date(r.createTime).toISOString(),
        amount: { amount: -minorOf(r.amount), currency: r.amount.currency },
        counterpartyEmail: r.payer?.email ?? null,
        counterpartyName: r.payer?.name ?? null,
        invoiceId: r.invoiceId,
        customField: r.customId,
        note: 'Refund',
        status: 'S',
      });
    }
    for (const { data } of await this.#store.list('sale')) {
      const s = data as SimSale;
      if (!inRange(s.createTime)) continue;
      out.push({
        id: s.id,
        at: new Date(s.createTime).toISOString(),
        amount: load(s.amount),
        counterpartyEmail: s.payer?.email ?? null,
        counterpartyName: s.payer?.name ?? null,
        invoiceId: null,
        customField: s.customId,
        note: `Subscription ${s.subscriptionId}`,
        status: 'S',
      });
    }
    for (const { data } of await this.#store.list('invoice')) {
      const inv = data as SimInvoice;
      if (!inv.paid || !inv.paidTime || !inRange(inv.paidTime)) continue;
      out.push({
        id: inv.id.replaceAll('-', '').slice(4, 21),
        at: new Date(inv.paidTime).toISOString(),
        amount: load(inv.paid),
        counterpartyEmail: inv.payer?.email ?? inv.recipient.email,
        counterpartyName: inv.payer?.name ?? inv.recipient.name,
        invoiceId: inv.number,
        customField: inv.reference,
        note: inv.note,
        status: 'S',
      });
    }
    for (const { data } of await this.#store.list('payout')) {
      const b = data as SimPayout;
      for (const i of b.items) {
        if (i.status !== 'SUCCESS' || !inRange(i.time)) continue;
        out.push({
          id: i.itemId,
          at: new Date(i.time).toISOString(),
          amount: { amount: -minorOf(i.amount), currency: i.amount.currency },
          counterpartyEmail: i.receiver.email,
          counterpartyName: i.receiver.name,
          invoiceId: null,
          customField: i.senderItemId,
          note: i.note,
          status: 'S',
        });
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }
}
