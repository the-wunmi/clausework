import { type Plan, type TestCase, toMajor } from '@clausework/core';
import { EvaluationError, evaluate } from './evaluate.ts';

export interface TestResult {
  test: TestCase;
  pass: boolean;
  actual: bigint | null;
  error: string | null;
}

/** Runs every generated test against the plan. The plan is code; the tests are the clause's words. */
export function runTests(plan: Plan): TestResult[] {
  const byKey = new Map(plan.obligations.map((o) => [o.key, o]));
  return plan.tests.map((test) => {
    const obligation = byKey.get(test.obligation);
    if (!obligation) {
      return { test, pass: false, actual: null, error: `no obligation "${test.obligation}"` };
    }
    try {
      const actual = evaluate(plan, obligation, test.given);
      return { test, pass: actual === test.expect, actual, error: null };
    } catch (err) {
      if (err instanceof EvaluationError)
        return { test, pass: false, actual: null, error: err.message };
      throw err;
    }
  });
}

export function describeFailure(plan: Plan, r: TestResult): string {
  const expected = `${toMajor(r.test.expect, plan.currency)} ${plan.currency}`;
  if (r.error) return `"${r.test.name}": ${r.error}`;
  const actual = `${toMajor(r.actual ?? 0n, plan.currency)} ${plan.currency}`;
  return `"${r.test.name}": the clause says ${expected}, the plan computes ${actual}`;
}

export interface PlanIssue {
  /** The obligation, phase or party the issue is about, when there is one. */
  subject: string | null;
  code:
    | 'unknown_party'
    | 'unknown_clause'
    | 'unknown_phase'
    | 'unknown_obligation'
    | 'duplicate_key'
    | 'self_payment'
    | 'over_allocated'
    | 'no_tests'
    | 'phase_cycle';
  message: string;
}

/**
 * Structural checks the schema cannot express: every reference resolves, keys are unique, nobody
 * pays themselves, shares of one payment never exceed the whole, and every obligation is tested.
 */
export function checkPlan(plan: Plan): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const parties = new Set(plan.parties.map((p) => p.key));
  const clauses = new Set(plan.clauses.map((c) => c.id));
  const phases = new Set(plan.phases.map((p) => p.key));
  const obligations = new Set<string>();

  const dup = (kind: string, keys: string[]) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) {
        issues.push({ subject: k, code: 'duplicate_key', message: `${kind} "${k}" appears twice` });
      }
      seen.add(k);
    }
  };
  dup(
    'party',
    plan.parties.map((p) => p.key),
  );
  dup(
    'phase',
    plan.phases.map((p) => p.key),
  );
  dup(
    'obligation',
    plan.obligations.map((o) => o.key),
  );
  for (const o of plan.obligations) obligations.add(o.key);

  const refPhase = (subject: string, key: string | null) => {
    if (key !== null && !phases.has(key)) {
      issues.push({ subject, code: 'unknown_phase', message: `phase "${key}" is not defined` });
    }
  };
  const refObligation = (subject: string, key: string) => {
    if (key !== '*' && !obligations.has(key)) {
      issues.push({
        subject,
        code: 'unknown_obligation',
        message: `obligation "${key}" is not defined`,
      });
    }
  };

  for (const p of plan.phases) {
    for (const d of p.dependsOn) refPhase(p.key, d);
    if (p.gatedBy !== null) refObligation(p.key, p.gatedBy);
    for (const c of p.clauseIds) {
      if (!clauses.has(c)) {
        issues.push({ subject: p.key, code: 'unknown_clause', message: `clause ${c} not found` });
      }
    }
  }
  if (hasCycle(plan)) {
    issues.push({
      subject: null,
      code: 'phase_cycle',
      message: 'phases depend on each other in a loop',
    });
  }

  const tested = new Set(plan.tests.map((t) => t.obligation));
  const splitTotals = new Map<string, number>();

  for (const o of plan.obligations) {
    for (const party of [o.payer, o.payee]) {
      if (!parties.has(party)) {
        issues.push({
          subject: o.key,
          code: 'unknown_party',
          message: `party "${party}" is not defined`,
        });
      }
    }
    if (o.payer === o.payee) {
      issues.push({ subject: o.key, code: 'self_payment', message: `${o.payer} would pay itself` });
    }
    for (const c of o.clauseIds) {
      if (!clauses.has(c)) {
        issues.push({ subject: o.key, code: 'unknown_clause', message: `clause ${c} not found` });
      }
    }
    switch (o.kind) {
      case 'deposit':
      case 'milestone':
      case 'recurring':
        if ('due' in o && (o.due.kind === 'phase_start' || o.due.kind === 'phase_end')) {
          refPhase(o.key, o.due.phase);
        }
        if (o.kind === 'recurring' && o.start.kind !== 'date' && o.start.kind !== 'effective') {
          refPhase(o.key, o.start.phase);
        }
        if (o.kind === 'milestone') refPhase(o.key, o.phase);
        break;
      case 'late_fee':
        for (const k of o.appliesTo) refObligation(o.key, k);
        break;
      case 'revenue_share':
        for (const k of o.of) refObligation(o.key, k);
        break;
      case 'split':
      case 'retainage':
        for (const k of o.of) {
          refObligation(o.key, k);
          if (o.kind === 'split') splitTotals.set(k, (splitTotals.get(k) ?? 0) + o.bps);
        }
        if (o.kind === 'retainage' && o.release.kind !== 'date' && o.release.kind !== 'effective') {
          refPhase(o.key, o.release.phase);
        }
        break;
      case 'service_credit':
        refObligation(o.key, o.of);
        break;
      default:
        break;
    }
    if (!tested.has(o.key)) {
      issues.push({ subject: o.key, code: 'no_tests', message: `"${o.key}" has no tests` });
    }
  }
  for (const [key, total] of splitTotals) {
    if (total > 10_000) {
      issues.push({
        subject: key,
        code: 'over_allocated',
        message: `splits of "${key}" add up to ${total / 100}%`,
      });
    }
  }
  return issues;
}

function hasCycle(plan: Plan): boolean {
  const deps = new Map(plan.phases.map((p) => [p.key, p.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (k: string): boolean => {
    if (state.get(k) === 'done') return false;
    if (state.get(k) === 'visiting') return true;
    state.set(k, 'visiting');
    for (const d of deps.get(k) ?? []) if (visit(d)) return true;
    state.set(k, 'done');
    return false;
  };
  return plan.phases.some((p) => visit(p.key));
}
