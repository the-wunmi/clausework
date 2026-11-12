import { beforeEach, describe, expect, it } from 'vitest';
import { MemorySimStore, PayPalError, PayPalSimulator, type WebhookEvent } from '../src/index.ts';

const USD = (amount: bigint) => ({ amount, currency: 'USD' });
const client = { name: 'Northwind Outfitters', email: 'ap@northwind.test' };
const agency = { name: 'Brightline Studio', email: 'billing@brightline.test' };

let now = new Date('2027-01-04T10:00:00Z');
let sim: PayPalSimulator;
let events: WebhookEvent[];

beforeEach(() => {
  now = new Date('2027-01-04T10:00:00Z');
  sim = new PayPalSimulator({
    store: new MemorySimStore(),
    publicUrl: 'http://localhost:3000',
    now: () => now,
  });
  events = [];
  sim.onWebhook(async (e) => {
    events.push(e);
  });
});

const order = (requestId = 'req-order-1', invoiceId = 'CW-1-deposit') =>
  sim.createOrder({
    requestId,
    intent: 'AUTHORIZE',
    amount: USD(1_440_000n),
    description: 'Deposit, §3.2',
    customId: 'charge-deposit',
    invoiceId,
    payee: agency,
    returnUrl: 'http://localhost:3000/return',
    cancelUrl: 'http://localhost:3000/cancel',
  });

describe('orders', () => {
  it('runs create, approve, authorize and capture with PayPal ids and webhooks', async () => {
    const created = await order();
    expect(created.id).toMatch(/^[A-Z0-9]{17}$/);
    expect(created.approveUrl).toBe(`http://localhost:3000/sim/checkout/order/${created.id}`);

    await expect(sim.authorizeOrder(created.id, 'req-auth-0')).rejects.toMatchObject({
      issue: 'ORDER_NOT_APPROVED',
    });

    await sim.approveOrder(created.id, client);
    const auth = await sim.authorizeOrder(created.id, 'req-auth-1');
    expect(auth.status).toBe('CREATED');
    expect(Date.parse(auth.honorUntil!) - now.getTime()).toBe(3 * 86_400_000);

    const capture = await sim.captureAuthorization(auth.id, 'req-cap-1', null);
    expect(capture).toMatchObject({ status: 'COMPLETED', amount: USD(1_440_000n) });
    expect(await sim.getOrder(created.id)).toMatchObject({
      status: 'COMPLETED',
      authorizationId: auth.id,
      captureId: capture.id,
    });

    expect(events.map((e) => e.event_type)).toEqual([
      'CHECKOUT.ORDER.APPROVED',
      'PAYMENT.AUTHORIZATION.CREATED',
      'PAYMENT.CAPTURE.COMPLETED',
    ]);
    const captured = events[2]!.resource;
    expect(captured).toMatchObject({
      id: capture.id,
      custom_id: 'charge-deposit',
      invoice_id: 'CW-1-deposit',
      amount: { currency_code: 'USD', value: '14400.00' },
      supplementary_data: { related_ids: { order_id: created.id, authorization_id: auth.id } },
    });
  });

  it('returns the same object for a repeated request id and never doubles money', async () => {
    const a = await order('same-key');
    const b = await order('same-key');
    expect(b.id).toBe(a.id);
    await sim.approveOrder(a.id, client);
    const auth = await sim.authorizeOrder(a.id, 'auth-key');
    const c1 = await sim.captureAuthorization(auth.id, 'cap-key', null);
    const c2 = await sim.captureAuthorization(auth.id, 'cap-key', null);
    expect(c2.id).toBe(c1.id);
    expect(events.filter((e) => e.event_type === 'PAYMENT.CAPTURE.COMPLETED')).toHaveLength(1);
    await expect(sim.captureAuthorization(auth.id, 'another-key', null)).rejects.toMatchObject({
      issue: 'PREVIOUSLY_CAPTURED',
    });
  });

  it('refuses a second order with the same invoice id', async () => {
    await order('k1', 'CW-dup');
    await expect(order('k2', 'CW-dup')).rejects.toMatchObject({ issue: 'DUPLICATE_INVOICE_ID' });
  });

  it('expires authorizations after 29 days and only reauthorizes after the honor period', async () => {
    const o = await order();
    await sim.approveOrder(o.id, client);
    const auth = await sim.authorizeOrder(o.id, 'a');
    await expect(sim.reauthorize(auth.id, 'r0')).rejects.toMatchObject({
      issue: 'REAUTHORIZATION_TOO_SOON',
    });
    now = new Date(now.getTime() + 4 * 86_400_000);
    const again = await sim.reauthorize(auth.id, 'r1');
    expect(again.id).not.toBe(auth.id);
    now = new Date(now.getTime() + 30 * 86_400_000);
    await expect(sim.captureAuthorization(again.id, 'c', null)).rejects.toMatchObject({
      issue: 'AUTHORIZATION_EXPIRED',
    });
  });

  it('fails the next call on request, for testing failure paths', async () => {
    const o = await order();
    await sim.approveOrder(o.id, client);
    const auth = await sim.authorizeOrder(o.id, 'a');
    sim.failNext('capture', 'INSTRUMENT_DECLINED');
    const err = await sim.captureAuthorization(auth.id, 'c1', null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ status: 422, issue: 'INSTRUMENT_DECLINED', retryable: false });
    // The failed request id was not consumed: a fresh attempt succeeds.
    expect((await sim.captureAuthorization(auth.id, 'c2', null)).status).toBe('COMPLETED');
  });

  it('refunds part then the rest of a capture', async () => {
    const o = await order();
    await sim.approveOrder(o.id, client);
    const auth = await sim.authorizeOrder(o.id, 'a');
    const cap = await sim.captureAuthorization(auth.id, 'c', null);
    await sim.refundCapture(cap.id, 'r1', USD(40_000n), 'Service credit, §8');
    await expect(sim.refundCapture(cap.id, 'r2', USD(1_440_000n), '')).rejects.toMatchObject({
      issue: 'REFUND_AMOUNT_EXCEEDED',
    });
    const rest = await sim.refundCapture(cap.id, 'r3', null, '');
    expect(rest.amount).toEqual(USD(1_400_000n));
    const refunded = events.filter((e) => e.event_type === 'PAYMENT.CAPTURE.REFUNDED');
    expect(refunded).toHaveLength(2);
    expect(refunded[0]!.resource.custom_id).toBe('charge-deposit');
  });
});

describe('subscriptions', () => {
  it('bills each cycle at the plan price in force, so a price update reaches later cycles', async () => {
    const plan = await sim.createPlan({
      requestId: 'plan-1',
      productName: 'Brightline retainer',
      productDescription: '§4.1',
      planName: 'Monthly retainer',
      amount: USD(300_000n),
      interval: 'MONTH',
      intervalCount: 1,
      cycles: null,
    });
    expect(plan.planId).toMatch(/^P-[A-Z0-9]{24}$/);
    expect(plan.productId).toMatch(/^PROD-/);
    const sub = await sim.createSubscription({
      requestId: 'sub-1',
      planId: plan.planId,
      subscriber: client,
      startTime: '2027-01-04T00:00:00Z',
      customId: 'agreement-1:retainer',
      returnUrl: 'r',
      cancelUrl: 'c',
    });
    expect(sub).toMatchObject({
      status: 'APPROVAL_PENDING',
      approveUrl: `http://localhost:3000/sim/checkout/subscription/${sub.id}`,
    });
    expect(sub.id).toMatch(/^I-[A-Z0-9]{12}$/);

    const active = await sim.approveSubscription(sub.id, client);
    expect(active).toMatchObject({ status: 'ACTIVE', nextBillingTime: '2027-02-04T00:00:00.000Z' });

    await sim.updatePlanPrice(plan.planId, USD(309_000n));
    const second = await sim.billSubscription(sub.id);
    expect(second.amount).toEqual(USD(309_000n));

    const sales = events.filter((e) => e.event_type === 'PAYMENT.SALE.COMPLETED');
    expect(sales.map((e) => (e.resource.amount as { total: string }).total)).toEqual([
      '3000.00',
      '3090.00',
    ]);
    expect(sales[0]!.resource).toMatchObject({
      billing_agreement_id: sub.id,
      custom: 'agreement-1:retainer',
    });
    expect(events.map((e) => e.event_type)).toContain('BILLING.SUBSCRIPTION.ACTIVATED');
  });

  it('expires after its cycles and reports failed payments', async () => {
    const plan = await sim.createPlan({
      requestId: 'p',
      productName: 'x',
      productDescription: 'x',
      planName: 'x',
      amount: USD(100n),
      interval: 'MONTH',
      intervalCount: 1,
      cycles: 2,
    });
    const sub = await sim.createSubscription({
      requestId: 's',
      planId: plan.planId,
      subscriber: client,
      startTime: '2027-01-04T00:00:00Z',
      customId: 'x',
      returnUrl: 'r',
      cancelUrl: 'c',
    });
    await sim.approveSubscription(sub.id, client);
    await sim.failSubscriptionPayment(sub.id);
    const failed = events.find((e) => e.event_type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED')!;
    expect(
      (failed.resource.billing_info as { failed_payments_count: number }).failed_payments_count,
    ).toBe(1);
    await sim.billSubscription(sub.id);
    expect((await sim.getSubscription(sub.id)).status).toBe('EXPIRED');
    await expect(sim.billSubscription(sub.id)).rejects.toMatchObject({
      issue: 'SUBSCRIPTION_STATUS_INVALID',
    });
  });
});

describe('invoices', () => {
  const invoice = () =>
    sim.createAndSendInvoice({
      requestId: 'inv-1',
      invoiceNumber: 'CW-1-phase_2',
      invoicer: agency,
      recipient: client,
      lines: [
        {
          name: 'Design System milestone',
          description: '§3.3',
          quantity: '1',
          unitAmount: USD(1_920_000n),
        },
        {
          name: 'Support above 20 hours',
          description: '§4.3: 6 × $40.00',
          quantity: '6',
          unitAmount: USD(4000n),
        },
      ],
      invoiceDate: '2027-02-26',
      dueDate: '2027-03-28',
      note: 'Cites §3.3',
      reference: 'charge-123',
    });

  it('creates once per invoice number, then pays with a PayPal webhook', async () => {
    const a = await invoice();
    const b = await invoice();
    expect(b.id).toBe(a.id);
    expect(a.id).toMatch(/^INV2-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(a).toMatchObject({ status: 'SENT', amount: USD(1_944_000n), paid: null });

    await sim.payInvoice(a.id, client);
    expect(await sim.getInvoice(a.id)).toMatchObject({ status: 'PAID', paid: USD(1_944_000n) });
    const paid = events.find((e) => e.event_type === 'INVOICING.INVOICE.PAID')!;
    expect(paid.resource).toMatchObject({
      id: a.id,
      detail: { invoice_number: 'CW-1-phase_2', reference: 'charge-123' },
    });
    await expect(sim.cancelInvoice(a.id, '')).rejects.toMatchObject({
      issue: 'CANT_CANCEL_PAID_INVOICE',
    });
  });

  it('allows two reminders a day', async () => {
    const inv = await invoice();
    await sim.remindInvoice(inv.id, '');
    await sim.remindInvoice(inv.id, '');
    await expect(sim.remindInvoice(inv.id, '')).rejects.toMatchObject({
      status: 429,
      retryable: true,
    });
  });
});

describe('payouts', () => {
  it('settles each item, leaves recipients without an account unclaimed, and returns them later', async () => {
    sim.markReceiverWithoutAccount('fees@harbor.test');
    const batch = await sim.createPayout({
      senderBatchId: 'agreement-1:2027-Q1',
      emailSubject: 'You have a payment',
      emailMessage: 'Per §5.1',
      items: [
        {
          senderItemId: 'kinetic',
          receiver: { name: 'Kinetic', email: 'pay@kinetic.test' },
          amount: USD(384_000n),
          note: '20% of $19,200 (§5.1)',
        },
        {
          senderItemId: 'referrer',
          receiver: { name: 'Harbor', email: 'fees@harbor.test' },
          amount: USD(72_000n),
          note: '8% (§6.1)',
        },
      ],
    });
    expect(batch.batchStatus).toBe('SUCCESS');
    expect(batch.items.map((i) => i.status)).toEqual(['SUCCESS', 'UNCLAIMED']);
    const again = await sim.createPayout({
      senderBatchId: 'agreement-1:2027-Q1',
      emailSubject: '',
      emailMessage: '',
      items: [],
    });
    expect(again.batchId).toBe(batch.batchId);

    const unclaimed = batch.items[1]!.itemId;
    await sim.returnPayoutItem(unclaimed);
    expect(events.map((e) => e.event_type)).toEqual([
      'PAYMENT.PAYOUTSBATCH.SUCCESS',
      'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
      'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
      'PAYMENT.PAYOUTS-ITEM.RETURNED',
    ]);
    expect(events[1]!.resource).toMatchObject({
      payout_batch_id: batch.batchId,
      payout_item: { sender_item_id: 'kinetic' },
    });

    const txns = await sim.searchTransactions(
      new Date('2027-01-01T00:00:00Z'),
      new Date('2027-02-01T00:00:00Z'),
    );
    expect(txns).toHaveLength(1);
    expect(txns[0]!.amount).toEqual(USD(-384_000n));
  });
});

describe('usage-based billing', () => {
  it('meters usage once per transaction id and alerts when a period crosses the threshold', async () => {
    await sim.createMeter({
      metricCode: 'support_hours',
      name: 'Support hours',
      customer: { ...client, externalId: 'northwind' },
      externalSubscriptionId: 'agreement-1-support',
      rate: USD(4000n),
      includedUnits: 20,
      interval: 'MONTHLY',
      alertAtUnits: 16,
    });
    const usage = (id: string, quantity: number) =>
      sim.recordUsage({
        transactionId: id,
        externalSubscriptionId: 'agreement-1-support',
        metricCode: 'support_hours',
        quantity,
        timestamp: '2027-01-10T00:00:00Z',
      });
    await usage('u1', 10);
    await usage('u1', 10);
    expect(await sim.meterUsage('agreement-1-support', '2027-01-15T00:00:00Z')).toBe(10);
    await usage('u2', 6.5);
    await usage('u3', 9.5);
    const alerts = events.filter(
      (e) => e.event_type === 'USAGE-BILLING.SUBSCRIPTION-ALERT.TRIGGERED',
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.resource).toMatchObject({
      external_subscription_id: 'agreement-1-support',
      current_value: '16.5',
      previous_value: '10',
    });
  });

  it('is refused when the account has no usage billing', async () => {
    const off = new PayPalSimulator({
      store: new MemorySimStore(),
      publicUrl: 'x',
      usageBilling: false,
    });
    expect((await off.capabilities()).usageBilling).toBe(false);
    await expect(
      off.createMeter({
        metricCode: 'm',
        name: 'm',
        customer: { ...client, externalId: 'c' },
        externalSubscriptionId: 's',
        rate: USD(1n),
        includedUnits: 0,
        interval: 'MONTHLY',
        alertAtUnits: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('webhook verification', () => {
  it('accepts only events the simulator sent, unaltered', async () => {
    const o = await order();
    await sim.approveOrder(o.id, client);
    const raw = JSON.stringify(events[0]);
    expect(await sim.verifyWebhook({ headers: {}, rawBody: raw })).toBe(true);
    const forged = JSON.stringify({
      ...events[0],
      resource: { ...events[0]!.resource, status: 'COMPLETED' },
    });
    expect(await sim.verifyWebhook({ headers: {}, rawBody: forged })).toBe(false);
    expect(await sim.verifyWebhook({ headers: {}, rawBody: '{"id":"WH-nope"}' })).toBe(false);
  });
});
