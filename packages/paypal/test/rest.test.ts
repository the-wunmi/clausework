import { describe, expect, it } from 'vitest';
import { createGateway, PayPalError, PayPalRest } from '../src/index.ts';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => { status: number; body?: unknown } | undefined;

/** A fetch that records each call and answers from the handlers, first match wins. */
function fakeFetch(...handlers: Handler[]) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body;
    let body: unknown = raw;
    if (typeof raw === 'string' && raw.startsWith('{')) body = JSON.parse(raw);
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    };
    calls.push(call);
    if (call.url.endsWith('/v1/oauth2/token')) {
      return Response.json({
        access_token: `token-${calls.length}`,
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    for (const h of handlers) {
      const answer = h(call);
      if (answer) {
        return answer.body === undefined
          ? new Response(null, { status: answer.status })
          : Response.json(answer.body, { status: answer.status });
      }
    }
    return Response.json(
      { name: 'RESOURCE_NOT_FOUND', message: 'unexpected call' },
      { status: 404 },
    );
  };
  return { calls, fetch: impl as typeof fetch };
}

const rest = (
  fetch: typeof globalThis.fetch,
  extra: Partial<ConstructorParameters<typeof PayPalRest>[0]> = {},
) => new PayPalRest({ clientId: 'id', clientSecret: 'secret', fetch, ...extra });

const USD = (amount: bigint) => ({ amount, currency: 'USD' });

describe('PayPalRest', () => {
  it('authenticates once, sends the idempotency key and decimal amounts, and reads the approve link', async () => {
    const { calls, fetch } = fakeFetch((c) =>
      c.url.endsWith('/v2/checkout/orders')
        ? {
            status: 201,
            body: {
              id: '5O190127TN364715T',
              status: 'PAYER_ACTION_REQUIRED',
              links: [
                {
                  rel: 'payer-action',
                  href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O19',
                  method: 'GET',
                },
              ],
            },
          }
        : undefined,
    );
    const pp = rest(fetch);
    const input = {
      requestId: 'req-1',
      intent: 'AUTHORIZE' as const,
      amount: USD(1_440_000n),
      description: 'Deposit',
      customId: 'charge-1',
      invoiceId: 'CW-1',
      payee: { name: 'Brightline', email: 'b@test' },
      returnUrl: 'https://app/return',
      cancelUrl: 'https://app/cancel',
    };
    const order = await pp.createOrder(input);
    await pp.createOrder({ ...input, requestId: 'req-2' });
    expect(order).toEqual({
      id: '5O190127TN364715T',
      status: 'PAYER_ACTION_REQUIRED',
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=5O19',
    });

    const token = calls.filter((c) => c.url.endsWith('/oauth2/token'));
    expect(token).toHaveLength(1);
    expect(token[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('id:secret').toString('base64')}`,
    );
    const create = calls[1]!;
    expect(create.url).toBe('https://api-m.sandbox.paypal.com/v2/checkout/orders');
    expect(create.headers).toMatchObject({
      authorization: 'Bearer token-1',
      'paypal-request-id': 'req-1',
      prefer: 'return=representation',
    });
    expect(create.body).toMatchObject({
      intent: 'AUTHORIZE',
      purchase_units: [
        {
          custom_id: 'charge-1',
          invoice_id: 'CW-1',
          amount: { currency_code: 'USD', value: '14400.00' },
        },
      ],
    });
    // The merchant account is the payee; naming one needs PayPal's platform capability.
    expect(
      (create.body as { purchase_units: Record<string, unknown>[] }).purchase_units[0],
    ).not.toHaveProperty('payee');
  });

  it('gets a fresh token and retries once on 401', async () => {
    let first = true;
    const { calls, fetch } = fakeFetch((c) => {
      if (!c.url.includes('/v1/billing/subscriptions/')) return undefined;
      if (first) {
        first = false;
        return { status: 401, body: { name: 'AUTHENTICATION_FAILURE' } };
      }
      return {
        status: 200,
        body: {
          id: 'I-ABC',
          status: 'ACTIVE',
          billing_info: { next_billing_time: '2027-02-04T10:00:00Z' },
        },
      };
    });
    const sub = await rest(fetch).getSubscription('I-ABC');
    expect(sub).toEqual({
      id: 'I-ABC',
      status: 'ACTIVE',
      approveUrl: null,
      nextBillingTime: '2027-02-04T10:00:00Z',
    });
    expect(calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(2);
  });

  it('maps errors to PayPalError with the issue, debug id and whether to retry', async () => {
    const { fetch } = fakeFetch(
      (c) =>
        c.url.endsWith('/capture')
          ? {
              status: 422,
              body: {
                name: 'UNPROCESSABLE_ENTITY',
                debug_id: 'dbg1',
                details: [
                  { issue: 'AUTHORIZATION_EXPIRED', description: 'Authorization has expired' },
                ],
              },
            }
          : undefined,
      (c) =>
        c.url.includes('/refund')
          ? { status: 503, body: { name: 'SERVICE_UNAVAILABLE' } }
          : undefined,
    );
    const pp = rest(fetch);
    const declined = await pp.captureAuthorization('AUTH1', 'k', null).catch((e: unknown) => e);
    expect(declined).toBeInstanceOf(PayPalError);
    expect(declined).toMatchObject({
      status: 422,
      issue: 'AUTHORIZATION_EXPIRED',
      debugId: 'dbg1',
      retryable: false,
    });
    expect(await pp.refundCapture('CAP1', 'k', null, '').catch((e: unknown) => e)).toMatchObject({
      status: 503,
      retryable: true,
    });
  });

  it('marks network failures retryable', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(
      await rest(failing)
        .getInvoice('INV2-X')
        .catch((e: unknown) => e),
    ).toMatchObject({ status: 0, retryable: true });
  });

  it('creates an invoice draft, sends it and returns the payer link; a retry reuses the draft', async () => {
    const state = { created: false, sent: false };
    const invoice = () => ({
      id: 'INV2-AAAA-BBBB-CCCC-DDDD',
      status: state.sent ? 'SENT' : 'DRAFT',
      detail: {
        invoice_number: 'CW-1-phase_2',
        currency_code: 'USD',
        metadata: { recipient_view_url: 'https://www.sandbox.paypal.com/invoice/p/#INV2' },
      },
      amount: { currency_code: 'USD', value: '19440.00' },
    });
    const { calls, fetch } = fakeFetch(
      (c) =>
        c.url.includes('/search-invoices')
          ? { status: 200, body: { items: state.created ? [invoice()] : [] } }
          : undefined,
      (c) => {
        if (!c.url.endsWith('/v2/invoicing/invoices') || c.method !== 'POST') return undefined;
        state.created = true;
        return { status: 201, body: invoice() };
      },
      (c) => {
        if (!c.url.endsWith('/send')) return undefined;
        state.sent = true;
        return { status: 200, body: { links: [] } };
      },
      (c) =>
        c.url.endsWith('/INV2-AAAA-BBBB-CCCC-DDDD') && c.method === 'GET'
          ? { status: 200, body: invoice() }
          : undefined,
    );
    const pp = rest(fetch);
    const input = {
      requestId: 'r',
      invoiceNumber: 'CW-1-phase_2',
      invoicer: { name: 'Marcus Reyes', email: 'billing@brightline.test' },
      recipient: { name: 'Dana Whitfield', email: 'ap@northwind.test' },
      lines: [
        { name: 'Design System', description: '§3.3', quantity: '1', unitAmount: USD(1_920_000n) },
        { name: 'Support', description: '§4.3', quantity: '6', unitAmount: USD(4000n) },
      ],
      invoiceDate: '2027-02-26',
      dueDate: '2027-03-28',
      note: 'n',
      reference: 'charge-9',
    };
    const result = await pp.createAndSendInvoice(input);
    expect(result).toMatchObject({
      id: 'INV2-AAAA-BBBB-CCCC-DDDD',
      status: 'SENT',
      payerViewUrl: 'https://www.sandbox.paypal.com/invoice/p/#INV2',
      amount: USD(1_944_000n),
    });
    const create = calls.find(
      (c) => c.url.endsWith('/v2/invoicing/invoices') && c.method === 'POST',
    )!;
    expect(create.headers['paypal-request-id']).toBeUndefined();
    expect((create.body as { detail: object }).detail).not.toHaveProperty('invoice_date');
    expect(create.body).toMatchObject({
      detail: {
        invoice_number: 'CW-1-phase_2',
        currency_code: 'USD',
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2027-03-28' },
      },
      primary_recipients: [
        {
          billing_info: {
            email_address: 'ap@northwind.test',
            name: { given_name: 'Dana', surname: 'Whitfield' },
          },
        },
      ],
      items: [
        { quantity: '1', unit_amount: { value: '19200.00' } },
        { quantity: '6', unit_amount: { value: '40.00' } },
      ],
    });

    const before = calls.length;
    await pp.createAndSendInvoice(input);
    const retry = calls.slice(before);
    expect(retry.some((c) => c.url.endsWith('/v2/invoicing/invoices') && c.method === 'POST')).toBe(
      false,
    );
    expect(retry.some((c) => c.url.endsWith('/send'))).toBe(false);
  });

  it('pays out by email with the batch id as idempotency key', async () => {
    const { calls, fetch } = fakeFetch((c) =>
      c.url.endsWith('/v1/payments/payouts')
        ? {
            status: 201,
            body: { batch_header: { payout_batch_id: 'BATCH1', batch_status: 'PENDING' } },
          }
        : undefined,
    );
    const result = await rest(fetch).createPayout({
      senderBatchId: 'cw-1-2027Q1',
      emailSubject: 's',
      emailMessage: 'm',
      items: [
        {
          senderItemId: 'kinetic',
          receiver: { name: 'K', email: 'k@test' },
          amount: USD(384_000n),
          note: '20%',
        },
      ],
    });
    expect(result).toEqual({ batchId: 'BATCH1', batchStatus: 'PENDING', items: [] });
    const call = calls.at(-1)!;
    expect(call.headers['paypal-request-id']).toBe('cw-1-2027Q1');
    expect(call.body).toMatchObject({
      sender_batch_header: { sender_batch_id: 'cw-1-2027Q1', recipient_type: 'EMAIL' },
      items: [
        {
          receiver: 'k@test',
          amount: { value: '3840.00', currency: 'USD' },
          sender_item_id: 'kinetic',
        },
      ],
    });
  });

  it('creates product then active plan, and updates its price', async () => {
    const { calls, fetch } = fakeFetch(
      (c) =>
        c.url.endsWith('/v1/catalogs/products')
          ? { status: 201, body: { id: 'PROD-1' } }
          : undefined,
      (c) =>
        c.url.endsWith('/v1/billing/plans')
          ? { status: 201, body: { id: 'P-1', status: 'ACTIVE' } }
          : undefined,
      (c) => (c.url.endsWith('/update-pricing-schemes') ? { status: 204 } : undefined),
    );
    const pp = rest(fetch);
    const plan = await pp.createPlan({
      requestId: 'agr1-retainer',
      productName: 'Retainer',
      productDescription: '§4.1',
      planName: 'Monthly',
      amount: USD(300_000n),
      interval: 'MONTH',
      intervalCount: 1,
      cycles: null,
    });
    expect(plan).toEqual({ productId: 'PROD-1', planId: 'P-1', status: 'ACTIVE' });
    const planCall = calls.find((c) => c.url.endsWith('/v1/billing/plans'))!;
    expect(planCall.body).toMatchObject({
      product_id: 'PROD-1',
      status: 'ACTIVE',
      billing_cycles: [
        {
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: { fixed_price: { value: '3000.00' } },
        },
      ],
    });
    await pp.updatePlanPrice('P-1', USD(309_000n));
    expect(calls.at(-1)!.body).toEqual({
      pricing_schemes: [
        {
          billing_cycle_sequence: 1,
          pricing_scheme: { fixed_price: { currency_code: 'USD', value: '3090.00' } },
        },
      ],
    });
  });

  it('treats cancelling a never-approved subscription as done, and a 404 for anything else as an error', async () => {
    // Seen in the sandbox: PayPal answers 404 INVALID_RESOURCE_ID to cancelling APPROVAL_PENDING.
    const { fetch } = fakeFetch(
      (c) =>
        c.url.endsWith('/cancel')
          ? {
              status: 404,
              body: { name: 'RESOURCE_NOT_FOUND', details: [{ issue: 'INVALID_RESOURCE_ID' }] },
            }
          : undefined,
      (c) =>
        c.url.endsWith('/I-PENDING')
          ? { status: 200, body: { id: 'I-PENDING', status: 'APPROVAL_PENDING' } }
          : undefined,
      (c) =>
        c.url.endsWith('/I-ACTIVE')
          ? { status: 200, body: { id: 'I-ACTIVE', status: 'ACTIVE' } }
          : undefined,
    );
    const pp = rest(fetch);
    await expect(pp.cancelSubscription('I-PENDING', 'amended')).resolves.toBeUndefined();
    await expect(pp.cancelSubscription('I-ACTIVE', 'amended')).rejects.toBeInstanceOf(PayPalError);
  });

  it('verifies webhooks by postback with the raw event, and refuses without a webhook id', async () => {
    const { calls, fetch } = fakeFetch((c) =>
      c.url.endsWith('/verify-webhook-signature')
        ? { status: 200, body: { verification_status: 'SUCCESS' } }
        : undefined,
    );
    const headers = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.paypal.com/cert',
      'paypal-transmission-id': 't1',
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': '2027-01-01T00:00:00Z',
    };
    const rawBody =
      '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"z":1,"a":2}}';
    expect(await rest(fetch).verifyWebhook({ headers, rawBody })).toBe(false);
    expect(await rest(fetch, { webhookId: 'WEBHOOK1' }).verifyWebhook({ headers, rawBody })).toBe(
      true,
    );
    const post = calls.at(-1)!;
    expect(post.body).toMatchObject({
      webhook_id: 'WEBHOOK1',
      transmission_id: 't1',
      webhook_event: { resource: { z: 1, a: 2 } },
    });
  });

  it('turns usage billing on only when asked and PayPal agrees', async () => {
    const { fetch } = fakeFetch(
      (c) =>
        c.url.endsWith('/v1/commerce/billing/activate')
          ? { status: 403, body: { name: 'NOT_AUTHORIZED' } }
          : undefined,
      (c) =>
        c.url.includes('/v1/reporting/transactions')
          ? { status: 200, body: { transaction_details: [] } }
          : undefined,
    );
    expect(await rest(fetch, { usageBilling: true }).capabilities()).toEqual({
      usageBilling: false,
      transactionSearch: true,
    });
  });
});

describe('createGateway', () => {
  it('talks to PayPal only, demands credentials, and never picks the simulator', () => {
    expect(() => createGateway({})).toThrow(/PAYPAL_CLIENT_ID/);
    expect(() => createGateway({ PAYPAL_MODE: 'mock' })).toThrow(/sandbox or live/);
    expect(
      createGateway({ PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b' })
        .mode,
    ).toBe('sandbox');
  });
});
