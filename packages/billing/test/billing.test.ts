import { EMPTY_GIVEN, type Plan } from '@clausework/core';
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  checkPlan,
  diffPlans,
  evaluate,
  owedVersusPaid,
  plannedPhaseDates,
  projectCharges,
  runTests,
} from '../src/index.ts';
import { agencyPlan } from './fixture.ts';

const obligation = (plan: Plan, key: string) => plan.obligations.find((o) => o.key === key)!;

describe('evaluate', () => {
  it('passes every test the clauses imply', () => {
    const results = runTests(agencyPlan());
    expect(results.filter((r) => !r.pass)).toEqual([]);
  });

  it('catches a plan that does not say what the clause says', () => {
    const plan = agencyPlan();
    const retainer = obligation(plan, 'retainer');
    if (retainer.kind !== 'recurring') throw new Error();
    retainer.escalator = { bps: 500, everyMonths: 12 };
    const failing = runTests(plan).filter((r) => !r.pass);
    expect(failing.map((r) => r.test.name)).toEqual(['after the first anniversary']);
    expect(failing[0]!.actual).toBe(315_000n);
  });

  it('compounds escalators and rounds each step', () => {
    const plan = agencyPlan();
    expect(evaluate(plan, obligation(plan, 'retainer'), { ...EMPTY_GIVEN, periodIndex: 24 })).toBe(
      318_270n,
    );
  });

  it('prices fractional usage half up and honours a cap', () => {
    const plan = agencyPlan();
    const support = obligation(plan, 'support');
    expect(evaluate(plan, support, { ...EMPTY_GIVEN, quantity: 20.25 })).toBe(1000n);
    if (support.kind !== 'usage') throw new Error();
    support.cap = 5;
    expect(evaluate(plan, support, { ...EMPTY_GIVEN, quantity: 40 })).toBe(20_000n);
  });

  it('charges late fees per month or part after the grace period', () => {
    const plan = agencyPlan();
    const fee = obligation(plan, 'late_fee');
    const at = (daysLate: number) =>
      evaluate(plan, fee, { ...EMPTY_GIVEN, invoiceAmount: 100_000n, daysLate });
    expect(at(0)).toBe(0n);
    expect(at(1)).toBe(1500n);
    expect(at(30)).toBe(1500n);
    expect(at(31)).toBe(3000n);
  });

  it('recoups an advance before paying a revenue share', () => {
    const plan = agencyPlan();
    plan.obligations.push({
      kind: 'revenue_share',
      key: 'royalty',
      title: 'Royalty',
      clauseIds: ['c6'],
      payer: 'agency',
      payee: 'motion',
      confidence: 1,
      ambiguities: [],
      of: [],
      bps: 1000,
      period: 'quarter',
      recoup: 50_000n,
      basis: 'gross receipts',
    });
    const royalty = obligation(plan, 'royalty');
    const quarter = (receipts: bigint, priorReceipts: bigint) =>
      evaluate(plan, royalty, { ...EMPTY_GIVEN, receipts, priorReceipts });
    expect(quarter(300_000n, 0n)).toBe(0n);
    expect(quarter(300_000n, 300_000n)).toBe(10_000n);
    expect(quarter(300_000n, 600_000n)).toBe(30_000n);
  });

  it('reports a missing input instead of guessing', () => {
    const results = runTests({
      ...agencyPlan(),
      tests: [{ obligation: 'support', name: 'no quantity', given: EMPTY_GIVEN, expect: 0n }],
    });
    expect(results[0]!.error).toMatch(/needs given.quantity/);
  });
});

describe('checkPlan', () => {
  it('accepts a consistent plan', () => {
    expect(checkPlan(agencyPlan())).toEqual([]);
  });

  it('finds broken references, self payment, over-allocation and untested obligations', () => {
    const plan = agencyPlan();
    plan.obligations.push({
      kind: 'split',
      key: 'extra_share',
      title: 'Extra',
      clauseIds: ['c9'],
      payer: 'agency',
      payee: 'agency',
      confidence: 1,
      ambiguities: [],
      of: ['phase_2'],
      bps: 9000,
    });
    const codes = checkPlan(plan).map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['unknown_clause', 'self_payment', 'over_allocated', 'no_tests']),
    );
  });
});

describe('projectCharges', () => {
  it('projects deposits, retainers with escalation, milestones and usage periods', () => {
    const plan = agencyPlan();
    const charges = projectCharges(plan, { phases: plannedPhaseDates(plan) });
    const deposit = charges.find((c) => c.id === 'deposit')!;
    expect(deposit).toMatchObject({ dueDate: '2027-01-04', amount: 1_440_000n });
    const retainers = charges.filter((c) => c.obligationKey === 'retainer');
    expect(retainers).toHaveLength(12);
    expect(retainers[11]!.amount).toBe(300_000n);
    const milestone = charges.find((c) => c.id === 'phase_2')!;
    expect(milestone).toMatchObject({ issueDate: '2027-04-02', dueDate: '2027-05-02' });
    expect(
      charges.filter((c) => c.obligationKey === 'support').every((c) => c.amount === null),
    ).toBe(true);
  });

  it('moves milestone charges when a phase moves', () => {
    const plan = agencyPlan();
    const phases = plannedPhaseDates(plan);
    phases.design = { start: '2027-02-08', end: '2027-04-09' };
    const milestone = projectCharges(plan, { phases }).find((c) => c.id === 'phase_2')!;
    expect(milestone.dueDate).toBe('2027-05-09');
  });

  it('runs past a year when the agreement does, escalating on the anniversary', () => {
    const plan = { ...agencyPlan(), endDate: addMonths('2027-01-04', 18) };
    const r = projectCharges(plan, { phases: plannedPhaseDates(plan) }).filter(
      (c) => c.obligationKey === 'retainer',
    );
    expect(r[12]!.amount).toBe(309_000n);
  });
});

describe('diffPlans', () => {
  it('reports changed money and who must approve again', () => {
    const before = agencyPlan();
    const after = agencyPlan();
    const support = obligation(after, 'support');
    if (support.kind !== 'usage') throw new Error();
    support.rate = 4500n;
    support.confidence = 0.5;
    const diff = diffPlans(before, after);
    expect(diff.changed).toEqual([
      {
        key: 'support',
        title: 'Support hours',
        changes: [{ field: 'rate', before: 4000n, after: 4500n }],
      },
    ]);
    expect(diff.affectedParties).toEqual(['agency', 'client']);
  });

  it('is empty when only the model certainty changed', () => {
    const after = agencyPlan();
    after.obligations[0]!.confidence = 0.2;
    expect(diffPlans(agencyPlan(), after).empty).toBe(true);
  });
});

describe('owedVersusPaid', () => {
  it('finds unbilled, duplicated, mis-escalated and post-termination money', () => {
    const plan = { ...agencyPlan(), effectiveDate: '2026-01-04', endDate: '2027-02-03' };
    plan.phases = [];
    plan.obligations = plan.obligations.filter((o) => o.key === 'retainer' || o.key === 'deposit');
    const expected = projectCharges(plan, { phases: {} }).filter((c) => c.amount !== null);
    const txns = [
      {
        id: 't0',
        date: '2026-01-04',
        amount: 1_440_000n,
        payer: 'client',
        payee: 'agency',
        memo: 'Deposit',
      },
      {
        id: 't0b',
        date: '2026-01-05',
        amount: 1_440_000n,
        payer: 'client',
        payee: 'agency',
        memo: 'Deposit',
      },
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `r${i}`,
        date: addMonths('2026-01-04', i),
        amount: 300_000n,
        payer: 'client',
        payee: 'agency',
        memo: 'Retainer',
      })),
      {
        id: 'r12',
        date: '2027-01-04',
        amount: 315_000n,
        payer: 'client',
        payee: 'agency',
        memo: 'Retainer',
      },
      {
        id: 'late',
        date: '2027-03-04',
        amount: 309_000n,
        payer: 'client',
        payee: 'agency',
        memo: 'Retainer',
      },
    ];
    const matches = [
      { transactionId: 't0', chargeId: 'deposit', obligationKey: 'deposit', reason: '' },
      { transactionId: 't0b', chargeId: 'deposit', obligationKey: 'deposit', reason: '' },
      ...Array.from({ length: 12 }, (_, i) => ({
        transactionId: `r${i}`,
        chargeId: i === 3 ? null : `retainer:${i}`,
        obligationKey: 'retainer',
        reason: '',
      })),
      { transactionId: 'r12', chargeId: 'retainer:12', obligationKey: 'retainer', reason: '' },
      { transactionId: 'late', chargeId: null, obligationKey: 'retainer', reason: '' },
    ];
    const report = owedVersusPaid(plan, 'agency', expected, txns, matches);
    const kinds = Object.fromEntries(report.leaks.map((l) => [l.chargeId ?? l.kind, l.kind]));
    expect(kinds).toMatchObject({
      deposit: 'duplicate',
      'retainer:3': 'unbilled',
      'retainer:12': 'escalator_misapplied',
      after_termination: 'after_termination',
    });
    // r3 was paid but the matcher could not tie it to a period: it shows as unexplained.
    expect(report.leaks.some((l) => l.kind === 'unexplained')).toBe(true);
    // Agency is owed the unbilled March retainer; it owes back the duplicate deposit, the
    // over-escalated January and the post-termination charge.
    expect(report.owedToYou).toBe(300_000n);
    expect(report.youOwe).toBe(1_440_000n + 6_000n + 309_000n);
  });
});
