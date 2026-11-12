import {
  addDays,
  count,
  formatMoney,
  type ProjectedCharge,
  projectCharges,
  resolveAmount,
} from '@clausework/billing';
import {
  applyBps,
  CONFIDENT,
  DomainError,
  type Obligation,
  productFor,
  startOfDay,
} from '@clausework/core';
import { agreements, bindings, charges, type Tx } from '@clausework/db';
import type { Capabilities } from '@clausework/paypal';
import { and, eq, gte, sql } from 'drizzle-orm';
import {
  type Engine,
  runDirectly,
  type Step,
  serially,
  today,
  workspaceTimeZone,
} from './context.ts';
import {
  clauseRefs,
  flowOf,
  type Live,
  liveAgreementIds,
  loadLive,
  party,
  partyRef,
} from './live.ts';
import { type ChargeRow, chargeByKey, requestKey } from './money.ts';
import {
  type AgreementRow,
  currentVersion,
  latestApprovals,
  partiesWhoMustApprove,
  recordEvent,
} from './repo.ts';
import { enqueuePayPalSetup } from './workflows.ts';

/**
 * Going live. Only when every party who pays or is paid has approved the exact version under
 * review: the version becomes live, its charges are laid out from the projection, and the PayPal
 * objects that need the payer's consent (a deposit authorization, a subscription) are created so
 * the payer can approve them on PayPal.
 */
export async function activate(engine: Engine, agreement: AgreementRow): Promise<void> {
  await serially(engine, agreement.id, () => activateVersion(engine, agreement));
}

async function activateVersion(engine: Engine, agreement: AgreementRow): Promise<void> {
  const version = await currentVersion(engine.db, agreement);
  if (!version) throw new DomainError('conflict', 'Nothing to activate yet');
  if (agreement.liveVersionId === version.row.id) return;
  if (!agreement.ownerParty) throw new DomainError('conflict', 'Choose which party you are first');
  const latest = await latestApprovals(engine.db, agreement.id, version.row.id);
  const missing = partiesWhoMustApprove(version.plan).filter((p) => {
    const a = latest.get(p);
    return a?.decision !== 'approved' || a.planHash !== version.row.hash;
  });
  if (missing.length > 0) {
    throw new DomainError('conflict', `Waiting for approval from ${missing.join(', ')}`);
  }
  const failing = (version.row.testResults as { pass: boolean }[]).filter((t) => !t.pass).length;
  if (failing > 0) {
    throw new DomainError('conflict', `${failing} generated tests still fail; fix the plan first`);
  }
  const on = await today(engine.db);
  // Money moves only on terms a person has stood behind: an unsure obligation is confirmed or
  // corrected by the owner first, and an agreement already over is audited, not billed.
  const unsure = version.plan.obligations.filter((o) => o.confidence < CONFIDENT);
  if (unsure.length > 0) {
    throw new DomainError(
      'conflict',
      `Confirm or correct ${unsure.map((o) => o.title).join(', ')} first`,
    );
  }
  if (version.plan.endDate && version.plan.endDate < on) {
    throw new DomainError(
      'conflict',
      `This agreement ended on ${version.plan.endDate}. Run an audit on it instead of billing it.`,
    );
  }
  const amendment = agreement.liveVersionId !== null;

  // Live, its charges and the record of it together: never a live plan without its charges.
  await engine.db.transaction(async (tx) => {
    await tx
      .update(agreements)
      .set({
        liveVersionId: version.row.id,
        status: 'active',
        activatedAt: agreement.activatedAt ?? new Date(),
      })
      .where(eq(agreements.id, agreement.id));
    const live = await loadLive(tx, agreement.id);
    await layOutCharges(tx, live, amendment ? (version.row.effectiveFrom ?? on) : null, on);
    await recordEvent(tx, agreement.id, {
      actor: 'system',
      type: amendment ? 'amendment_live' : 'activated',
      summary: amendment
        ? `Amendment v${version.row.version} is live${version.row.effectiveFrom ? ` from ${version.row.effectiveFrom}` : ''}`
        : `Money plan v${version.row.version} is live on PayPal`,
      data: { versionId: version.row.id },
      occurredOn: on,
    });
  });
  // PayPal calls run as a workflow: if PayPal is down, the plan is still live and the steps retry.
  await enqueuePayPalSetup(agreement.id, version.row.id);
}

/**
 * Creates the PayPal objects a live plan still lacks, one obligation at a time. Each obligation is
 * its own step: run as a workflow, a crash resumes at the obligation it stopped on, and that one's
 * PayPal calls carry request ids, so PayPal answers a repeat with what it already created.
 */
export async function runPayPalSetup(
  engine: Engine,
  agreementId: string,
  step: Step = runDirectly,
): Promise<void> {
  const caps = await step('capabilities', () => engine.gateway.capabilities());
  const keys = await step('to_set_up', async () =>
    (await obligationsToSetUp(engine, await loadLive(engine.db, agreementId), caps)).map(
      (o) => o.key,
    ),
  );
  for (const key of keys) {
    await step(`set_up:${key}`, () =>
      serially(engine, agreementId, async () => {
        const live = await loadLive(engine.db, agreementId);
        const o = (await obligationsToSetUp(engine, live, caps)).find((x) => x.key === key);
        if (o) await setUpObligation(engine, live, o, caps, await today(engine.db));
      }),
    );
  }
}

/**
 * Writes a charge row for everything the plan will raise. On an amendment, charges not yet raised
 * from `from` onwards are replaced by the new plan's; what was already raised stays as it was.
 */
async function layOutCharges(db: Tx, live: Live, from: string | null, on: string): Promise<void> {
  const projected = projectCharges(live.plan, { phases: live.phases });
  if (from) {
    await db.delete(charges).where(
      and(
        eq(charges.agreementId, live.agreement.id),
        eq(charges.status, 'scheduled'),
        // A period belongs to the terms in force when it starts; one-off charges, when due.
        gte(sql`coalesce(${charges.periodStart}, ${charges.dueDate})`, from),
      ),
    );
  }
  const rows = projected
    .filter((c) => !from || (c.periodStart ?? c.dueDate ?? '9999') >= from)
    .map((c) => chargeRow(live, c))
    .map((row) => (from ? row : beforeLive(row, on)));
  if (rows.length > 0) await db.insert(charges).values(rows).onConflictDoNothing();
}

/**
 * A period that ended before the plan went live was billed (or not) outside Clausework. It is
 * kept for the record and the audit, never raised now.
 */
function beforeLive(row: typeof charges.$inferInsert, live: string): typeof charges.$inferInsert {
  if (!row.periodEnd || row.periodEnd >= live) return row;
  return {
    ...row,
    status: 'cancelled',
    basis: `Before this plan went live on ${live}; not billed by Clausework`,
  };
}

function chargeRow(live: Live, c: ProjectedCharge): typeof charges.$inferInsert {
  const o = live.plan.obligations.find((x) => x.key === c.obligationKey) as Obligation;
  return {
    agreementId: live.agreement.id,
    versionId: live.version.row.id,
    chargeKey: c.id,
    obligationKey: c.obligationKey,
    kind: c.kind,
    label: c.label,
    payer: c.payer,
    payee: c.payee,
    amount: c.kind === 'retainage' ? 0n : c.amount,
    currency: live.plan.currency,
    status: 'scheduled',
    issueDate: c.issueDate,
    dueDate: c.dueDate,
    periodIndex: c.periodIndex,
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    clauseIds: c.clauseIds,
    paypalProduct: productFor(o, live.owner.key),
    basis: basisOf(live, o, c),
  };
}

function basisOf(live: Live, o: Obligation, c: ProjectedCharge): string | null {
  const m = (v: bigint) => formatMoney(v, live.plan.currency);
  switch (o.kind) {
    case 'deposit':
    case 'milestone':
      return o.amount.kind === 'percent_of_contract' && live.plan.contractValue !== null
        ? `${o.amount.bps / 100}% of ${m(live.plan.contractValue)}`
        : null;
    case 'recurring':
      return c.amount !== null && c.amount !== o.amount && o.escalator
        ? `${m(o.amount)} raised ${o.escalator.bps / 100}% per ${o.escalator.everyMonths} months`
        : null;
    case 'retainage': {
      const held = o.of.reduce((sum, key) => {
        const target = live.plan.obligations.find((x) => x.key === key);
        return target && (target.kind === 'milestone' || target.kind === 'deposit')
          ? sum + applyBps(resolveAmount(live.plan, target.amount), o.bps)
          : sum;
      }, 0n);
      return `Up to ${m(held)} held from ${o.of.length} milestone payments`;
    }
    default:
      return null;
  }
}

/** Live agreements with an obligation that runs at PayPal and has no PayPal object yet. */
export async function agreementsAwaitingSetup(
  engine: Engine,
): Promise<{ id: string; versionId: string }[]> {
  const out: { id: string; versionId: string }[] = [];
  const caps = await engine.gateway.capabilities();
  for (const id of await liveAgreementIds(engine.db)) {
    const live = await loadLive(engine.db, id);
    if ((await obligationsToSetUp(engine, live, caps)).length > 0) {
      out.push({ id, versionId: live.version.row.id });
    }
  }
  return out;
}

/**
 * What still needs a PayPal object the payer approves or PayPal runs: a deposit order while the
 * deposit is unraised, a subscription for a recurring fee, a usage meter where PayPal offers
 * Usage-Based Billing. An obligation counts as set up only once its final object is bound (the
 * subscription, not just its plan). An amendment keeps what already runs at PayPal (a new rate
 * reaches the plan by repricing) and only creates objects for obligations that are new.
 */
async function obligationsToSetUp(
  engine: Engine,
  live: Live,
  caps: Capabilities,
): Promise<Obligation[]> {
  const bound = new Set(
    (
      await engine.db
        .select({ key: bindings.obligationKey, role: bindings.role })
        .from(bindings)
        .where(eq(bindings.agreementId, live.agreement.id))
    ).map((b) => `${b.key}:${b.role}`),
  );
  const out: Obligation[] = [];
  for (const o of live.plan.obligations) {
    if (flowOf(live, o) !== 'collect') continue;
    if (o.kind === 'deposit' && !bound.has(`${o.key}:deposit_order`)) {
      const charge = await chargeByKey(engine.db, live.agreement.id, o.key);
      if (charge?.status === 'scheduled' && charge.amount !== null) out.push(o);
    } else if (o.kind === 'recurring' && !bound.has(`${o.key}:subscription`)) {
      const first = await firstCharge(engine, live, o.key);
      if (first && first.amount !== null) out.push(o);
    } else if (o.kind === 'usage' && caps.usageBilling && !bound.has(`${o.key}:meter`)) {
      out.push(o);
    }
  }
  return out;
}

async function setUpObligation(
  engine: Engine,
  live: Live,
  o: Obligation,
  caps: Capabilities,
  on: string,
): Promise<void> {
  if (o.kind === 'deposit') await setUpDeposit(engine, live, o, on);
  else if (o.kind === 'recurring') await setUpSubscription(engine, live, o, on);
  else if (o.kind === 'usage' && caps.usageBilling) await setUpMeter(engine, live, o, on);
}

/** The deposit order the payer authorizes; the charge waits for that approval. */
async function setUpDeposit(engine: Engine, live: Live, o: Obligation, on: string): Promise<void> {
  const payer = party(live, o.payer);
  const refs = clauseRefs(live.plan, o.clauseIds).join(', ');

  const charge = await chargeByKey(engine.db, live.agreement.id, o.key);
  if (charge?.status !== 'scheduled' || charge.amount === null) return;
  const order = await engine.gateway.createOrder({
    requestId: `cw-order-${charge.id}`,
    intent: 'AUTHORIZE',
    amount: { amount: charge.amount, currency: charge.currency },
    description: `${o.title}, ${refs}`.slice(0, 127),
    customId: charge.id,
    invoiceId: `CW-${charge.id}`,
    payee: partyRef(live.owner),
    returnUrl: `${engine.publicUrl}/p/return?agreement=${live.agreement.id}`,
    cancelUrl: `${engine.publicUrl}/p/return?agreement=${live.agreement.id}&cancelled=1`,
  });
  // What PayPal created is recorded together or not at all: a retry then either finds it bound,
  // or calls PayPal again with the same request id and gets the same order back.
  await engine.db.transaction(async (tx) => {
    await bind(tx, live, o.key, 'orders', order.id, 'deposit_order', order.status, {
      approveUrl: order.approveUrl,
    });
    await tx
      .update(charges)
      .set({
        status: 'awaiting_approval',
        paypalProduct: 'orders',
        paypalRef: order.id,
        paypalData: { approveUrl: order.approveUrl },
      })
      .where(eq(charges.id, charge.id));
    await recordEvent(tx, live.agreement.id, {
      actor: 'system',
      type: 'paypal_order_created',
      summary: `Created PayPal order ${order.id} for ${o.title}; ${payer.name} authorizes it on PayPal`,
      clauseIds: o.clauseIds,
      occurredOn: on,
    });
  });
}

/** The PayPal plan and subscription for a recurring fee, which the payer approves. */
async function setUpSubscription(
  engine: Engine,
  live: Live,
  o: Extract<Obligation, { kind: 'recurring' }>,
  on: string,
): Promise<void> {
  const payer = party(live, o.payer);
  const refs = clauseRefs(live.plan, o.clauseIds).join(', ');

  const first = await firstCharge(engine, live, o.key);
  if (!first || first.amount === null) return;
  const plan = await engine.gateway.createPlan({
    requestId: requestKey('plan', live.agreement.id, o.key),
    productName: live.plan.title.slice(0, 127),
    productDescription: `${o.title}, ${refs}`.slice(0, 256),
    planName: `${o.title} (${live.plan.title})`.slice(0, 127),
    amount: { amount: first.amount, currency: first.currency },
    interval: o.interval === 'week' ? 'WEEK' : o.interval === 'year' ? 'YEAR' : 'MONTH',
    intervalCount: o.interval === 'quarter' ? 3 : 1,
    cycles: o.cycles,
  });
  const startDay = first.issueDate && first.issueDate > on ? first.issueDate : addDays(on, 1);
  const sub = await engine.gateway.createSubscription({
    requestId: requestKey('subscription', live.agreement.id, o.key),
    planId: plan.planId,
    subscriber: partyRef(payer),
    startTime: startOfDay(startDay, await workspaceTimeZone(engine.db)).toISOString(),
    customId: `${live.agreement.id}:${o.key}`,
    returnUrl: `${engine.publicUrl}/p/return?agreement=${live.agreement.id}`,
    cancelUrl: `${engine.publicUrl}/p/return?agreement=${live.agreement.id}&cancelled=1`,
  });
  const price = first.amount.toString();
  await engine.db.transaction(async (tx) => {
    await bind(tx, live, o.key, 'subscriptions', plan.planId, 'plan', plan.status, {
      productId: plan.productId,
      price,
    });
    await bind(tx, live, o.key, 'subscriptions', sub.id, 'subscription', sub.status, {
      approveUrl: sub.approveUrl,
    });
    await tx
      .update(charges)
      .set({ paypalProduct: 'subscriptions', paypalRef: sub.id })
      .where(and(eq(charges.agreementId, live.agreement.id), eq(charges.obligationKey, o.key)));
    await recordEvent(tx, live.agreement.id, {
      actor: 'system',
      type: 'paypal_subscription_created',
      summary: `Created PayPal plan ${plan.planId} and subscription ${sub.id} for ${o.title}; ${payer.name} approves it on PayPal`,
      clauseIds: o.clauseIds,
      occurredOn: on,
    });
  });
}

/** The Usage-Based Billing meter that counts a usage obligation's units. */
async function setUpMeter(
  engine: Engine,
  live: Live,
  o: Extract<Obligation, { kind: 'usage' }>,
  on: string,
): Promise<void> {
  const payer = party(live, o.payer);
  const metricCode = `${o.metric}_${live.agreement.id.slice(0, 8)}`.toLowerCase();

  const meter = await engine.gateway.createMeter({
    metricCode,
    name: o.title,
    customer: {
      ...partyRef(payer),
      externalId: `cw_${live.agreement.id.slice(0, 8)}_${payer.key}`,
    },
    externalSubscriptionId: `cw_${live.agreement.id.slice(0, 8)}_${o.key}`,
    rate: { amount: o.rate, currency: live.plan.currency },
    includedUnits: o.included,
    interval:
      o.period === 'week'
        ? 'WEEKLY'
        : o.period === 'quarter'
          ? 'QUARTERLY'
          : o.period === 'year'
            ? 'YEARLY'
            : 'MONTHLY',
    alertAtUnits: o.alertAtBps === null ? null : (o.included * o.alertAtBps) / 10_000,
  });
  await engine.db.transaction(async (tx) => {
    await bind(tx, live, o.key, 'usage_billing', meter.externalSubscriptionId, 'meter', 'ACTIVE', {
      metricId: meter.metricId,
      metricCode,
      alertCode: meter.alertCode,
    });
    await recordEvent(tx, live.agreement.id, {
      actor: 'system',
      type: 'paypal_meter_created',
      summary: `Registered a PayPal usage meter for ${o.title}${o.alertAtBps ? `, alerting at ${o.alertAtBps / 100}% of ${count(o.included, o.unit)}` : ''}`,
      clauseIds: o.clauseIds,
      occurredOn: on,
    });
  });
}

async function bind(
  db: Tx,
  live: Live,
  obligationKey: string,
  product: string,
  paypalId: string,
  role: string,
  state: string,
  data: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(bindings)
    .values({ agreementId: live.agreement.id, obligationKey, product, paypalId, role, state, data })
    .onConflictDoUpdate({
      target: [bindings.agreementId, bindings.obligationKey, bindings.role],
      set: { paypalId, state, data },
    });
}

async function firstCharge(
  engine: Engine,
  live: Live,
  obligationKey: string,
): Promise<ChargeRow | null> {
  const rows = await engine.db
    .select()
    .from(charges)
    .where(
      and(
        eq(charges.agreementId, live.agreement.id),
        eq(charges.obligationKey, obligationKey),
        eq(charges.status, 'scheduled'),
      ),
    );
  return rows.sort((a, b) => (a.periodIndex ?? 0) - (b.periodIndex ?? 0))[0] ?? null;
}
