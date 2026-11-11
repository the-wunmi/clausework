import type { Obligation } from '@clausework/core';
import { describe, expect, it } from 'vitest';
import {
  type FlatObligation,
  type FlatTest,
  mergeTerms,
  readObligation,
  readTest,
  type TermName,
  toFlat,
} from '../src/index.ts';

const base = {
  title: 'Fee',
  clauseIds: ['c1'],
  payer: 'client',
  payee: 'agency',
  confidence: 0.95,
  ambiguities: [],
};

const flat = (
  kind: FlatObligation['kind'],
  terms: Record<string, string>,
  key = 'fee',
): FlatObligation => ({
  ...base,
  kind,
  key,
  terms: Object.entries(terms).map(([name, value]) => ({ name: name as TermName, value })),
});

const read = (o: FlatObligation) => readObligation(o, 'USD');

describe('amounts', () => {
  it('reads decimal major units into bigint minor units', () => {
    const { obligation, problems } = read(
      flat('recurring', { amount: '3000.00', interval: 'month', start: 'effective+0' }),
    );
    expect(problems).toEqual([]);
    expect(obligation).toMatchObject({ amount: 300_000n });
  });

  it('accepts whole amounts, thousands separators and a currency symbol', () => {
    for (const [value, minor] of [
      ['3000', 300_000n],
      ['3,000.5', 300_050n],
      ['$ 48,000.00', 4_800_000n],
      ['0.40', 40n],
    ] as const) {
      const { obligation } = read(
        flat('recurring', { amount: value, interval: 'month', start: 'effective+0' }),
      );
      expect(obligation, value).toMatchObject({ amount: minor });
    }
  });

  it('rejects an amount finer than the currency allows instead of rounding it', () => {
    const { obligation, problems } = read(
      flat('usage', {
        metric: 'api_calls',
        unit: 'call',
        rate: '0.0004',
        included: '0',
        interval: 'month',
      }),
    );
    expect(obligation).toBeNull();
    expect(problems.join()).toContain('"0.0004" is not a USD amount');
  });

  it('uses the currency of the plan, so a yen amount has no decimals', () => {
    const deposit = (amount: string) => flat('deposit', { amount, due: 'effective+0' });
    expect(readObligation(deposit('1000.50'), 'JPY').problems.join()).toContain('not a JPY amount');
    expect(readObligation(deposit('1000'), 'JPY').obligation).toMatchObject({
      amount: { kind: 'fixed', amount: 1000n },
    });
  });

  it('turns words where an amount belongs into a problem, not a zero', () => {
    const { obligation, problems } = read(flat('deposit', { amount: 'TBD', due: 'effective+0' }));
    expect(obligation).toBeNull();
    expect(problems.join()).toContain('"TBD" is not a USD amount');
  });
});

describe('basis points', () => {
  it('reads whole basis points and a percent-of-contract amount', () => {
    const { obligation } = read(
      flat('deposit', { percent_of_contract_bps: '3000', due: 'effective+0' }),
    );
    expect(obligation).toMatchObject({ amount: { kind: 'percent_of_contract', bps: 3000 } });
  });

  it('refuses a percentage written with a sign rather than reading 3% as 3 bps', () => {
    const { obligation, problems } = read(flat('split', { of: 'design', bps: '3%' }));
    expect(obligation).toBeNull();
    expect(problems).toContain(
      'obligation fee (split): term bps "3%" is not basis points or a count without "%" (3% = "300")',
    );
  });

  it('refuses fractional basis points', () => {
    const { problems } = read(
      flat('late_fee', { bps: '1.5', per: 'month_or_part', grace_days: '0' }),
    );
    expect(problems).toContain('obligation fee (late_fee): term bps "1.5" is not a whole number');
  });

  it('reads an escalator only when it is above zero', () => {
    const terms = { amount: '3000.00', interval: 'month', start: 'effective+0' };
    expect(read(flat('recurring', { ...terms, escalator_bps: '0' })).obligation).toMatchObject({
      escalator: null,
    });
    expect(
      read(flat('recurring', { ...terms, escalator_bps: '300', escalator_every_months: '12' }))
        .obligation,
    ).toMatchObject({ escalator: { bps: 300, everyMonths: 12 } });
  });

  it('names the period an escalator needs when it is missing', () => {
    const { problems } = read(
      flat('recurring', {
        amount: '3000.00',
        interval: 'month',
        start: 'effective+0',
        escalator_bps: '300',
      }),
    );
    expect(problems).toContain('obligation fee (recurring) needs term escalator_every_months');
  });
});

describe('terms', () => {
  it('names every required term a kind did not get', () => {
    const { obligation, problems } = read(flat('usage', { metric: 'hours' }));
    expect(obligation).toBeNull();
    expect(problems).toEqual(
      expect.arrayContaining([
        'obligation fee (usage) needs term unit',
        'obligation fee (usage) needs term rate',
        'obligation fee (usage) needs term interval',
      ]),
    );
  });

  it('treats a blank value as missing', () => {
    const { problems } = read(flat('deposit', { amount: '  ', due: 'effective+0' }));
    expect(problems).toContain('obligation fee (deposit) needs term amount');
  });

  it('reports a malformed number, date or interval', () => {
    const { obligation, problems } = read(
      flat('recurring', {
        amount: '100.00',
        interval: 'fortnight',
        start: 'next week',
        cycles: 'twelve',
      }),
    );
    expect(obligation).toBeNull();
    expect(problems).toEqual(
      expect.arrayContaining([
        'obligation fee (recurring): term start "next week" is not a date such as "effective+0" or "phase_end:design+0"',
        'obligation fee (recurring): term cycles "twelve" is not a number',
      ]),
    );
    expect(problems.some((p) => p.startsWith('obligation fee, interval'))).toBe(true);
  });

  it('reads every form of date reference', () => {
    const due = (value: string) =>
      read(flat('milestone', { amount: '100.00', due: value, net_days: '30' })).obligation;
    expect(due('2027-01-04')).toMatchObject({ due: { kind: 'date', date: '2027-01-04' } });
    expect(due('effective')).toMatchObject({ due: { kind: 'effective', offsetDays: 0 } });
    expect(due('effective + 30')).toMatchObject({ due: { kind: 'effective', offsetDays: 30 } });
    expect(due('phase_start:build-2')).toMatchObject({
      due: { kind: 'phase_start', phase: 'build', offsetDays: -2 },
    });
    expect(due('phase_end:design+0')).toMatchObject({
      due: { kind: 'phase_end', phase: 'design', offsetDays: 0 },
    });
  });

  it('fills the defaults a kind allows to be left out', () => {
    expect(read(flat('late_fee', { bps: '150' })).obligation).toMatchObject({
      appliesTo: ['*'],
      per: 'month_or_part',
      graceDays: 0,
    });
    expect(
      read(flat('milestone', { amount: '100.00', due: 'phase_end:design+0' })).obligation,
    ).toMatchObject({ netDays: 0, phase: null });
  });

  it('splits comma-separated keys and keeps only the first for a service credit', () => {
    expect(
      read(flat('retainage', { of: 'design, build,', bps: '1000', release: 'effective+90' }))
        .obligation,
    ).toMatchObject({
      of: ['design', 'build'],
    });
    expect(
      read(flat('service_credit', { of: 'platform, support', bps: '1000', condition: 'SLA miss' }))
        .obligation,
    ).toMatchObject({ of: 'platform' });
  });

  it('turns a metric name into an identifier, however the model wrote it', () => {
    const metric = (value: string) =>
      read(
        flat('usage', {
          metric: value,
          unit: 'hour',
          rate: '40.00',
          included: '20',
          interval: 'month',
        }),
      );
    expect(metric('Support Hours').obligation).toMatchObject({ metric: 'support_hours' });
    expect(metric('  API calls (1,000) ').obligation).toMatchObject({ metric: 'api_calls_1_000' });
    expect(metric('1000 API calls').obligation).toMatchObject({ metric: 'm_1000_api_calls' });
    const { obligation, problems } = metric('!!!');
    expect(obligation).toBeNull();
    expect(problems.join()).toContain('obligation fee, metric');
  });

  it('rejects a key that is not lower_snake_case', () => {
    const { problems } = read(flat('deposit', { amount: '1.00', due: 'effective+0' }, 'Deposit'));
    expect(problems.join()).toContain('lower_snake_case key');
  });
});

describe('tests', () => {
  const test = (given: Record<string, string>, expect = '240.00'): FlatTest => ({
    obligation: 'support',
    name: 'above the included hours',
    given: Object.entries(given).map(([name, value]) => ({
      name: name as FlatTest['given'][number]['name'],
      value,
    })),
    expect,
  });

  it('reads the inputs a kind uses and leaves the rest null', () => {
    const { test: t, problems } = readTest(
      test({ quantity: '26', invoice_amount: '1,200.00', days_late: '31' }),
      'USD',
    );
    expect(problems).toEqual([]);
    expect(t).toEqual({
      obligation: 'support',
      name: 'above the included hours',
      given: {
        periodIndex: null,
        quantity: 26,
        invoiceAmount: 120_000n,
        daysLate: 31,
        receipts: null,
        priorReceipts: null,
      },
      expect: 24_000n,
    });
  });

  it('reads receipts and a period index', () => {
    const { test: t } = readTest(
      test({ receipts: '5000', prior_receipts: '12000.00', period_index: '12' }),
      'USD',
    );
    expect(t?.given).toMatchObject({
      receipts: 500_000n,
      priorReceipts: 1_200_000n,
      periodIndex: 12,
    });
  });

  it('turns an unreadable input or expectation into a problem', () => {
    expect(readTest(test({ quantity: 'lots' }), 'USD').problems).toEqual([
      'test "above the included hours": quantity "lots" is not a number',
    ]);
    const { test: t, problems } = readTest(test({ quantity: '26' }, '240.005'), 'USD');
    expect(t).toBeNull();
    expect(problems.join()).toContain('expect');
  });

  it('refuses a fractional period index or negative days late', () => {
    expect(readTest(test({ period_index: '1.5' }), 'USD').test).toBeNull();
    expect(readTest(test({ days_late: '-3' }), 'USD').test).toBeNull();
  });
});

/** One obligation of every kind, as the engine stores them. */
const EVERY_KIND: Obligation[] = [
  {
    ...base,
    kind: 'deposit',
    key: 'deposit',
    amount: { kind: 'percent_of_contract', bps: 3000 },
    due: { kind: 'effective', offsetDays: 0 },
  },
  {
    ...base,
    kind: 'recurring',
    key: 'retainer',
    amount: 300_000n,
    interval: 'month',
    start: { kind: 'date', date: '2027-01-01' },
    cycles: null,
    escalator: { bps: 300, everyMonths: 12 },
  },
  {
    ...base,
    kind: 'recurring',
    key: 'platform',
    amount: 250_000n,
    interval: 'month',
    start: { kind: 'effective', offsetDays: 0 },
    cycles: 12,
    escalator: null,
  },
  {
    ...base,
    kind: 'usage',
    key: 'support',
    metric: 'support_hours',
    unit: 'hour',
    rate: 4_000n,
    included: 20,
    period: 'month',
    cap: 60,
    alertAtBps: 8000,
  },
  {
    ...base,
    kind: 'usage',
    key: 'api',
    metric: 'api_calls',
    unit: '1,000 calls',
    rate: 40n,
    included: 0,
    period: 'month',
    cap: null,
    alertAtBps: null,
  },
  {
    ...base,
    kind: 'prepaid',
    key: 'hours',
    metric: 'implementation_hours',
    unit: 'hour',
    units: 100,
    price: 1_500_000n,
    overageRate: 17_500n,
  },
  {
    ...base,
    kind: 'milestone',
    key: 'design',
    amount: { kind: 'fixed', amount: 1_920_000n },
    phase: 'design',
    due: { kind: 'phase_end', phase: 'design', offsetDays: 0 },
    netDays: 30,
  },
  {
    ...base,
    kind: 'milestone',
    key: 'launch',
    amount: { kind: 'fixed', amount: 1_440_000n },
    phase: null,
    due: { kind: 'phase_start', phase: 'launch', offsetDays: -5 },
    netDays: 15,
  },
  {
    ...base,
    kind: 'late_fee',
    key: 'late',
    appliesTo: ['*'],
    rateBps: 150,
    per: 'month_or_part',
    graceDays: 0,
  },
  {
    ...base,
    kind: 'late_fee',
    key: 'late_daily',
    appliesTo: ['design', 'launch'],
    rateBps: 5,
    per: 'day',
    graceDays: 10,
  },
  {
    ...base,
    kind: 'revenue_share',
    key: 'referral',
    of: ['retainer'],
    bps: 800,
    period: 'quarter',
    recoup: null,
    basis: 'retainer receipts',
  },
  {
    ...base,
    kind: 'revenue_share',
    key: 'writer_a',
    of: [],
    bps: 2500,
    period: 'quarter',
    recoup: 1_000_000n,
    basis: 'net royalty income',
  },
  { ...base, kind: 'split', key: 'sub', payer: 'agency', payee: 'sub', of: ['design'], bps: 2000 },
  {
    ...base,
    kind: 'retainage',
    key: 'holdback',
    of: ['design', 'launch'],
    bps: 1000,
    release: { kind: 'phase_end', phase: 'launch', offsetDays: 30 },
  },
  {
    ...base,
    kind: 'service_credit',
    key: 'sla',
    payer: 'agency',
    payee: 'client',
    of: 'platform',
    bps: 1000,
    condition: 'Monthly uptime below 99.9%',
  },
];

describe('round trip through the term language', () => {
  it.each(EVERY_KIND.map((o) => [`${o.kind} ${o.key}`, o] as const))(
    '%s reads back exactly as it was written',
    (_, o) => {
      const { obligation, problems } = readObligation(toFlat(o, 'USD'), 'USD');
      expect(problems).toEqual([]);
      expect(obligation).toEqual(o);
    },
  );

  it('shows amounts to the model in major units', () => {
    const retainer = EVERY_KIND.find((o) => o.key === 'retainer') as Obligation;
    expect(toFlat(retainer, 'USD').terms).toContainEqual({ name: 'amount', value: '3000.00' });
  });
});

describe('mergeTerms', () => {
  const support = toFlat(EVERY_KIND.find((o) => o.key === 'support') as Obligation, 'USD');

  it('replaces only the terms the change names and keeps the rest', () => {
    const change = {
      ...support,
      title: 'Support hours (senior)',
      clauseIds: ['c3', 'amendment'],
      terms: [{ name: 'rate' as const, value: '45.00' }],
    };
    const merged = mergeTerms(support, change);
    expect(merged.title).toBe('Support hours (senior)');
    expect(merged.clauseIds).toEqual(['c3', 'amendment']);
    expect(merged.terms.filter((t) => t.name === 'rate')).toEqual([
      { name: 'rate', value: '45.00' },
    ]);
    const { obligation } = readObligation(merged, 'USD');
    expect(obligation).toMatchObject({ rate: 4_500n, included: 20, cap: 60, period: 'month' });
  });

  it('leaves the obligation as it was when the change names no terms', () => {
    expect(mergeTerms(support, { ...support, terms: [] }).terms).toEqual(support.terms);
  });
});
