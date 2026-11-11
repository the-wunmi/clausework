import { agentDecisions, charges, ledgerEntries } from '@clausework/db';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agreementDetail, decide, loadAgreement, loadLive, recordUsage } from '../src/index.ts';
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

async function chargeRows(engine: TestEngine, id: string) {
  return engine.db.select().from(charges).where(eq(charges.agreementId, id));
}

async function approveAll(engine: TestEngine, id: string) {
  for (const party of ['client', 'agency', 'motion']) {
    await decide(engine, await loadAgreement(engine.db, id), party, { decision: 'approved' });
  }
  await run(engine);
}

describe('an agreement from approval to money moving', () => {
  it('waits for every party, then goes live with PayPal objects the payer must approve', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: 'nothing', actions: [] })),
    );
    await setToday(engine, '2027-01-04');
    const id = await compiledAgreement(engine, agencyWithRetainage());

    await decide(engine, await loadAgreement(engine.db, id), 'client', { decision: 'approved' });
    expect((await agreementDetail(engine, id)).agreement.stage).toBe('awaiting_approvals');

    await approveAll(engine, id);
    const detail = await agreementDetail(engine, id);
    expect(detail.agreement.stage).toBe('awaiting_payer_setup');
    expect(detail.setup.map((s) => [s.obligationKey, s.status])).toEqual(
      expect.arrayContaining([
        ['deposit', 'waiting'],
        ['retainer', 'waiting'],
      ]),
    );
    const deposit = detail.charges.find((c) => c.chargeKey === 'deposit');
    expect(deposit).toMatchObject({
      status: 'awaiting_approval',
      amount: '1440000',
      paypalProduct: 'orders',
    });
    expect(deposit?.payUrl).toMatch(/^http:\/\/web\.test\/sim\/checkout\/order\//);
  });

  it('refuses an approval bound to an older version after an edit', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: '', actions: [] })),
    );
    await setToday(engine, '2027-01-04');
    const plan = agencyWithRetainage();
    const id = await compiledAgreement(engine, plan);
    await decide(engine, await loadAgreement(engine.db, id), 'client', { decision: 'approved' });
    const { editObligation } = await import('../src/index.ts');
    const support = plan.obligations.find((o) => o.key === 'support');
    await editObligation(engine, await loadAgreement(engine.db, id), 'support', {
      obligation: { ...support, rate: '4000' },
      note: 'same rate, new version',
    });
    const detail = await agreementDetail(engine, id);
    const client = detail.parties.find((p) => p.key === 'client');
    expect(client?.approval?.current).toBe(false);
    expect(detail.agreement.approvals.approved).toBe(0);
  });

  it('authorizes the deposit, captures it when work starts, and bills the retainer cycles', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: '', actions: [] })),
    );
    await setToday(engine, '2027-01-04');
    const id = await compiledAgreement(engine, agencyWithRetainage());
    await approveAll(engine, id);
    const sim = engine.simulator;
    const detail = await agreementDetail(engine, id);
    const order = detail.charges.find((c) => c.chargeKey === 'deposit')!.paypalRef!;
    const sub = detail.charges.find((c) => c.obligationKey === 'retainer')!.paypalRef!;

    await sim.approveOrder(order, payer);
    await run(engine);
    let deposit = (await chargeRows(engine, id)).find((c) => c.chargeKey === 'deposit')!;
    expect(deposit.status).toBe('authorized');

    // Discovery starts on 2027-01-11: the deposit is captured that day, not before.
    await setToday(engine, '2027-01-10');
    deposit = (await chargeRows(engine, id)).find((c) => c.chargeKey === 'deposit')!;
    expect(deposit.status).toBe('authorized');
    await setToday(engine, '2027-01-11');
    await run(engine);
    deposit = (await chargeRows(engine, id)).find((c) => c.chargeKey === 'deposit')!;
    expect(deposit.status).toBe('paid');

    await sim.approveSubscription(sub, payer);
    await run(engine);
    await setToday(engine, '2027-03-05');
    await run(engine);
    const retainer = (await chargeRows(engine, id)).filter((c) => c.obligationKey === 'retainer');
    expect(
      retainer
        .filter((c) => c.status === 'paid')
        .map((c) => c.periodIndex)
        .sort(),
    ).toEqual([0, 1, 2]);
    const collected = await engine.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.agreementId, id), eq(ledgerEntries.kind, 'collected')));
    expect(collected.reduce((s, e) => s + e.amount, 0n)).toBe(1_440_000n + 3n * 300_000n);
  });

  it('invoices a delivered milestone less retainage, then pays the subcontractor their split', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: '', actions: [] })),
    );
    await setToday(engine, '2027-01-04');
    const id = await compiledAgreement(engine, agencyWithRetainage());
    await approveAll(engine, id);

    await setToday(engine, '2027-04-02');
    await deliver(engine, id, 'design', '2027-04-02');
    await run(engine);
    let rows = await chargeRows(engine, id);
    const milestone = rows.find((c) => c.chargeKey === 'phase_2')!;
    expect(milestone).toMatchObject({
      status: 'issued',
      amount: 1_200_000n,
      paypalProduct: 'invoicing',
      dueDate: '2027-05-02',
    });
    // The client is asked for the fee less 10% retainage.
    expect(milestone.paypalData).toMatchObject({ invoiced: '1080000' });
    expect(rows.find((c) => c.chargeKey === 'retainage')).toMatchObject({
      status: 'held',
      amount: 120_000n,
    });

    await engine.simulator.payInvoice(milestone.paypalRef!, payer);
    await run(engine);
    rows = await chargeRows(engine, id);
    expect(rows.find((c) => c.chargeKey === 'phase_2')?.status).toBe('paid');
    const split = rows.find((c) => c.obligationKey === 'motion_share')!;
    expect(split).toMatchObject({
      status: 'paid',
      amount: 216_000n,
      paypalProduct: 'payouts',
      payee: 'motion',
    });

    // Retainage is released 30 days after the design phase ends.
    await setToday(engine, '2027-05-02');
    await run(engine);
    rows = await chargeRows(engine, id);
    expect(rows.find((c) => c.chargeKey === 'retainage')).toMatchObject({
      status: 'issued',
      amount: 120_000n,
    });
  });

  it('bills usage above the included hours when the month closes', async () => {
    const engine = await testEngine(
      new ScriptedScheduleAgent(() => ({ summary: '', actions: [] })),
    );
    await setToday(engine, '2027-01-04');
    const id = await compiledAgreement(engine, agencyWithRetainage());
    await approveAll(engine, id);
    const live = await loadLive(engine.db, id);
    await recordUsage(engine, live, {
      obligationKey: 'support',
      quantity: 14,
      occurredOn: '2027-01-12',
      idempotencyKey: 'a',
    });
    await recordUsage(engine, live, {
      obligationKey: 'support',
      quantity: 12,
      occurredOn: '2027-01-30',
      idempotencyKey: 'b',
    });
    await recordUsage(engine, live, {
      obligationKey: 'support',
      quantity: 12,
      occurredOn: '2027-01-30',
      idempotencyKey: 'b',
    });
    await setToday(engine, '2027-02-04');
    await run(engine);
    const rows = await chargeRows(engine, id);
    expect(rows.find((c) => c.chargeKey === 'support:0')).toMatchObject({
      status: 'issued',
      amount: 24_000n,
      basis: '6 hours × $40.00 above 20 included (26 used)',
    });
  });

  it('asks the agent about an overdue invoice and only lets it charge what the clause allows', async () => {
    const schedule = new ScriptedScheduleAgent((view) => {
      const overdue = view.openCharges.find((c) => c.status === 'overdue');
      return {
        summary: 'Phase 2 invoice is late: reminder and late fee under §3.5',
        actions: overdue
          ? [
              action({
                action: 'send_reminder',
                target: overdue.id,
                clauseId: 'c5',
                message: 'The Phase 2 invoice is overdue.',
              }),
              action({ action: 'apply_late_fee', target: overdue.id, clauseId: 'c5' }),
              action({ action: 'apply_late_fee', target: overdue.id, clauseId: 'c1' }),
              action({
                action: 'shift_phase',
                target: 'discovery',
                clauseId: 'c99',
                start: '2027-01-01',
                end: '2027-01-02',
              }),
            ]
          : [],
      };
    });
    const engine = await testEngine(schedule);
    await setToday(engine, '2027-01-04');
    const id = await compiledAgreement(engine, agencyWithRetainage());
    await approveAll(engine, id);
    await setToday(engine, '2027-04-02');
    await deliver(engine, id, 'design', '2027-04-02');
    await setToday(engine, '2027-05-03');
    await run(engine);

    const rows = await chargeRows(engine, id);
    const fee = rows.find((c) => c.obligationKey === 'late_fee')!;
    expect(fee).toMatchObject({ status: 'issued', amount: 16_200n });
    const decisions = await engine.db
      .select()
      .from(agentDecisions)
      .where(eq(agentDecisions.agreementId, id));
    const decision = decisions.find(
      (d) => (d.trigger as { kind: string }).kind === 'invoice_overdue',
    );
    const outcome = decision!.outcome as {
      actions: { action: string; status: string; reason: string }[];
    };
    expect(outcome.actions.map((a) => [a.action, a.status])).toEqual([
      ['send_reminder', 'executed'],
      ['apply_late_fee', 'executed'],
      ['apply_late_fee', 'rejected'],
      ['shift_phase', 'rejected'],
    ]);
    // The second month of lateness is a new situation, decided again.
    await setToday(engine, '2027-06-02');
    await run(engine);
    const milestoneId = rows.find((c) => c.chargeKey === 'phase_2')!.id;
    const asked = schedule.seen.filter(
      (v) => v.trigger.kind === 'invoice_overdue' && v.trigger.details.chargeId === milestoneId,
    );
    expect(asked.map((v) => v.trigger.details.daysLate)).toEqual([1, 31]);
  });

  it('holds a phase whose gating payment is late and moves what depends on it', async () => {
    const schedule = new ScriptedScheduleAgent((view) =>
      view.trigger.kind === 'gating_payment_late'
        ? {
            summary: 'Discovery cannot start until the deposit is paid (§3.1); moved it a week.',
            actions: [
              action({
                action: 'shift_phase',
                target: 'discovery',
                clauseId: 'c1',
                start: '2027-01-18',
                end: '2027-02-12',
              }),
            ],
          }
        : { summary: '', actions: [] },
    );
    const engine = await testEngine(schedule);
    await setToday(engine, '2027-01-04');
    const id = await compiledAgreement(engine, agencyWithRetainage());
    await approveAll(engine, id);
    await setToday(engine, '2027-01-11');
    await run(engine);
    const detail = await agreementDetail(engine, id);
    const discovery = detail.phases.find((p) => p.key === 'discovery')!;
    expect(discovery.current).toMatchObject({ start: '2027-01-18', end: '2027-02-12' });
    expect(discovery.blockedBy).toMatchObject({ label: 'Deposit' });
  });
});

describe('amendments from a thread', () => {
  it('changes a rate from a date, re-approved only by the parties it affects', async () => {
    const schedule = new ScriptedScheduleAgent(() => ({ summary: '', actions: [] }));
    const engine = await testEngine(schedule);
    const drafter = {
      draft: async () => ({
        agreed: true,
        summary: 'Support above 20 hours moves to $45 an hour from 1 February 2027',
        quote: 'ok, the $45 rate from February',
        from: 'Dana',
        date: '2027-01-11',
        effectiveFrom: '2027-02-04',
        changes: [
          {
            op: 'update' as const,
            key: 'support',
            note: 'rate $40 → $45',
            obligation: {
              kind: 'usage' as const,
              key: 'support',
              title: 'Support hours',
              clauseIds: ['c3', 'amendment'],
              payer: 'client',
              payee: 'agency',
              confidence: 0.95,
              ambiguities: [],
              terms: [
                { name: 'metric' as const, value: 'Support Hours' },
                { name: 'unit' as const, value: 'hour' },
                { name: 'rate' as const, value: '45.00' },
                { name: 'included' as const, value: '20' },
                { name: 'interval' as const, value: 'month' },
              ],
            },
          },
        ],
        tests: [
          {
            obligation: 'support',
            name: '26 hours at $45',
            given: [{ name: 'quantity' as const, value: '26' }],
            expect: '270.00',
          },
        ],
      }),
    };
    Object.assign(engine.agents as object, { drafter });
    await setToday(engine, '2027-01-04');
    const id = await compiledAgreement(engine, agencyWithRetainage());
    await approveAll(engine, id);
    const live = await loadLive(engine.db, id);
    await recordUsage(engine, live, {
      obligationKey: 'support',
      quantity: 26,
      occurredOn: '2027-01-20',
      idempotencyKey: 'jan',
    });
    await recordUsage(engine, live, {
      obligationKey: 'support',
      quantity: 26,
      occurredOn: '2027-02-20',
      idempotencyKey: 'feb',
    });

    const { draftAmendment } = await import('../src/index.ts');
    await setToday(engine, '2027-01-12');
    await draftAmendment(engine, await loadAgreement(engine.db, id), {
      text: 'Dana wrote on 11 Jan: ok, the $45 rate from February. Thanks!',
    });
    let detail = await agreementDetail(engine, id);
    expect(detail.version?.diff?.changed.map((c) => c.key)).toEqual(['support']);
    // Only the named term changed: the 80% usage alert the thread never mentioned is kept.
    expect(detail.version?.diff?.changed[0]?.changes.map((c) => c.field)).toEqual(['rate']);
    expect(detail.version?.diff?.affectedParties).toEqual(['agency', 'client']);
    expect(detail.parties.find((p) => p.key === 'motion')?.approval?.comment).toMatch(
      /Carried over/,
    );
    expect(detail.agreement.stage).toBe('awaiting_approvals');

    await decide(engine, await loadAgreement(engine.db, id), 'client', { decision: 'approved' });
    await decide(engine, await loadAgreement(engine.db, id), 'agency', { decision: 'approved' });
    detail = await agreementDetail(engine, id);
    expect(detail.liveVersionId).toBe(detail.version?.id);

    await setToday(engine, '2027-03-05');
    const rows = await chargeRows(engine, id);
    expect(rows.find((c) => c.chargeKey === 'support:0')?.amount).toBe(24_000n);
    expect(rows.find((c) => c.chargeKey === 'support:1')?.amount).toBe(27_000n);
  });
});
