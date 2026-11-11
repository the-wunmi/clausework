import { addDays, count, formatMoney } from '@clausework/billing';
import { fromMajor, toMajor } from '@clausework/core';
import { bindings, charges, ledgerEntries, webhookEvents } from '@clausework/db';
import type { WebhookEvent, WebhookRequest } from '@clausework/paypal';
import { and, asc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { type Engine, serially, today } from './context.ts';
import { consult } from './decisions.ts';
import { type Live, loadLive, party } from './live.ts';
import { type ChargeRow, recordMovement, requestKey, transition } from './money.ts';
import { type AgreementRow, isUuid, recordEvent } from './repo.ts';
import { tick } from './rules.ts';
import { enqueueWebhook } from './workflows.ts';

/**
 * PayPal tells us what happened through webhooks. Each delivery is checked, stored once by its
 * event id (PayPal repeats deliveries) and processed in a job, so a slow or failing step retries
 * without losing the event.
 */
export async function receiveWebhook(
  engine: Engine,
  request: WebhookRequest,
): Promise<{ accepted: boolean }> {
  let event: WebhookEvent;
  try {
    event = JSON.parse(request.rawBody) as WebhookEvent;
  } catch {
    return { accepted: false };
  }
  if (!event?.id || !event.event_type) return { accepted: false };
  const verified = await engine.gateway.verifyWebhook(request);
  if (!verified) {
    engine.log('webhook rejected: signature did not verify', {
      id: event.id,
      type: event.event_type,
    });
    return { accepted: false };
  }
  await storeAndQueue(engine, event);
  return { accepted: true };
}

/** Events from an in-process PayPal (the test simulator) arrive already trusted. */
export async function receiveSimulatedEvent(engine: Engine, event: WebhookEvent): Promise<void> {
  await storeAndQueue(engine, event);
}

/** Stores an event whose origin is already established, and queues it unless it was seen before. */
async function storeAndQueue(engine: Engine, event: WebhookEvent): Promise<void> {
  const inserted = await engine.db
    .insert(webhookEvents)
    .values({
      id: event.id,
      type: event.event_type,
      resourceId: typeof event.resource?.id === 'string' ? event.resource.id : null,
      payload: event,
      verified: true,
    })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  if (inserted.length > 0) {
    const agreementId = await agreementOfEvent(engine, event.resource as Record<string, unknown>);
    await enqueueWebhook(event.id, agreementId);
  }
}

/** The PayPal events Clausework acts on; `pnpm webhook:register` subscribes to exactly these. */
export const HANDLED_EVENTS = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
  'PAYMENT.CAPTURE.REFUNDED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED',
  'INVOICING.INVOICE.PAID',
  'INVOICING.INVOICE.CANCELLED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'USAGE-BILLING.SUBSCRIPTION-ALERT.TRIGGERED',
] as const;

/** Subscription states after which the payer has nothing left to approve. */
export const SUBSCRIPTION_DECIDED = ['ACTIVE', 'APPROVED', 'SUSPENDED', 'CANCELLED', 'EXPIRED'];

/** What a payout item's status at PayPal means, as the webhook that would have reported it. */
const PAYOUT_EVENT: Partial<Record<string, string>> = {
  SUCCESS: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  UNCLAIMED: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  RETURNED: 'PAYMENT.PAYOUTS-ITEM.RETURNED',
  FAILED: 'PAYMENT.PAYOUTS-ITEM.FAILED',
  BLOCKED: 'PAYMENT.PAYOUTS-ITEM.FAILED',
};

/** Charges raised this recently are asked about on every frequent check. */
const RECENT_DAYS = 14;

/**
 * Asks PayPal about everything still waiting on it: deposits and subscriptions the payer may have
 * approved, invoices that may be paid, payouts that may have settled. Webhooks are the fast path,
 * but PayPal can deliver them late or not at all (sandbox invoice payments especially), and a payer
 * returning from checkout should see the result at once. What it finds is stored and handled as the
 * matching webhook would be, so the real webhook then finds nothing left to change.
 */
export async function reconcileWithPayPal(
  engine: Engine,
  agreement: AgreementRow,
  options: { thorough?: boolean } = {},
): Promise<void> {
  const create_time = new Date().toISOString();
  const report = (paypalId: string, status: string, event_type: string, resource: object) =>
    storeAndQueue(engine, {
      id: `sync:${paypalId}:${status}`,
      event_type,
      create_time,
      resource: resource as Record<string, unknown>,
    });

  const setup = await engine.db
    .select()
    .from(bindings)
    .where(
      and(
        eq(bindings.agreementId, agreement.id),
        inArray(bindings.role, ['deposit_order', 'subscription']),
      ),
    );
  for (const b of setup) {
    try {
      await reconcileSetup(engine, agreement, b, report);
    } catch (err) {
      engine.log('PayPal check failed for a setup step', {
        binding: b.paypalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The frequent check asks only about charges raised in the last fortnight, which is when
  // payments land; the hourly thorough check asks about everything still open.
  const since = addDays(await today(engine.db), -RECENT_DAYS);
  const open = await engine.db
    .select()
    .from(charges)
    .where(
      and(
        eq(charges.agreementId, agreement.id),
        inArray(charges.status, ['issued', 'overdue', 'unclaimed']),
        options.thorough ? undefined : gte(charges.issueDate, since),
      ),
    );
  for (const charge of open) {
    try {
      await reconcileCharge(engine, charge, report);
    } catch (err) {
      // One charge PayPal cannot answer for (deleted, say) must not hide the others.
      engine.log('PayPal check failed for a charge', {
        charge: charge.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

type Report = (
  paypalId: string,
  status: string,
  event_type: string,
  resource: object,
) => Promise<void>;

/** A deposit or subscription the payer may have approved at PayPal. */
async function reconcileSetup(
  engine: Engine,
  agreement: AgreementRow,
  b: typeof bindings.$inferSelect,
  report: Report,
): Promise<void> {
  if (b.role === 'deposit_order') {
    const [charge] = await engine.db
      .select()
      .from(charges)
      .where(and(eq(charges.agreementId, agreement.id), eq(charges.chargeKey, b.obligationKey)));
    if (charge?.status !== 'awaiting_approval') return;
    const order = await engine.gateway.getOrder(b.paypalId);
    if (order.status !== 'APPROVED') return;
    await report(b.paypalId, order.status, 'CHECKOUT.ORDER.APPROVED', {
      id: b.paypalId,
      purchase_units: [{ custom_id: charge.id }],
    });
  } else if (!SUBSCRIPTION_DECIDED.includes(b.state)) {
    const sub = await engine.gateway.getSubscription(b.paypalId);
    if (sub.status !== 'ACTIVE') return;
    await report(b.paypalId, sub.status, 'BILLING.SUBSCRIPTION.ACTIVATED', {
      id: b.paypalId,
      status: sub.status,
    });
  }
}

async function reconcileCharge(engine: Engine, charge: ChargeRow, report: Report): Promise<void> {
  if (!charge.paypalRef) return;
  if (charge.paypalProduct === 'invoicing' && charge.status !== 'unclaimed') {
    const invoice = await engine.gateway.getInvoice(charge.paypalRef);
    if (invoice.status === 'PAID' || invoice.status === 'MARKED_AS_PAID') {
      const paid = invoice.paid ?? invoice.amount;
      await report(invoice.id, invoice.status, 'INVOICING.INVOICE.PAID', {
        id: invoice.id,
        detail: { reference: charge.id, invoice_number: invoice.number },
        payments: {
          paid_amount: {
            value: toMajor(paid.amount, paid.currency),
            currency_code: paid.currency,
          },
        },
      });
    } else if (invoice.status === 'CANCELLED') {
      await report(invoice.id, invoice.status, 'INVOICING.INVOICE.CANCELLED', {
        id: invoice.id,
        detail: { reference: charge.id },
      });
    }
  } else if (charge.paypalProduct === 'payouts') {
    const payout = await engine.gateway.getPayout(charge.paypalRef);
    const item = payout.items.find((i) => i.senderItemId === charge.id);
    const event_type = item ? PAYOUT_EVENT[item.status] : undefined;
    if (!item || !event_type) return;
    // An unclaimed payout stays unclaimed until PayPal says it was claimed or returned.
    if (charge.status === 'unclaimed' && item.status === 'UNCLAIMED') return;
    await report(item.itemId, item.status, event_type, {
      payout_item_id: item.itemId,
      transaction_status: item.status,
      payout_item: {
        sender_item_id: charge.id,
        amount: {
          value: toMajor(charge.amount ?? 0n, charge.currency),
          currency: charge.currency,
        },
      },
    });
  }
}

export async function processWebhook(engine: Engine, eventId: string): Promise<void> {
  const [row] = await engine.db
    .select()
    .from(webhookEvents)
    .where(and(eq(webhookEvents.id, eventId), isNull(webhookEvents.processedAt)));
  if (!row) return;
  const event = row.payload as WebhookEvent;
  const r = event.resource as Record<string, unknown>;
  const lane = (await agreementOfEvent(engine, r)) ?? 'unmatched-webhooks';
  await serially(engine, lane, async () => {
    const on = await today(engine.db);
    const agreementId = await handle(engine, event, r, on);
    await engine.db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(webhookEvents.id, eventId));
    // Whatever just happened may unblock work: a captured deposit, a paid gate, a due cycle.
    if (agreementId) await tick(engine, await loadLive(engine.db, agreementId), on);
  });
}

/** The agreement an event is about, from whichever id PayPal put where. */
async function agreementOfEvent(
  engine: Engine,
  r: Record<string, unknown>,
): Promise<string | null> {
  const unit = obj((r.purchase_units as unknown[] | undefined)?.[0]);
  const chargeId =
    str(unit.custom_id) ??
    str(r.custom_id) ??
    str(obj(r.detail).reference) ??
    str(obj(r.payout_item).sender_item_id);
  const charge = await chargeById(engine, chargeId);
  if (charge) return charge.agreementId;
  const binding = await bindingByPayPalId(
    engine,
    str(r.billing_agreement_id) ?? str(r.external_subscription_id) ?? str(r.id),
  );
  return binding?.agreementId ?? null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

async function chargeById(engine: Engine, id: string | null): Promise<ChargeRow | null> {
  if (!id || !isUuid(id)) return null;
  const [row] = await engine.db.select().from(charges).where(eq(charges.id, id));
  return row ?? null;
}

async function bindingByPayPalId(engine: Engine, paypalId: string | null) {
  if (!paypalId) return null;
  const [row] = await engine.db.select().from(bindings).where(eq(bindings.paypalId, paypalId));
  return row ?? null;
}

/** Returns the agreement the event was about, when it was about one. */
async function handle(
  engine: Engine,
  event: WebhookEvent,
  r: Record<string, unknown>,
  on: string,
): Promise<string | null> {
  switch (event.event_type) {
    case 'CHECKOUT.ORDER.APPROVED': {
      const unit = obj((r.purchase_units as unknown[] | undefined)?.[0]);
      const charge = await chargeById(engine, str(unit.custom_id));
      if (charge?.status !== 'awaiting_approval') return charge?.agreementId ?? null;
      const live = await loadLive(engine.db, charge.agreementId);
      const auth = await engine.gateway.authorizeOrder(
        String(r.id),
        requestKey('authorize', charge.id),
      );
      await transition(engine.db, charge, ['awaiting_approval'], {
        status: 'authorized',
        paypalData: {
          ...(charge.paypalData as object),
          authorizationId: auth.id,
          authorizedOn: on,
          honorUntil: auth.honorUntil,
          expiresAt: auth.expiresAt,
        },
      });
      await recordEvent(engine.db, live.agreement.id, {
        actor: `party:${charge.payer}`,
        type: 'deposit_authorized',
        summary: `${party(live, charge.payer).name} authorized the ${formatMoney(charge.amount ?? 0n, charge.currency)} deposit on PayPal (authorization ${auth.id}); it is captured when work starts`,
        clauseIds: charge.clauseIds,
        occurredOn: on,
      });
      return live.agreement.id;
    }
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const charge = await chargeById(engine, str(r.custom_id));
      if (!charge) return null;
      const live = await loadLive(engine.db, charge.agreementId);
      const amount = obj(r.amount);
      await recordMovement(engine, live, charge, {
        amount: fromMajor(String(amount.value), String(amount.currency_code)),
        paypalRef: String(r.id),
        on,
        memo: `PayPal capture ${String(r.id)}`,
        kind: 'collected',
      });
      return live.agreement.id;
    }
    case 'PAYMENT.CAPTURE.DENIED': {
      const charge = await chargeById(engine, str(r.custom_id));
      if (!charge) return null;
      if (
        !(await transition(engine.db, charge, ['authorized', 'awaiting_approval'], {
          status: 'failed',
        }))
      ) {
        return charge.agreementId;
      }
      const live = await loadLive(engine.db, charge.agreementId);
      await consult(engine, live, on, {
        key: `capture_denied:${charge.id}:${String(r.id)}`,
        kind: 'payment_failed',
        summary: `PayPal declined the capture for ${charge.label}`,
        details: { chargeId: charge.id },
      });
      return live.agreement.id;
    }
    case 'PAYMENT.CAPTURE.REFUNDED': {
      const charge = await chargeById(engine, str(r.custom_id));
      if (!charge) return null;
      const amount = obj(r.amount);
      const refunded = fromMajor(String(amount.value), String(amount.currency_code));
      await engine.db
        .insert(ledgerEntries)
        .values({
          agreementId: charge.agreementId,
          chargeId: charge.id,
          obligationKey: charge.obligationKey,
          kind: 'refunded',
          fromParty: charge.payee,
          toParty: charge.payer,
          amount: refunded,
          currency: charge.currency,
          paypalRef: String(r.id),
          dedupeKey: `refunded:${String(r.id)}`,
          memo: `PayPal refund ${String(r.id)}`,
          occurredOn: on,
        })
        .onConflictDoNothing();
      await transition(engine.db, charge, ['paid'], { status: 'refunded' });
      return charge.agreementId;
    }
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED': {
      const binding = await bindingByPayPalId(engine, str(r.id));
      if (!binding) return null;
      const state = String(r.status ?? event.event_type.split('.').pop());
      // Already known, from the payer's return or an earlier delivery: nothing new to record.
      if (binding.state === state) return binding.agreementId;
      await engine.db.update(bindings).set({ state }).where(eq(bindings.id, binding.id));
      const live = await loadLive(engine.db, binding.agreementId);
      const o = live.plan.obligations.find((x) => x.key === binding.obligationKey);
      await recordEvent(engine.db, live.agreement.id, {
        actor: event.event_type.endsWith('ACTIVATED') && o ? `party:${o.payer}` : 'paypal',
        type: 'subscription_state',
        summary: event.event_type.endsWith('ACTIVATED')
          ? `${o ? party(live, o.payer).name : 'The payer'} approved the ${o?.title ?? 'subscription'} on PayPal (${binding.paypalId})`
          : `PayPal subscription ${binding.paypalId} is now ${state.toLowerCase()}`,
        clauseIds: o?.clauseIds ?? [],
        occurredOn: on,
      });
      return live.agreement.id;
    }
    case 'PAYMENT.SALE.COMPLETED': {
      const binding = await bindingByPayPalId(engine, str(r.billing_agreement_id));
      if (!binding) return null;
      const live = await loadLive(engine.db, binding.agreementId);
      const charge = await nextPeriod(engine, live, binding.obligationKey);
      if (!charge) return live.agreement.id;
      const amount = obj(r.amount);
      await recordMovement(engine, live, charge, {
        amount: fromMajor(String(amount.total), String(amount.currency)),
        paypalRef: String(r.id),
        on,
        memo: `PayPal subscription payment ${String(r.id)}`,
        kind: 'collected',
      });
      return live.agreement.id;
    }
    case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
      const binding = await bindingByPayPalId(engine, str(r.id));
      if (!binding) return null;
      const live = await loadLive(engine.db, binding.agreementId);
      const charge = await nextPeriod(engine, live, binding.obligationKey);
      if (!charge) return live.agreement.id;
      if (!(await transition(engine.db, charge, ['scheduled'], { status: 'failed' }))) {
        return live.agreement.id;
      }
      await recordEvent(engine.db, live.agreement.id, {
        actor: 'paypal',
        type: 'payment_failed',
        summary: `PayPal could not collect ${charge.label} from ${party(live, charge.payer).name}`,
        clauseIds: charge.clauseIds,
        occurredOn: on,
      });
      await consult(engine, live, on, {
        key: `sub_failed:${charge.id}`,
        kind: 'subscription_payment_failed',
        summary: `The PayPal subscription payment for ${charge.label} failed`,
        details: {
          chargeId: charge.id,
          failedPayments: obj(r.billing_info).failed_payments_count ?? null,
        },
      });
      return live.agreement.id;
    }
    case 'INVOICING.INVOICE.PAID': {
      const detail = obj(r.detail);
      const charge = await chargeById(engine, str(detail.reference));
      if (!charge) return null;
      const live = await loadLive(engine.db, charge.agreementId);
      const paid = obj(obj(r.payments).paid_amount);
      await recordMovement(engine, live, charge, {
        amount: paid.value
          ? fromMajor(String(paid.value), String(paid.currency_code))
          : (charge.amount ?? 0n),
        paypalRef: String(r.id),
        on,
        memo: `PayPal invoice ${String(detail.invoice_number ?? r.id)} paid`,
        kind: 'collected',
      });
      return live.agreement.id;
    }
    case 'INVOICING.INVOICE.CANCELLED': {
      const charge = await chargeById(engine, str(obj(r.detail).reference));
      if (!charge) return null;
      await transition(engine.db, charge, ['issued', 'overdue'], { status: 'cancelled' });
      return charge.agreementId;
    }
    case 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED':
    case 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED':
    case 'PAYMENT.PAYOUTS-ITEM.RETURNED':
    case 'PAYMENT.PAYOUTS-ITEM.FAILED': {
      const item = obj(r.payout_item);
      const charge = await chargeById(engine, str(item.sender_item_id));
      if (!charge) return null;
      const live = await loadLive(engine.db, charge.agreementId);
      const itemId = String(r.payout_item_id);
      if (event.event_type.endsWith('SUCCEEDED')) {
        const amount = obj(item.amount);
        await recordMovement(engine, live, charge, {
          amount: fromMajor(String(amount.value), String(amount.currency)),
          paypalRef: itemId,
          on,
          memo: `PayPal payout ${itemId}`,
          kind: 'paid_out',
        });
        return live.agreement.id;
      }
      const unclaimed = event.event_type.endsWith('UNCLAIMED');
      // Never back from paid: an unclaimed notice can arrive after the claim.
      const moved = await transition(
        engine.db,
        charge,
        unclaimed ? ['issued'] : ['issued', 'unclaimed'],
        {
          status: unclaimed ? 'unclaimed' : 'failed',
        },
      );
      if (!moved) return live.agreement.id;
      await recordEvent(engine.db, live.agreement.id, {
        actor: 'paypal',
        type: unclaimed ? 'payout_unclaimed' : 'payout_returned',
        summary: unclaimed
          ? `${party(live, charge.payee).name} has not claimed the ${formatMoney(charge.amount ?? 0n, charge.currency)} payout for ${charge.label}; PayPal returns it after 30 days`
          : `PayPal returned the payout for ${charge.label}`,
        clauseIds: charge.clauseIds,
        occurredOn: on,
      });
      await consult(engine, live, on, {
        key: `payout:${charge.id}:${itemId}:${event.event_type}`,
        kind: unclaimed ? 'payout_unclaimed' : 'payout_returned',
        summary: unclaimed
          ? `The payout to ${party(live, charge.payee).name} for ${charge.label} is unclaimed`
          : `The payout to ${party(live, charge.payee).name} for ${charge.label} was returned`,
        details: { chargeId: charge.id, payee: charge.payee },
      });
      return live.agreement.id;
    }
    case 'USAGE-BILLING.SUBSCRIPTION-ALERT.TRIGGERED': {
      const binding = await bindingByPayPalId(engine, str(r.external_subscription_id));
      if (!binding) return null;
      const live = await loadLive(engine.db, binding.agreementId);
      const o = live.plan.obligations.find((x) => x.key === binding.obligationKey);
      if (o?.kind !== 'usage') return live.agreement.id;
      await recordEvent(engine.db, live.agreement.id, {
        actor: 'paypal',
        type: 'usage_alert',
        summary: `Usage alert: ${count(Number(r.current_value ?? 0), o.unit)} of ${o.title} used this period, past ${o.alertAtBps ? o.alertAtBps / 100 : ''}% of the ${o.included} included; ${party(live, o.payer).name} notified`,
        clauseIds: o.clauseIds,
        occurredOn: on,
      });
      return live.agreement.id;
    }
    default:
      return null;
  }
}

/** The subscription period a sale or failure is for: the earliest not yet settled. */
async function nextPeriod(
  engine: Engine,
  live: Live,
  obligationKey: string,
): Promise<ChargeRow | null> {
  const [row] = await engine.db
    .select()
    .from(charges)
    .where(
      and(
        eq(charges.agreementId, live.agreement.id),
        eq(charges.obligationKey, obligationKey),
        inArray(charges.status, ['scheduled', 'failed']),
      ),
    )
    .orderBy(asc(charges.periodIndex))
    .limit(1);
  return row ?? null;
}

/**
 * Webhooks stored but not handled a minute later: the process stopped between storing one and
 * queueing it, or its workflow gave up. Queued again under `attempt`, a new workflow id.
 */
export async function requeueUnprocessedWebhooks(engine: Engine, attempt: string): Promise<number> {
  const stale = await engine.db
    .select({ id: webhookEvents.id, payload: webhookEvents.payload })
    .from(webhookEvents)
    .where(
      and(
        isNull(webhookEvents.processedAt),
        lt(webhookEvents.createdAt, new Date(Date.now() - 60_000)),
      ),
    );
  for (const w of stale) {
    const resource = (w.payload as WebhookEvent).resource as Record<string, unknown>;
    await enqueueWebhook(w.id, await agreementOfEvent(engine, resource), attempt);
  }
  return stale.length;
}
