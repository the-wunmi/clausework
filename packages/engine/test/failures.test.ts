import {
  agentDecisions,
  bindings,
  charges,
  events,
  ledgerEntries,
  webhookEvents,
} from '@clausework/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  agreementDetail,
  decide,
  loadAgreement,
  loadLive,
  reconcileWithPayPal,
  updatePhase,
} from '../src/index.ts';
import {
  action,
  agencyWithRetainage,
  compiledAgreement,
  deliver,
  run,
  ScriptedScheduleAgent,
  setToday,
  type TestEngine,
  testEngine,
} from './harness.ts';

const payer = { name: 'Northwind Outfitters', email: 'ap@northwind.test' };
const rowsOf = (engine: TestEngine, id: string) =>
  engine.db.select().from(charges).where(eq(charges.agreementId, id));

async function liveAgency(engine: TestEngine): Promise<string> {
  await setToday(engine, '2027-01-04');
  const id = await compiledAgreement(engine, agencyWithRetainage());
  for (const party of ['client', 'agency', 'motion']) {
    await decide(engine, await loadAgreement(engine.db, id), party, { decision: 'approved' });
  }
  await run(engine);
  return id;
}

async function deliverAndPayDesign(engine: TestEngine, id: string) {
  await setToday(engine, '2027-04-02');
  await deliver(engine, id, 'design', '2027-04-02');
  await run(engine);
  const invoice = (await rowsOf(engine, id)).find((c) => c.chargeKey === 'phase_2')!;
  await engine.simulator.payInvoice(invoice.paypalRef!, payer);
  await run(engine);
}

describe('when PayPal or a party lets us down', () => {
  it('keeps a subcontractor split owed when the payout call fails, and pays it on the next run', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: '', actions: [] })),
    );
    const id = await liveAgency(engine);
    engine.simulator.failNext('payout', 'INSUFFICIENT_FUNDS', 422);
    await deliverAndPayDesign(engine, id);

    let split = (await rowsOf(engine, id)).find((c) => c.obligationKey === 'motion_share');
    expect(split).toMatchObject({ status: 'scheduled', amount: 216_000n });
    // The owner is told why once, and the rest of the agreement's rules still ran.
    const refusals = (
      await engine.db.select().from(events).where(eq(events.agreementId, id))
    ).filter((e) => e.type === 'paypal_refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.summary).toMatch(/still owed/);

    await setToday(engine, '2027-04-03');
    split = (await rowsOf(engine, id)).find((c) => c.obligationKey === 'motion_share');
    expect(split).toMatchObject({ status: 'paid', amount: 216_000n });
    const out = await engine.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.agreementId, id), eq(ledgerEntries.kind, 'paid_out')));
    expect(out).toHaveLength(1);
  });

  it('records a deposit once, though both the capture reply and its webhook report it', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: '', actions: [] })),
    );
    const id = await liveAgency(engine);
    const order = (await agreementDetail(engine, id)).charges.find(
      (c) => c.chargeKey === 'deposit',
    )!;
    await engine.simulator.approveOrder(order.paypalRef!, payer);
    await run(engine);
    await setToday(engine, '2027-01-11');
    await setToday(engine, '2027-01-12');
    const deposits = await engine.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.agreementId, id), eq(ledgerEntries.obligationKey, 'deposit')));
    expect(deposits.map((d) => d.amount)).toEqual([1_440_000n]);
  });

  it('picks up what the payer approved when they return, and the late webhooks change nothing', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: '', actions: [] })),
    );
    const id = await liveAgency(engine);
    const deposit = (await rowsOf(engine, id)).find((c) => c.chargeKey === 'deposit')!;
    const [sub] = await engine.db
      .select()
      .from(bindings)
      .where(and(eq(bindings.agreementId, id), eq(bindings.role, 'subscription')));
    // The payer approves on PayPal; its webhooks are queued but not yet handled.
    await engine.simulator.approveOrder(deposit.paypalRef!, payer);
    await engine.simulator.approveSubscription(sub!.paypalId, payer);

    await reconcileWithPayPal(engine, await loadAgreement(engine.db, id));
    await run(engine);
    expect((await rowsOf(engine, id)).find((c) => c.chargeKey === 'deposit')?.status).toBe(
      'authorized',
    );
    expect((await agreementDetail(engine, id)).setup.map((s) => s.status)).toEqual([
      'done',
      'done',
    ]);
    const log = await engine.db.select().from(events).where(eq(events.agreementId, id));
    expect(log.filter((e) => e.type === 'deposit_authorized')).toHaveLength(1);
    expect(log.filter((e) => e.type === 'subscription_state')).toHaveLength(1);
  });

  it('finds a paid invoice and settled payout when PayPal never sends their webhooks', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: '', actions: [] })),
    );
    const id = await liveAgency(engine);
    const dropWebhooks = async () => {
      await engine.db.delete(webhookEvents);
    };
    await setToday(engine, '2027-04-02');
    await deliver(engine, id, 'design', '2027-04-02');
    await run(engine);
    const invoice = (await rowsOf(engine, id)).find((c) => c.chargeKey === 'phase_2')!;
    await dropWebhooks();
    await engine.simulator.payInvoice(invoice.paypalRef!, payer);
    await dropWebhooks();

    await reconcileWithPayPal(engine, await loadAgreement(engine.db, id));
    await run(engine);
    // The payout for the split went out on receipt; its webhook is lost too.
    await dropWebhooks();
    await reconcileWithPayPal(engine, await loadAgreement(engine.db, id));
    await run(engine);

    const rows = await rowsOf(engine, id);
    expect(rows.find((c) => c.chargeKey === 'phase_2')?.status).toBe('paid');
    expect(rows.find((c) => c.obligationKey === 'motion_share')?.status).toBe('paid');
    const moved = await engine.db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.agreementId, id));
    expect(moved.filter((m) => m.kind === 'paid_out')).toHaveLength(1);
    // Reconciling again changes nothing.
    await reconcileWithPayPal(engine, await loadAgreement(engine.db, id));
    await run(engine);
    expect(
      await engine.db.select().from(ledgerEntries).where(eq(ledgerEntries.agreementId, id)),
    ).toHaveLength(moved.length);
  });

  it('does not let the agent send a second payout while the first can still be claimed', async () => {
    const schedule = new ScriptedScheduleAgent((view) => {
      const unclaimed = view.openCharges.find((c) => c.status === 'unclaimed');
      return {
        summary: 'retry it',
        actions: unclaimed
          ? [action({ action: 'retry_payout', target: unclaimed.id, clauseId: 'c6' })]
          : [],
      };
    });
    const engine = await testEngine(schedule);
    const id = await liveAgency(engine);
    engine.simulator.markReceiverWithoutAccount('pay@kinetic.test');
    await deliverAndPayDesign(engine, id);

    const split = (await rowsOf(engine, id)).find((c) => c.obligationKey === 'motion_share')!;
    expect(split.status).toBe('unclaimed');
    const [decision] = await engine.db
      .select()
      .from(agentDecisions)
      .where(
        eq(
          agentDecisions.triggerKey,
          `payout:${split.id}:${(split.paypalData as { itemId: string }).itemId}:PAYMENT.PAYOUTS-ITEM.UNCLAIMED`,
        ),
      );
    expect(decision?.outcome).toMatchObject({ status: 'rejected' });
    const batches = await engine.simulator.listObjects('payout');
    expect(batches).toHaveLength(1);
  });

  it('refuses agent actions that would move money before the agreement says so', async () => {
    const schedule = new ScriptedScheduleAgent((view) => {
      if (view.trigger.kind !== 'gating_payment_late') return { summary: '', actions: [] };
      const future = view.openCharges.find(
        (c) => c.obligationKey === 'retainer' && (c.issueDate ?? '') > view.today,
      );
      const deposit = view.openCharges.find((c) => c.obligationKey === 'deposit');
      return {
        summary: 'try everything',
        actions: [
          action({ action: 'issue_invoice', target: future?.id ?? null, clauseId: 'c2' }),
          action({
            action: 'issue_invoice',
            target: view.openCharges.find((c) => c.obligationKey === 'phase_2')?.id ?? null,
            clauseId: 'c4',
          }),
          action({ action: 'capture_deposit', target: deposit?.id ?? null, clauseId: 'c1' }),
          action({
            action: 'shift_phase',
            target: 'design',
            clauseId: 'c4',
            start: '2027-01-12',
            end: '2027-03-01',
          }),
        ],
      };
    });
    const engine = await testEngine(schedule);
    const id = await liveAgency(engine);
    const order = (await agreementDetail(engine, id)).charges.find(
      (c) => c.chargeKey === 'deposit',
    )!;
    await setToday(engine, '2027-01-11');
    expect(order.status).toBe('awaiting_approval');
    const decisions = await engine.db
      .select()
      .from(agentDecisions)
      .where(eq(agentDecisions.agreementId, id));
    const gate = decisions.find(
      (d) => (d.trigger as { kind: string }).kind === 'gating_payment_late',
    )!;
    const outcomes = (
      gate.outcome as { actions: { action: string; status: string; reason: string }[] }
    ).actions;
    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected']);
    expect(outcomes[0]?.reason).toMatch(/not due until/);
    expect(outcomes[1]?.reason).toMatch(/not due until|when the phase is delivered/);
    expect(outcomes[3]?.reason).toMatch(/not bring it forward/);
    const issued = (await rowsOf(engine, id)).filter((c) => c.status === 'issued');
    expect(issued).toEqual([]);
  });
});

describe('delivering work', () => {
  it('refuses a phase before the one it follows, and dates an early delivery as it happened', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: '', actions: [] })),
    );
    const id = await liveAgency(engine);
    await expect(
      updatePhase(engine, await loadLive(engine.db, id), 'design', { completedOn: '2027-01-04' }),
    ).rejects.toThrow(/Deliver Discovery first/);

    // Discovery is planned for Jan 11 – Feb 5 and delivered on Jan 4.
    await updatePhase(engine, await loadLive(engine.db, id), 'discovery', {
      completedOn: '2027-01-04',
    });
    const live = await loadLive(engine.db, id);
    expect(live.phases.discovery).toMatchObject({ start: '2027-01-04', end: '2027-01-04' });
  });
});

describe('what never goes live', () => {
  it('waits for the owner to confirm an obligation the compiler was unsure of', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: '', actions: [] })),
    );
    await setToday(engine, '2027-01-04');
    const plan = agencyWithRetainage();
    plan.obligations.find((o) => o.key === 'support')!.confidence = 0.45;
    const id = await compiledAgreement(engine, plan);
    expect((await agreementDetail(engine, id)).agreement.stage).toBe('needs_review');
    await expect(
      decide(engine, await loadAgreement(engine.db, id), 'client', { decision: 'approved' }),
    ).rejects.toThrow(/Support hours still needs the owner to confirm/);

    const { confirmObligation } = await import('../src/index.ts');
    await confirmObligation(engine, await loadAgreement(engine.db, id), 'support');
    expect((await agreementDetail(engine, id)).version?.unconfirmed).toEqual([]);
  });

  it('refuses to bill an agreement that has already ended', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: '', actions: [] })),
    );
    await setToday(engine, '2028-02-01');
    const id = await compiledAgreement(engine, agencyWithRetainage());
    await expect(
      decide(engine, await loadAgreement(engine.db, id), 'client', { decision: 'approved' }),
    ).rejects.toThrow(/ended on 2027-12-31/);
  });

  it('pays an advance the owner owes as a payout on its date, and skips periods before go-live', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: '', actions: [] })),
    );
    await setToday(engine, '2027-03-10');
    const plan = agencyWithRetainage();
    // The owner (agency) pays the subcontractor an advance on signing.
    plan.obligations.push({
      kind: 'deposit',
      key: 'motion_advance',
      title: 'Advance to Kinetic',
      clauseIds: ['c6'],
      payer: 'agency',
      payee: 'motion',
      confidence: 0.9,
      ambiguities: [],
      amount: { kind: 'fixed', amount: 50_000n },
      due: { kind: 'effective', offsetDays: 0 },
    });
    plan.tests.push({
      obligation: 'motion_advance',
      name: '$500',
      given: {
        periodIndex: null,
        quantity: null,
        invoiceAmount: null,
        daysLate: null,
        receipts: null,
        priorReceipts: null,
      },
      expect: 50_000n,
    });
    const id = await compiledAgreement(engine, plan);
    for (const party of ['client', 'agency', 'motion']) {
      await decide(engine, await loadAgreement(engine.db, id), party, { decision: 'approved' });
    }
    await run(engine);
    await setToday(engine, '2027-03-11');
    const rows = await rowsOf(engine, id);
    expect(rows.find((c) => c.chargeKey === 'motion_advance')).toMatchObject({
      status: 'paid',
      paypalProduct: 'payouts',
    });
    const january = rows.find((c) => c.chargeKey === 'retainer:0');
    expect(january).toMatchObject({ status: 'cancelled' });
    expect(january?.basis).toMatch(/Before this plan went live/);
    const detail = await agreementDetail(engine, id);
    expect(detail.version?.products.motion_advance).toBe('payouts');
  });
});
