import type {
  AuthorizationResult,
  Capabilities,
  CaptureResult,
  CreateInvoiceInput,
  CreateOrderInput,
  CreatePayoutInput,
  CreatePlanInput,
  CreateSubscriptionInput,
  GatewayMode,
  InvoiceResult,
  InvoiceStatus,
  MeterInput,
  MeterResult,
  Money,
  OrderResult,
  PayoutResult,
  PayPalGateway,
  PlanResult,
  RefundResult,
  ReportedTransaction,
  SubscriptionResult,
  UsageEventInput,
  WebhookRequest,
} from './gateway.ts';
import { PayPalError } from './gateway.ts';
import { fromPayPal, type PayPalAmount, quantityString, toPayPal } from './money.ts';

export const SANDBOX_BASE_URL = 'https://api-m.sandbox.paypal.com';
export const LIVE_BASE_URL = 'https://api-m.paypal.com';

/** Refresh the token this long before PayPal says it expires. */
const TOKEN_MARGIN_MS = 60_000;

const UBB = '/v1/commerce/billing';

export interface PayPalRestOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  /** Needed to verify webhooks. Without it every delivery is treated as unverified. */
  webhookId?: string;
  mode?: Exclude<GatewayMode, 'mock'>;
  fetch?: typeof fetch;
  /** Try Usage-Based Billing (limited release). Off unless asked for. */
  usageBilling?: boolean;
}

interface RequestOptions {
  body?: unknown;
  requestId?: string;
  prefer?: 'return=representation' | 'return=minimal';
  query?: Record<string, string>;
  /** Statuses that are an answer rather than an error, e.g. 404 when looking something up. */
  accept?: number[];
}

interface Link {
  href: string;
  rel: string;
}

type Json = Record<string, unknown>;

const linkOf = (links: unknown, ...rels: string[]): string | null => {
  if (!Array.isArray(links)) return null;
  for (const rel of rels) {
    const found = (links as Link[]).find((l) => l.rel === rel);
    if (found) return found.href;
  }
  return null;
};

const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function splitName(name: string): { given_name: string; surname: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return { given_name: name.trim() || 'Customer', surname: '-' };
  return { given_name: parts.slice(0, -1).join(' '), surname: parts.at(-1) as string };
}

/** Longest a single PayPal call may take. */
const REQUEST_TIMEOUT_MS = 30_000;

/** PayPal REST over plain fetch. Every money-creating call carries an idempotency key. */
export class PayPalRest implements PayPalGateway {
  readonly mode: Exclude<GatewayMode, 'mock'>;
  readonly #opts: PayPalRestOptions;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  #token: { value: string; expiresAt: number } | null = null;
  #capabilities: Promise<Capabilities> | null = null;

  constructor(opts: PayPalRestOptions) {
    this.#opts = opts;
    this.mode = opts.mode ?? 'sandbox';
    this.#fetch = opts.fetch ?? fetch;
    this.#base = (
      opts.baseUrl ?? (this.mode === 'live' ? LIVE_BASE_URL : SANDBOX_BASE_URL)
    ).replace(/\/$/, '');
  }

  // ── Transport ──────────────────────────────────────────────────────────────

  async #accessToken(force = false): Promise<string> {
    if (!force && this.#token && Date.now() < this.#token.expiresAt - TOKEN_MARGIN_MS) {
      return this.#token.value;
    }
    const basic = Buffer.from(`${this.#opts.clientId}:${this.#opts.clientSecret}`).toString(
      'base64',
    );
    const res = await this.#send(`${this.#base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = obj(await res.json().catch(() => ({})));
    if (!res.ok) throw toError(res.status, body, 'Could not get a PayPal access token');
    const value = str(body.access_token);
    if (!value)
      throw new PayPalError('PayPal returned no access token', res.status, null, null, false);
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.#token = { value, expiresAt: Date.now() + expiresIn * 1000 };
    return value;
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    try {
      // A hung call would stall its workflow step; 30 s is generous for PayPal.
      return await this.#fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw new PayPalError(`PayPal unreachable: ${(err as Error).message}`, 0, null, null, true);
    }
  }

  async #request<T = Json>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<{ status: number; body: T }> {
    const url = new URL(`${this.#base}${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${await this.#accessToken(attempt > 0)}`,
        accept: 'application/json',
      };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      if (options.requestId) headers['paypal-request-id'] = options.requestId;
      if (options.prefer) headers.prefer = options.prefer;
      const res = await this.#send(url.toString(), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (res.status === 401 && attempt === 0) continue;
      const text = await res.text();
      let body: unknown = {};
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { message: text };
        }
      }
      if (!res.ok && !options.accept?.includes(res.status)) {
        throw toError(res.status, obj(body), `PayPal ${method} ${path} failed`);
      }
      return { status: res.status, body: body as T };
    }
  }

  async capabilities(): Promise<Capabilities> {
    this.#capabilities ??= (async () => {
      let usageBilling = false;
      if (this.#opts.usageBilling) {
        try {
          await this.#request('POST', `${UBB}/activate`, { body: {} });
          usageBilling = true;
        } catch (err) {
          if (!(err instanceof PayPalError) || err.retryable) this.#capabilities = null;
        }
      }
      let transactionSearch = false;
      try {
        const end = new Date();
        const start = new Date(end.getTime() - 86_400_000);
        await this.#request('GET', '/v1/reporting/transactions', {
          query: { start_date: rfc3339(start), end_date: rfc3339(end), page_size: '1' },
        });
        transactionSearch = true;
      } catch {
        transactionSearch = false;
      }
      return { usageBilling, transactionSearch };
    })();
    return this.#capabilities;
  }

  // ── Orders and payments ────────────────────────────────────────────────────

  async createOrder(input: CreateOrderInput): Promise<OrderResult> {
    const { body } = await this.#request('POST', '/v2/checkout/orders', {
      requestId: input.requestId,
      prefer: 'return=representation',
      body: {
        intent: input.intent,
        purchase_units: [
          {
            reference_id: 'default',
            custom_id: input.customId,
            invoice_id: input.invoiceId,
            description: input.description.slice(0, 127),
            amount: toPayPal(input.amount),
            // No payee: the money goes to the app's own merchant account, which is the owner's.
            // Naming a payee needs PayPal's platform capability and fails for a plain merchant.
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: input.payee.name.slice(0, 127),
              shipping_preference: 'NO_SHIPPING',
              user_action: input.intent === 'CAPTURE' ? 'PAY_NOW' : 'CONTINUE',
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      },
    });
    return orderOf(body);
  }

  async getOrder(orderId: string) {
    const { body } = await this.#request(
      'GET',
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    );
    const payments = obj(obj(arr(body.purchase_units)[0]).payments);
    return {
      ...orderOf(body),
      authorizationId: str(obj(arr(payments.authorizations)[0]).id),
      captureId: str(obj(arr(payments.captures)[0]).id),
    };
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationResult> {
    const { body } = await this.#request(
      'POST',
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`,
      {
        requestId,
        prefer: 'return=representation',
        body: {},
      },
    );
    const auth = obj(arr(obj(obj(arr(body.purchase_units)[0]).payments).authorizations)[0]);
    return authorizationOf(auth);
  }

  async captureAuthorization(
    authorizationId: string,
    requestId: string,
    amount: Money | null,
  ): Promise<CaptureResult> {
    const { body } = await this.#request(
      'POST',
      `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
      {
        requestId,
        prefer: 'return=representation',
        body: amount ? { amount: toPayPal(amount), final_capture: true } : { final_capture: true },
      },
    );
    return captureOf(body);
  }

  async captureOrder(orderId: string, requestId: string): Promise<CaptureResult> {
    const { body } = await this.#request(
      'POST',
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        requestId,
        prefer: 'return=representation',
        body: {},
      },
    );
    return captureOf(obj(arr(obj(obj(arr(body.purchase_units)[0]).payments).captures)[0]));
  }

  async reauthorize(authorizationId: string, requestId: string): Promise<AuthorizationResult> {
    const { body } = await this.#request(
      'POST',
      `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/reauthorize`,
      { requestId, prefer: 'return=representation', body: {} },
    );
    return authorizationOf(body);
  }

  async voidAuthorization(authorizationId: string, requestId: string): Promise<void> {
    await this.#request(
      'POST',
      `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/void`,
      {
        requestId,
      },
    );
  }

  async refundCapture(
    captureId: string,
    requestId: string,
    amount: Money | null,
    note: string,
  ): Promise<RefundResult> {
    const { body } = await this.#request(
      'POST',
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      {
        requestId,
        prefer: 'return=representation',
        body: amount
          ? { amount: toPayPal(amount), note_to_payer: note.slice(0, 255) }
          : { note_to_payer: note.slice(0, 255) },
      },
    );
    return {
      id: String(body.id),
      status: (str(body.status) ?? 'PENDING') as RefundResult['status'],
      amount: body.amount
        ? fromPayPal(body.amount as PayPalAmount)
        : (amount ?? { amount: 0n, currency: 'USD' }),
    };
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  async createPlan(input: CreatePlanInput): Promise<PlanResult> {
    const product = await this.#request('POST', '/v1/catalogs/products', {
      requestId: `${input.requestId}-prod`.slice(0, 38),
      prefer: 'return=representation',
      body: {
        name: input.productName.slice(0, 127),
        description: input.productDescription.slice(0, 256),
        type: 'SERVICE',
        category: 'SOFTWARE',
      },
    });
    const productId = String(product.body.id);
    const plan = await this.#request('POST', '/v1/billing/plans', {
      requestId: `${input.requestId}-plan`.slice(0, 38),
      prefer: 'return=representation',
      body: {
        product_id: productId,
        name: input.planName.slice(0, 127),
        status: 'ACTIVE',
        billing_cycles: [
          {
            tenure_type: 'REGULAR',
            sequence: 1,
            total_cycles: input.cycles ?? 0,
            frequency: { interval_unit: input.interval, interval_count: input.intervalCount },
            pricing_scheme: { fixed_price: toPayPal(input.amount) },
          },
        ],
        payment_preferences: {
          auto_bill_outstanding: true,
          setup_fee_failure_action: 'CONTINUE',
          payment_failure_threshold: 3,
        },
      },
    });
    return {
      productId,
      planId: String(plan.body.id),
      status: (str(plan.body.status) ?? 'ACTIVE') as PlanResult['status'],
    };
  }

  async updatePlanPrice(planId: string, amount: Money): Promise<void> {
    await this.#request(
      'POST',
      `/v1/billing/plans/${encodeURIComponent(planId)}/update-pricing-schemes`,
      {
        body: {
          pricing_schemes: [
            { billing_cycle_sequence: 1, pricing_scheme: { fixed_price: toPayPal(amount) } },
          ],
        },
      },
    );
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionResult> {
    const { body } = await this.#request('POST', '/v1/billing/subscriptions', {
      requestId: input.requestId,
      prefer: 'return=representation',
      body: {
        plan_id: input.planId,
        start_time: input.startTime,
        custom_id: input.customId,
        subscriber: {
          name: splitName(input.subscriber.name),
          email_address: input.subscriber.email,
        },
        application_context: {
          user_action: 'SUBSCRIBE_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
      },
    });
    return subscriptionOf(body);
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionResult> {
    const { body } = await this.#request(
      'GET',
      `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
    return subscriptionOf(body);
  }

  async cancelSubscription(subscriptionId: string, reason: string): Promise<void> {
    const { status } = await this.#request(
      'POST',
      `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
      {
        body: { reason: reason.slice(0, 128) },
        // Cancelling twice answers 422 SUBSCRIPTION_STATUS_INVALID: it is already done.
        accept: [404, 422],
      },
    );
    if (status !== 404) return;
    // PayPal answers 404 to cancelling a subscription the payer never approved: it can never bill,
    // so there is nothing to cancel. Any other 404 is a wrong id.
    const current = await this.getSubscription(subscriptionId);
    if (current.status !== 'APPROVAL_PENDING') {
      throw new PayPalError(
        `PayPal could not find subscription ${subscriptionId} to cancel`,
        404,
        'INVALID_RESOURCE_ID',
        null,
        false,
      );
    }
  }

  // ── Invoicing ──────────────────────────────────────────────────────────────

  /**
   * Invoicing has no idempotency header, so our invoice number is the key: if a draft with that
   * number already exists (a retry after a lost answer), it is reused and only sent if still a draft.
   */
  async createAndSendInvoice(input: CreateInvoiceInput): Promise<InvoiceResult> {
    let id = await this.#findInvoice(input.invoiceNumber);
    if (!id) {
      const created = await this.#request('POST', '/v2/invoicing/invoices', {
        prefer: 'return=representation',
        accept: [422],
        body: {
          detail: {
            currency_code: input.lines[0]?.unitAmount.currency ?? 'USD',
            invoice_number: input.invoiceNumber,
            reference: input.reference.slice(0, 120),
            invoice_date: input.invoiceDate,
            note: input.note.slice(0, 4000),
            payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: input.dueDate },
          },
          // PayPal fills in the invoicer's email from the merchant account; an email the account
          // does not own is refused.
          invoicer: { name: splitName(input.invoicer.name) },
          primary_recipients: [
            {
              billing_info: {
                name: splitName(input.recipient.name),
                email_address: input.recipient.email,
              },
            },
          ],
          items: input.lines.map((l) => ({
            name: l.name.slice(0, 200),
            description: l.description.slice(0, 1000),
            quantity: l.quantity,
            unit_amount: toPayPal(l.unitAmount),
            unit_of_measure: 'QUANTITY',
          })),
        },
      });
      if (created.status === 422) {
        id = await this.#findInvoice(input.invoiceNumber);
        if (!id) throw toError(422, obj(created.body), 'PayPal refused the invoice');
      } else {
        id =
          str(created.body.id) ??
          idFromHref(linkOf(created.body.links, 'self') ?? str(created.body.href));
        if (!id)
          throw new PayPalError(
            'PayPal created an invoice but returned no id',
            created.status,
            null,
            null,
            false,
          );
      }
    }
    const current = await this.getInvoice(id);
    if (current.status === 'DRAFT') {
      await this.#request('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
        body: { send_to_recipient: true, send_to_invoicer: true },
      });
      return this.getInvoice(id);
    }
    return current;
  }

  async #findInvoice(invoiceNumber: string): Promise<string | null> {
    const { body } = await this.#request('POST', '/v2/invoicing/search-invoices', {
      query: { page: '1', page_size: '5', total_required: 'false' },
      body: { invoice_number: invoiceNumber },
    });
    const match = arr(body.items).find((i) => obj(i.detail).invoice_number === invoiceNumber);
    return match ? str(match.id) : null;
  }

  async getInvoice(invoiceId: string): Promise<InvoiceResult> {
    const { body } = await this.#request(
      'GET',
      `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`,
    );
    return invoiceOf(body);
  }

  async remindInvoice(invoiceId: string, note: string): Promise<void> {
    await this.#request('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/remind`, {
      body: { note: note.slice(0, 4000), send_to_recipient: true, send_to_invoicer: false },
    });
  }

  async cancelInvoice(invoiceId: string, note: string): Promise<void> {
    await this.#request('POST', `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/cancel`, {
      body: { note: note.slice(0, 4000), send_to_recipient: true, send_to_invoicer: true },
    });
  }

  // ── Payouts ────────────────────────────────────────────────────────────────

  async createPayout(input: CreatePayoutInput): Promise<PayoutResult> {
    const { body } = await this.#request('POST', '/v1/payments/payouts', {
      requestId: input.senderBatchId.slice(0, 38),
      body: {
        sender_batch_header: {
          sender_batch_id: input.senderBatchId,
          recipient_type: 'EMAIL',
          email_subject: input.emailSubject.slice(0, 255),
          email_message: input.emailMessage.slice(0, 1000),
        },
        items: input.items.map((i) => ({
          recipient_type: 'EMAIL',
          receiver: i.receiver.email,
          sender_item_id: i.senderItemId.slice(0, 63),
          note: i.note.slice(0, 900),
          amount: { value: toPayPal(i.amount).value, currency: i.amount.currency },
        })),
      },
    });
    const header = obj(body.batch_header);
    const batchId = String(header.payout_batch_id);
    return {
      batchId,
      batchStatus: (str(header.batch_status) ?? 'PENDING') as PayoutResult['batchStatus'],
      items: [],
    };
  }

  async getPayout(batchId: string): Promise<PayoutResult> {
    const { body } = await this.#request(
      'GET',
      `/v1/payments/payouts/${encodeURIComponent(batchId)}`,
    );
    const header = obj(body.batch_header);
    return {
      batchId: String(header.payout_batch_id ?? batchId),
      batchStatus: (str(header.batch_status) ?? 'PENDING') as PayoutResult['batchStatus'],
      items: arr(body.items).map((i) => ({
        itemId: String(i.payout_item_id),
        senderItemId: String(obj(i.payout_item).sender_item_id ?? ''),
        status: (str(i.transaction_status) ?? 'PENDING') as PayoutResult['items'][number]['status'],
      })),
    };
  }

  // ── Usage-Based Billing ────────────────────────────────────────────────────

  async createMeter(input: MeterInput): Promise<MeterResult> {
    const metric = await this.#ensure(`${UBB}/metrics`, `${UBB}/metrics/${input.metricCode}`, {
      name: input.name,
      code: input.metricCode,
      type: 'METERED',
      aggregation_type: 'SUM',
      aggregation_field: 'units',
    });
    const metricId = String(metric.id ?? obj(metric.metric).id);
    await this.#ensure(`${UBB}/customers`, `${UBB}/customers/${input.customer.externalId}`, {
      name: input.customer.name,
      external_id: input.customer.externalId,
      email: input.customer.email,
    });
    const planCode = `${input.externalSubscriptionId}_plan`.slice(0, 64);
    const rate = toPayPal(input.rate);
    await this.#ensure(`${UBB}/plans`, `${UBB}/plans/${planCode}`, {
      name: input.name,
      code: planCode,
      billing_cycle: input.interval,
      amount: { value: 0, currency_code: input.rate.currency },
      pay_in_advance: false,
      usage_based_charges: [
        input.includedUnits > 0
          ? {
              metric_id: metricId,
              charge_model: 'GRADUATED',
              properties: {
                graduated_ranges: [
                  {
                    from_value: 0,
                    to_value: input.includedUnits,
                    per_unit_amount: '0',
                    flat_amount: '0',
                  },
                  {
                    from_value: input.includedUnits + 1,
                    to_value: null,
                    per_unit_amount: rate.value,
                    flat_amount: '0',
                  },
                ],
              },
            }
          : { metric_id: metricId, charge_model: 'STANDARD', properties: { amount: rate.value } },
      ],
    });
    await this.#ensure(
      `${UBB}/subscriptions`,
      `${UBB}/subscriptions/${input.externalSubscriptionId}`,
      {
        external_customer_id: input.customer.externalId,
        external_id: input.externalSubscriptionId,
        plan_code: planCode,
        name: input.name,
        billing_time: 'CALENDAR',
      },
    );
    let alertCode: string | null = null;
    if (input.alertAtUnits !== null) {
      alertCode = `${input.metricCode}_alert`.slice(0, 64);
      await this.#ensure(
        `${UBB}/subscriptions/${input.externalSubscriptionId}/alerts`,
        `${UBB}/subscriptions/${input.externalSubscriptionId}/alerts/${alertCode}`,
        {
          type: 'METRIC_CURRENT_USAGE_UNITS',
          code: alertCode,
          metric_code: input.metricCode,
          name: `${input.name} at ${input.alertAtUnits}`,
          thresholds: [{ code: 'warn', value: String(input.alertAtUnits), recurring: false }],
        },
      );
    }
    return { metricId, externalSubscriptionId: input.externalSubscriptionId, alertCode };
  }

  /** UBB has no idempotency header: create, and on a conflict read back what already exists. */
  async #ensure(createPath: string, readPath: string, body: Json): Promise<Json> {
    const created = await this.#request('POST', createPath, { body, accept: [409, 422] });
    if (created.status < 300) return obj(created.body);
    const existing = await this.#request('GET', readPath);
    return obj(existing.body);
  }

  async recordUsage(event: UsageEventInput): Promise<void> {
    await this.#request('POST', `${UBB}/events`, {
      accept: [409],
      body: {
        transaction_id: event.transactionId,
        external_subscription_id: event.externalSubscriptionId,
        metric_code: event.metricCode,
        timestamp: event.timestamp,
        properties: { units: quantityString(event.quantity) },
      },
    });
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  async searchTransactions(from: string, to: string): Promise<ReportedTransaction[]> {
    const out: ReportedTransaction[] = [];
    for (let page = 1; page <= 50; page++) {
      const { body } = await this.#request('GET', '/v1/reporting/transactions', {
        query: {
          start_date: `${from}T00:00:00Z`,
          end_date: `${to}T23:59:59Z`,
          fields: 'transaction_info,payer_info',
          page_size: '500',
          page: String(page),
        },
      });
      for (const d of arr(body.transaction_details)) {
        const info = obj(d.transaction_info);
        const payer = obj(d.payer_info);
        const amount = obj(info.transaction_amount);
        if (!str(amount.value)) continue;
        out.push({
          id: String(info.transaction_id),
          date: String(info.transaction_initiation_date ?? '').slice(0, 10),
          amount: fromPayPal(amount as unknown as PayPalAmount),
          counterpartyEmail: str(payer.email_address),
          counterpartyName:
            str(obj(payer.payer_name).alternate_full_name) ?? str(obj(payer.payer_name).given_name),
          invoiceId: str(info.invoice_id),
          customField: str(info.custom_field),
          note: str(info.transaction_note) ?? str(info.transaction_subject) ?? '',
          status: str(info.transaction_status) ?? '',
        });
      }
      const totalPages = typeof body.total_pages === 'number' ? body.total_pages : 1;
      if (page >= totalPages) break;
    }
    return out;
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────

  /**
   * Points this app's webhook at `url` for the given events and returns its id (for
   * PAYPAL_WEBHOOK_ID). An app holds one webhook per URL, so a URL already registered has its
   * events replaced and keeps its id.
   */
  async registerWebhook(url: string, eventTypes: string[]): Promise<string> {
    const event_types = eventTypes.map((name) => ({ name }));
    const created = await this.#request('POST', '/v1/notifications/webhooks', {
      body: { url, event_types },
      accept: [400],
    });
    if (created.status < 300) return String(created.body.id);
    const { body } = await this.#request('GET', '/v1/notifications/webhooks');
    const existing = arr(body.webhooks).find((w) => w.url === url);
    if (!existing) throw toError(400, obj(created.body), 'PayPal refused the webhook');
    await this.#request(
      'PATCH',
      `/v1/notifications/webhooks/${encodeURIComponent(String(existing.id))}`,
      {
        body: [{ op: 'replace', path: '/event_types', value: event_types }],
      },
    );
    return String(existing.id);
  }

  async verifyWebhook(request: WebhookRequest): Promise<boolean> {
    const { webhookId } = this.#opts;
    if (!webhookId) return false;
    const h = (name: string) => request.headers[name] ?? request.headers[name.toLowerCase()];
    const required = [
      'paypal-auth-algo',
      'paypal-cert-url',
      'paypal-transmission-id',
      'paypal-transmission-sig',
      'paypal-transmission-time',
    ];
    if (required.some((name) => !h(name))) return false;
    // The event goes back exactly as received: re-serialising it can change the signed bytes.
    const payload = `{"auth_algo":${JSON.stringify(h('paypal-auth-algo'))},"cert_url":${JSON.stringify(h('paypal-cert-url'))},"transmission_id":${JSON.stringify(h('paypal-transmission-id'))},"transmission_sig":${JSON.stringify(h('paypal-transmission-sig'))},"transmission_time":${JSON.stringify(h('paypal-transmission-time'))},"webhook_id":${JSON.stringify(webhookId)},"webhook_event":${request.rawBody}}`;
    const token = await this.#accessToken();
    const res = await this.#send(`${this.#base}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: payload,
    });
    if (!res.ok) return false;
    const body = obj(await res.json().catch(() => ({})));
    return body.verification_status === 'SUCCESS';
  }
}

// ── Mapping ──────────────────────────────────────────────────────────────────

function rfc3339(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

function idFromHref(href: string | null): string | null {
  if (!href) return null;
  return href.split('?')[0]?.split('/').filter(Boolean).at(-1) ?? null;
}

function toError(status: number, body: Json, fallback: string): PayPalError {
  const details = arr(body.details);
  const issue = str(details[0]?.issue) ?? str(body.name) ?? str(body.error);
  const message =
    str(details[0]?.description) ?? str(body.message) ?? str(body.error_description) ?? fallback;
  const retryable =
    status === 0 || status === 429 || status >= 500 || issue === 'PREVIOUS_REQUEST_IN_PROGRESS';
  return new PayPalError(`${fallback}: ${message}`, status, issue, str(body.debug_id), retryable);
}

function orderOf(body: Json): OrderResult {
  const status = (str(body.status) ?? 'CREATED') as OrderResult['status'];
  const approve = linkOf(body.links, 'payer-action', 'approve');
  return {
    id: String(body.id),
    status,
    approveUrl: status === 'CREATED' || status === 'PAYER_ACTION_REQUIRED' ? approve : null,
  };
}

function authorizationOf(auth: Json): AuthorizationResult {
  const created = str(auth.create_time);
  return {
    id: String(auth.id),
    status: (str(auth.status) ?? 'CREATED') as AuthorizationResult['status'],
    honorUntil: created ? new Date(Date.parse(created) + 3 * 86_400_000).toISOString() : null,
    expiresAt: str(auth.expiration_time),
  };
}

function captureOf(body: Json): CaptureResult {
  return {
    id: String(body.id),
    status: (str(body.status) ?? 'PENDING') as CaptureResult['status'],
    amount: fromPayPal((body.amount as PayPalAmount) ?? { currency_code: 'USD', value: '0' }),
  };
}

function subscriptionOf(body: Json): SubscriptionResult {
  const status = (str(body.status) ?? 'APPROVAL_PENDING') as SubscriptionResult['status'];
  return {
    id: String(body.id),
    status,
    approveUrl: status === 'APPROVAL_PENDING' ? linkOf(body.links, 'approve') : null,
    nextBillingTime: str(obj(body.billing_info).next_billing_time),
  };
}

function invoiceOf(body: Json): InvoiceResult {
  const detail = obj(body.detail);
  const metadata = obj(detail.metadata);
  const total = obj(body.amount);
  const currency = str(detail.currency_code) ?? str(total.currency_code) ?? 'USD';
  const paid = obj(obj(body.payments).paid_amount);
  return {
    id: String(body.id),
    number: str(detail.invoice_number) ?? '',
    status: (str(body.status) ?? 'DRAFT') as InvoiceStatus,
    payerViewUrl: str(metadata.recipient_view_url) ?? linkOf(body.links, 'payer-view'),
    amount: str(total.value)
      ? fromPayPal({ currency_code: currency, value: str(total.value) as string })
      : { amount: 0n, currency },
    paid: str(paid.value)
      ? fromPayPal({ currency_code: currency, value: str(paid.value) as string })
      : null,
  };
}
