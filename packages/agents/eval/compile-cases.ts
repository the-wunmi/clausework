import { readFileSync } from 'node:fs';
import { checkPlan, describeFailure, runTests } from '@clausework/billing';
import type { Obligation, Plan } from '@clausework/core';
import { ContractCompiler, type ModelClient } from '../src/index.ts';
import { type Check, check, type EvalCase } from './types.ts';

type Expect = (plan: Plan) => [string, boolean, boolean?][];

const find = (
  plan: Plan,
  kind: Obligation['kind'],
  pred: (o: Obligation) => boolean = () => true,
) => plan.obligations.filter((o) => o.kind === kind).find(pred);

const CASES: Record<string, { file: string; expect: Expect }> = {
  agency: {
    file: 'agency-msa.txt',
    expect: (p) => {
      const deposit = find(p, 'deposit');
      const retainer = find(p, 'recurring');
      const usage = find(p, 'usage');
      const milestones = p.obligations.filter((o) => o.kind === 'milestone');
      const split = find(p, 'split');
      const share = find(p, 'revenue_share');
      const late = find(p, 'late_fee');
      const retainage = find(p, 'retainage');
      return [
        [
          'deposit is 30% of $48,000',
          deposit?.kind === 'deposit' &&
            (deposit.amount.kind === 'percent_of_contract'
              ? deposit.amount.bps === 3000 && p.contractValue === 4_800_000n
              : deposit.amount.amount === 1_440_000n),
          true,
        ],
        [
          'retainer $3,000 a month, +3% yearly',
          retainer?.kind === 'recurring' &&
            retainer.amount === 300_000n &&
            retainer.escalator?.bps === 300 &&
            retainer.escalator.everyMonths === 12,
          true,
        ],
        [
          'support $40/h above 20 h a month',
          usage?.kind === 'usage' && usage.rate === 4_000n && usage.included === 20,
          true,
        ],
        [
          'milestones $19,200 net 30 and $14,400 net 15',
          milestones.some(
            (m) =>
              m.kind === 'milestone' &&
              m.amount.kind === 'fixed' &&
              m.amount.amount === 1_920_000n &&
              m.netDays === 30,
          ) &&
            milestones.some(
              (m) =>
                m.kind === 'milestone' &&
                m.amount.kind === 'fixed' &&
                m.amount.amount === 1_440_000n &&
                m.netDays === 15,
            ),
          true,
        ],
        [
          'subcontractor gets 20% of the Design System milestone, paid by the agency',
          split?.kind === 'split' &&
            split.bps === 2000 &&
            split.payer !== split.payee &&
            split.payer === (deposit?.payee ?? ''),
          true,
        ],
        [
          'referrer gets 8% of retainer receipts',
          share?.kind === 'revenue_share' && share.bps === 800,
          true,
        ],
        [
          'late fee 1.5% per month or part',
          late?.kind === 'late_fee' && late.rateBps === 150 && late.per === 'month_or_part',
          true,
        ],
        [
          '10% retainage on both milestones',
          retainage?.kind === 'retainage' && retainage.bps === 1000 && retainage.of.length === 2,
        ],
        [
          'client pays, agency is paid',
          deposit?.payer !== deposit?.payee && usage?.payer === deposit?.payer,
        ],
      ];
    },
  },
  saas: {
    file: 'saas-order-form.txt',
    expect: (p) => {
      const fee = find(p, 'recurring');
      const prepaid = find(p, 'prepaid');
      const credit = find(p, 'service_credit');
      return [
        [
          'platform fee $2,500 a month for 12 months',
          fee?.kind === 'recurring' && fee.amount === 250_000n && fee.cycles === 12,
          true,
        ],
        [
          '100 hours prepaid for $15,000 then $175/h',
          prepaid?.kind === 'prepaid' &&
            prepaid.units === 100 &&
            prepaid.price === 1_500_000n &&
            prepaid.overageRate === 17_500n,
          true,
        ],
        [
          'SLA credit of 10% owed by the provider',
          credit?.kind === 'service_credit' && credit.bps === 1000 && credit.payee === fee?.payer,
          true,
        ],
        ['no escalator invented', fee?.kind === 'recurring' && fee.escalator === null, true],
      ];
    },
  },
  cowriting: {
    file: 'cowriting-agreement.txt',
    expect: (p) => {
      const shares = p.obligations.filter((o) => o.kind === 'revenue_share');
      const recouping = shares.find((o) => o.kind === 'revenue_share' && o.recoup !== null);
      return [
        [
          'three royalty shares of 25%, 15% and 10%',
          [2500, 1500, 1000].every((b) =>
            shares.some((s) => s.kind === 'revenue_share' && s.bps === b),
          ),
          true,
        ],
        [
          'the $10,000 advance is recouped from Writer A only',
          recouping?.kind === 'revenue_share' &&
            recouping.bps === 2500 &&
            recouping.recoup === 1_000_000n,
          true,
        ],
        [
          'royalties paid quarterly',
          shares.filter((s) => s.kind === 'revenue_share' && s.period === 'quarter').length >= 3,
        ],
      ];
    },
  },
};

async function compile(model: ModelClient, c: (typeof CASES)[string]): Promise<Check[]> {
  const text = readFileSync(
    new URL(`../../../samples/contracts/${c.file}`, import.meta.url),
    'utf8',
  );
  const compiler = new ContractCompiler(model);
  const source = { kind: 'text' as const, data: text };
  const { reading } = await compiler.read(source);
  // The same loop the engine runs: unreadable output and failing tests both get a repair.
  let draft = await compiler.compile(source, reading);
  for (let i = 0; i < 2; i++) {
    const plan = draft.plan;
    const problems = plan
      ? [
          ...runTests(plan)
            .filter((r) => !r.pass)
            .map((r) => describeFailure(plan, r)),
          ...checkPlan(plan).map((x) => x.message),
        ]
      : draft.problems;
    if (problems.length === 0) break;
    draft = await compiler.repair(source, reading, draft, problems);
  }
  const plan = draft.plan;
  if (!plan) return [check('produces a valid plan', false, true, draft.problems.join('; '))];
  const failing = runTests(plan).filter((r) => !r.pass);
  return [
    check(
      'every generated test passes',
      failing.length === 0,
      false,
      failing.map((r) => describeFailure(plan, r)).join('; ') || undefined,
    ),
    check('no structural issues', checkPlan(plan).length === 0),
    ...c.expect(plan).map(([name, ok, harmful]) => check(name, ok, harmful ?? false)),
  ];
}

export const compileCases: EvalCase[] = Object.entries(CASES).map(([name, c]) => ({
  agent: 'compiler',
  name,
  run: (model) => compile(model, c),
}));
