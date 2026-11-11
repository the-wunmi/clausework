import { createHash } from 'node:crypto';
import { addDays, formatDay, formatMoney } from '@clausework/billing';
import { applyBps, DomainError, type Obligation, PAYPAL_PRODUCT } from '@clausework/core';
import { charges, type Db, ledgerEntries, type Tx } from '@clausework/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Engine } from './context.ts';
import { clauseRefs, flowOf, type Live, obligation, party, partyRef } from './live.ts';
import { recordEvent } from './repo.ts';

export type ChargeRow = typeof charges.$inferSelect;

/**
 * A PayPal idempotency key from the things that make a request unique. Hashed to a fixed 31
 * characters, so PayPal's length limits never truncate two different requests into one.
 */
export const requestKey = (...parts: string[]): string =>
  `cw-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 28)}`;

/**
 * Payment terms for an invoice whose clause states none (usage in arrears, a prepaid block, a
 * retainage release). Fifteen days is a common default and is shown on the invoice.
 */
export const DEFAULT_NET_DAYS = 15;

/**
 * The deterministic adapters between charges and PayPal. Each takes a charge row and does exactly
 * one PayPal thing with an idempotency key derived from the charge, so running it twice is safe.
 * Amounts always come from the charge row, which code computed from the approved plan.
 */

export async function loadCharge(
  db: Db | Tx,
  agreementId: string,
  chargeId: string,
): Promise<ChargeRow> {
  const [row] = await db
    .select()
    .from(charges)
    .where(and(eq(charges.id, chargeId), eq(charges.agreementId, agreementId)));
  if (!row) throw new DomainError('not_found', 'No such charge');
  return row;
}

export async function chargeByKey(
  db: Db | Tx,
  agreementId: string,
  key: string,
): Promise<ChargeRow | null> {
  const [row] = await db
    .select()
    .from(charges)
    .where(and(eq(charges.agreementId, agreementId), eq(charges.chargeKey, key)));
  return row ?? null;
}

const quote = (live: Live, ids: string[]) => clauseRefs(live.plan, ids).join(', ');

type ChargeStatus = ChargeRow['status'];

/**
 * Moves a charge between statuses only from the statuses given, so a late or repeated signal
 * (a webhook delivered twice, an unclaimed notice after the claim) cannot undo a later state.
 * Returns the updated row, or null when the charge had already moved on.
 */
export async function transition(
  db: Db | Tx,
  charge: Pick<ChargeRow, 'id'>,
  from: ChargeStatus[],
  set: Partial<typeof charges.$inferInsert>,
): Promise<ChargeRow | null> {
  const [row] = await db
    .update(charges)
    .set(set)
    .where(and(eq(charges.id, charge.id), inArray(charges.status, from)))
    .returning();
  return row ?? null;
}

/** What the payer was actually asked for: the invoice, net of any retainage, else the amount. */
export function amountDue(charge: ChargeRow): bigint | null {
  const invoiced = (charge.paypalData as { invoiced?: string } | null)?.invoiced;
  return invoiced ? BigInt(invoiced) : charge.amount;
}

/** Retainage that applies to a charge for `o`: the rate and the obligation holding it. */
export function retainageFor(
  live: Live,
  o: Obligation,
): { key: string; bps: number; clauseIds: string[] } | null {
  for (const r of live.plan.obligations) {
    if (r.kind === 'retainage' && r.of.includes(o.key)) {
      return { key: r.key, bps: r.bps, clauseIds: r.clauseIds };
    }
  }
  return null;
}

/**
 * Raises a charge the owner collects as a PayPal invoice. A retainage clause on the obligation
 * reduces the invoice and records the held part as its own charge, released later.
 */
export async function issueInvoice(
  engine: Engine,
  live: Live,
  charge: ChargeRow,
  on: string,
): Promise<ChargeRow> {
  if (charge.status !== 'scheduled') return charge;
  if (charge.amount === null || charge.amount <= 0n) {
    throw new DomainError('conflict', `${charge.label} has no amount to invoice`);
  }
  const o = obligation(live, charge.obligationKey);
  const payer = party(live, charge.payer);
  const retainage = o.kind === 'milestone' ? retainageFor(live, o) : null;
  const held = retainage ? applyBps(charge.amount, retainage.bps) : 0n;
  const net = charge.amount - held;
  // Milestones carry their own terms. Other invoices get the default terms, never "due today".
  const due = o.kind === 'milestone' ? addDays(on, o.netDays) : defaultTermsDue(charge, on);
  const m = (v: bigint) => formatMoney(v, charge.currency);
  const description = [
    `${quote(live, charge.clauseIds)}${charge.basis ? `: ${charge.basis}` : ''}`,
    retainage
      ? `Less ${retainage.bps / 100}% retainage (${m(held)}) under ${quote(live, retainage.clauseIds)}, released later.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');
  const invoice = await engine.gateway.createAndSendInvoice({
    requestId: requestKey('invoice', charge.id),
    invoiceNumber: invoiceNumber(charge),
    invoicer: partyRef(live.owner),
    recipient: partyRef(payer),
    lines: [
      {
        name: charge.label,
        description: description.slice(0, 1000),
        quantity: '1',
        unitAmount: { amount: net, currency: charge.currency },
      },
    ],
    invoiceDate: on,
    dueDate: due,
    note: `Raised by Clausework under ${live.plan.title}. Every line cites the clause that requires it.`,
    reference: charge.id,
  });
  // The invoice number makes the PayPal call idempotent; the status guard makes this write so.
  const updated = await transition(engine.db, charge, ['scheduled'], {
    status: 'issued',
    issueDate: on,
    dueDate: due,
    paypalProduct: 'invoicing',
    paypalRef: invoice.id,
    paypalData: {
      invoiceNumber: invoice.number,
      payerViewUrl: invoice.payerViewUrl,
      status: invoice.status,
      invoiced: net.toString(),
    },
    basis: retainage ? `${charge.basis ?? m(charge.amount)}; ${m(held)} retained` : charge.basis,
  });
  if (!updated) return loadCharge(engine.db, live.agreement.id, charge.id);
  if (retainage && held > 0n) {
    await holdRetainage(engine, live, retainage, charge, held, on);
  }
  await recordEvent(engine.db, live.agreement.id, {
    actor: 'system',
    type: 'invoice_issued',
    summary: `Invoiced ${payer.name} ${m(net)} for ${charge.label} (PayPal invoice ${invoice.number}, due ${formatDay(due)})`,
    clauseIds: charge.clauseIds,
    data: { chargeId: charge.id, invoiceId: invoice.id },
    occurredOn: on,
  });
  return updated;
}

/** The charge's own due date, but never sooner than the default payment terms. */
function defaultTermsDue(charge: ChargeRow, on: string): string {
  const terms = addDays(on, DEFAULT_NET_DAYS);
  return charge.dueDate && charge.dueDate > terms ? charge.dueDate : terms;
}

const invoiceNumber = (charge: ChargeRow) =>
  `CW-${charge.agreementId.slice(0, 8).toUpperCase()}-${charge.id.slice(0, 8).toUpperCase()}`;

/** Adds the held part of a milestone to its retainage release charge. */
async function holdRetainage(
  engine: Engine,
  live: Live,
  retainage: { key: string; bps: number; clauseIds: string[] },
  from: ChargeRow,
  held: bigint,
  on: string,
): Promise<void> {
  const release = await chargeByKey(engine.db, live.agreement.id, retainage.key);
  if (!release) return;
  // Added in SQL, so two milestones invoiced together both count.
  await engine.db
    .update(charges)
    .set({
      amount: sql`coalesce(${charges.amount}, 0) + ${held}`,
      status: 'held',
      basis: 'Held from milestone payments',
    })
    .where(and(eq(charges.id, release.id), inArray(charges.status, ['scheduled', 'held'])));
  await recordEvent(engine.db, live.agreement.id, {
    actor: 'system',
    type: 'retainage_held',
    summary: `Held ${formatMoney(held, from.currency)} of ${from.label} as retainage`,
    clauseIds: retainage.clauseIds,
    data: { chargeId: release.id },
    occurredOn: on,
  });
}

/** Pays a charge the owner owes another party, as a PayPal payout. */
export async function payOut(
  engine: Engine,
  live: Live,
  charge: ChargeRow,
  on: string,
  attempt = 0,
): Promise<ChargeRow> {
  // Never from `unclaimed`: the first payout can still be claimed, and a second would pay twice.
  if (!['scheduled', 'failed'].includes(charge.status)) return charge;
  if (charge.amount === null || charge.amount <= 0n) {
    throw new DomainError('conflict', `${charge.label} has no amount to pay`);
  }
  const payee = party(live, charge.payee);
  const m = formatMoney(charge.amount, charge.currency);
  const line = `${m} under ${quote(live, charge.clauseIds)}${charge.basis ? `: ${charge.basis}` : ''}`;
  const payout = await engine.gateway.createPayout({
    senderBatchId: `cw-${charge.id.slice(0, 24)}-${attempt}`,
    emailSubject: `${live.owner.name} sent you ${m}`,
    emailMessage: `${charge.label}. ${line}`,
    items: [
      {
        senderItemId: charge.id,
        receiver: partyRef(payee),
        amount: { amount: charge.amount, currency: charge.currency },
        note: line.slice(0, 4000),
      },
    ],
  });
  const item = payout.items[0];
  const updated = await transition(engine.db, charge, ['scheduled', 'failed'], {
    status: 'issued',
    issueDate: on,
    paypalProduct: 'payouts',
    paypalRef: payout.batchId,
    paypalData: { batchId: payout.batchId, itemId: item?.itemId ?? null, attempt, statement: line },
  });
  if (!updated) return loadCharge(engine.db, live.agreement.id, charge.id);
  await recordEvent(engine.db, live.agreement.id, {
    actor: 'system',
    type: 'payout_sent',
    summary: `Sent ${payee.name} ${m} for ${charge.label} (PayPal payout ${payout.batchId})`,
    clauseIds: charge.clauseIds,
    data: { chargeId: charge.id, batchId: payout.batchId },
    occurredOn: on,
  });
  return updated;
}

/** Raises a charge in whichever direction its money runs. */
export async function raise(
  engine: Engine,
  live: Live,
  charge: ChargeRow,
  on: string,
): Promise<ChargeRow> {
  const flow = flowOf(live, charge);
  if (flow === 'collect') return issueInvoice(engine, live, charge, on);
  if (flow === 'pay') return payOut(engine, live, charge, on);
  return (
    (await transition(engine.db, charge, ['scheduled'], { status: 'issued', issueDate: on })) ??
    charge
  );
}

/**
 * Records money that moved, once per PayPal movement. In one transaction: the ledger entry, the
 * charge's status (paid once what was asked for is covered) and any splits the receipt owes
 * others, which the rules then pay out. A retried webhook finds the entry and changes nothing.
 */
export async function recordMovement(
  engine: Engine,
  live: Live,
  charge: ChargeRow,
  movement: {
    amount: bigint;
    paypalRef: string;
    on: string;
    memo: string;
    kind: 'collected' | 'paid_out';
  },
): Promise<boolean> {
  const recorded = await engine.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(ledgerEntries)
      .values({
        agreementId: live.agreement.id,
        chargeId: charge.id,
        obligationKey: charge.obligationKey,
        kind: movement.kind,
        fromParty: charge.payer,
        toParty: charge.payee,
        amount: movement.amount,
        currency: charge.currency,
        paypalRef: movement.paypalRef,
        dedupeKey: `${movement.kind}:${movement.paypalRef}`,
        memo: movement.memo,
        occurredOn: movement.on,
      })
      .onConflictDoNothing()
      .returning({ id: ledgerEntries.id });
    if (inserted.length === 0) return null;

    const [moved] = await tx
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amount}), 0)` })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.chargeId, charge.id), eq(ledgerEntries.kind, movement.kind)));
    const total = BigInt(moved?.total ?? '0');
    const due = amountDue(charge) ?? movement.amount;
    const covered = total >= due;
    if (covered) {
      await transition(
        tx,
        charge,
        [
          'scheduled',
          'awaiting_approval',
          'authorized',
          'issued',
          'overdue',
          'failed',
          'unclaimed',
          'held',
        ],
        {
          status: 'paid',
          paidOn: movement.on,
          amount: charge.amount ?? movement.amount,
        },
      );
    }
    if (movement.kind === 'collected') {
      await scheduleSplits(tx, live, charge, movement.amount, movement.paypalRef, movement.on);
    }
    return { covered, total, due };
  });
  if (!recorded) return false;

  const m = formatMoney(movement.amount, charge.currency);
  const partly = recorded.covered
    ? ''
    : ` (${formatMoney(recorded.total, charge.currency)} of ${formatMoney(recorded.due, charge.currency)} so far)`;
  await recordEvent(engine.db, live.agreement.id, {
    actor: 'paypal',
    type: movement.kind === 'collected' ? 'payment_received' : 'payout_completed',
    summary:
      movement.kind === 'collected'
        ? `${party(live, charge.payer).name} paid ${m} for ${charge.label}${partly}`
        : `${party(live, charge.payee).name} received ${m} for ${charge.label}${partly}`,
    clauseIds: charge.clauseIds,
    data: { chargeId: charge.id, paypalRef: movement.paypalRef },
    occurredOn: movement.on,
  });
  return true;
}

/** A receipt for an obligation others share in owes them a payout, one per receipt. */
async function scheduleSplits(
  tx: Tx,
  live: Live,
  from: ChargeRow,
  received: bigint,
  ref: string,
  on: string,
): Promise<void> {
  for (const o of live.plan.obligations) {
    if (o.kind !== 'split' || !o.of.includes(from.obligationKey)) continue;
    const amount = applyBps(received, o.bps);
    if (amount <= 0n) continue;
    await tx
      .insert(charges)
      .values({
        agreementId: live.agreement.id,
        versionId: live.version.row.id,
        chargeKey: `${o.key}:${ref}`,
        obligationKey: o.key,
        kind: o.kind,
        // "Kinetic share of Design System milestone" already names its source; add it only if not.
        label: o.title.includes(from.label) ? o.title : `${o.title} · ${from.label}`,
        payer: o.payer,
        payee: o.payee,
        amount,
        currency: from.currency,
        status: 'scheduled',
        issueDate: on,
        dueDate: addDays(on, 5),
        clauseIds: o.clauseIds,
        paypalProduct: PAYPAL_PRODUCT.split,
        basis: `${o.bps / 100}% of ${formatMoney(received, from.currency)} received for ${from.label}`,
      })
      .onConflictDoNothing();
  }
}

/**
 * Captures an authorized deposit and records it from PayPal's answer. The webhook that follows
 * finds the movement already recorded (same capture id) and changes nothing.
 */
export async function captureDeposit(
  engine: Engine,
  live: Live,
  charge: ChargeRow,
  authorizationId: string,
  on: string,
) {
  const capture = await engine.gateway.captureAuthorization(
    authorizationId,
    requestKey('capture', charge.id),
    null,
  );
  // Remember the capture, so a pending one is waited on, never captured again.
  await engine.db
    .update(charges)
    .set({ paypalData: { ...(charge.paypalData as object), captureId: capture.id } })
    .where(eq(charges.id, charge.id));
  if (capture.status === 'COMPLETED') {
    await recordMovement(engine, live, charge, {
      amount: capture.amount.amount,
      paypalRef: capture.id,
      on,
      memo: `PayPal capture ${capture.id}`,
      kind: 'collected',
    });
  }
  return capture;
}
