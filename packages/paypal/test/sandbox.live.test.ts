import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PayPalRest } from '../src/index.ts';

/**
 * Against the real PayPal sandbox, with the credentials in .env. Off unless CLAUSEWORK_LIVE=1
 * (`pnpm test:live`): it creates real sandbox objects and takes a minute. It checks that every
 * request Clausework builds is one PayPal accepts, which the simulator cannot prove.
 */
const envFile = new URL('../../../.env', import.meta.url).pathname;
if (existsSync(envFile)) process.loadEnvFile(envFile);
const live = process.env.CLAUSEWORK_LIVE === '1';

const usd = (amount: bigint) => ({ amount, currency: 'USD' });
const run = randomUUID().slice(0, 8);
const today = new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const party = (name: string) => ({ name, email: `${name.toLowerCase()}@example.com` });

describe.skipIf(!live)('PayPal sandbox', { timeout: 60_000 }, () => {
  const pp = new PayPalRest({
    clientId: process.env.PAYPAL_CLIENT_ID as string,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET as string,
    mode: 'sandbox',
  });

  it('creates a deposit order to authorize, with a link for the payer', async () => {
    const order = await pp.createOrder({
      intent: 'AUTHORIZE',
      amount: usd(1_440_000n),
      description: 'Deposit (§3.1)',
      customId: `live-${run}`,
      invoiceId: `live-dep-${run}`,
      payee: party('Brightline'),
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
      requestId: `live-order-${run}`,
    });
    expect(order.status).toBe('PAYER_ACTION_REQUIRED');
    expect(order.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    expect((await pp.getOrder(order.id)).authorizationId).toBeNull();
  });

  it('creates a retainer plan, reprices it, and offers a subscription that can be withdrawn', async () => {
    const plan = await pp.createPlan({
      requestId: `live-${run}`,
      productName: 'Retainer',
      productDescription: 'Monthly retainer (§4.1)',
      planName: 'Retainer USD 3,000 a month',
      amount: usd(300_000n),
      interval: 'MONTH',
      intervalCount: 1,
      cycles: null,
    });
    expect(plan.status).toBe('ACTIVE');
    await pp.updatePlanPrice(plan.planId, usd(309_000n));
    const start = new Date(Date.now() + 86_400_000);
    start.setUTCHours(0, 0, 0, 0);
    const sub = await pp.createSubscription({
      planId: plan.planId,
      startTime: start.toISOString(),
      customId: `live-${run}`,
      subscriber: party('Northwind'),
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
      requestId: `live-sub-${run}`,
    });
    expect(sub.status).toBe('APPROVAL_PENDING');
    // PayPal answers 404 to cancelling a subscription nobody approved; that counts as done.
    await expect(pp.cancelSubscription(sub.id, 'live test')).resolves.toBeUndefined();
  });

  it('sends an invoice net of retainage once per number, reminds, and cancels it', async () => {
    const input = {
      invoiceNumber: `CW-LIVE-${run}`,
      requestId: `live-invoice-${run}`,
      reference: 'Design System milestone (§5.2)',
      invoiceDate: today,
      dueDate: inDays(15),
      note: 'Live test',
      invoicer: party('Brightline'),
      recipient: party('Northwind'),
      lines: [
        {
          name: 'Design System',
          description: 'Milestone',
          quantity: '1',
          unitAmount: usd(1_920_000n),
        },
        { name: 'Retainage (10%)', description: 'Held', quantity: '1', unitAmount: usd(-192_000n) },
      ],
    };
    const sent = await pp.createAndSendInvoice(input);
    expect(sent).toMatchObject({ status: 'SENT', amount: usd(1_728_000n) });
    expect((await pp.createAndSendInvoice(input)).id).toBe(sent.id);
    await pp.remindInvoice(sent.id, 'Reminder');
    await pp.cancelInvoice(sent.id, 'Live test');
    expect((await pp.getInvoice(sent.id)).status).toBe('CANCELLED');
  });

  it('sends a payout by email and reports its item', async () => {
    const payout = await pp.createPayout({
      senderBatchId: `live-${run}`,
      emailSubject: 'Your share',
      emailMessage: 'Subcontractor split (§6.1)',
      items: [
        {
          senderItemId: `live-item-${run}`,
          receiver: party('Kinetic'),
          note: 'Split',
          amount: usd(100n),
        },
      ],
    });
    expect(payout.batchId).toMatch(/^[A-Z0-9]+$/);
    const read = await pp.getPayout(payout.batchId);
    expect(read.items.map((i) => i.senderItemId)).toEqual([`live-item-${run}`]);
  });

  it('refuses a webhook it cannot verify', async () => {
    const withId = new PayPalRest({
      clientId: process.env.PAYPAL_CLIENT_ID as string,
      clientSecret: process.env.PAYPAL_CLIENT_SECRET as string,
      mode: 'sandbox',
      webhookId: process.env.PAYPAL_WEBHOOK_ID || 'WH-none',
    });
    const forged = await withId.verifyWebhook({
      rawBody: JSON.stringify({ id: 'WH-forged', event_type: 'PAYMENT.CAPTURE.COMPLETED' }),
      headers: {
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-x',
        'paypal-transmission-id': randomUUID(),
        'paypal-transmission-sig': 'Zm9yZ2Vk',
        'paypal-transmission-time': new Date().toISOString(),
      },
    });
    expect(forged).toBe(false);
  });
});
