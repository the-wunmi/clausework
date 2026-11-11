import { canonicalJson, type Obligation, type Plan } from '@clausework/core';

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface PlanDiff {
  /** Plan-wide fields: dates, currency, contract value. */
  plan: FieldChange[];
  added: Obligation[];
  removed: Obligation[];
  changed: { key: string; title: string; changes: FieldChange[] }[];
  phases: { key: string; changes: FieldChange[] }[];
  /** Parties who pay or are paid under anything that changed. Each must approve again. */
  affectedParties: string[];
  empty: boolean;
}

/** Fields that describe the model's certainty, not the money. They never require re-approval. */
const NOT_MONEY = new Set(['confidence', 'ambiguities', 'clauseIds']);

function fieldChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ignore: Set<string> = new Set(),
): FieldChange[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: FieldChange[] = [];
  for (const field of fields) {
    if (ignore.has(field)) continue;
    if (canonicalJson(before[field]) !== canonicalJson(after[field])) {
      out.push({ field, before: before[field], after: after[field] });
    }
  }
  return out;
}

export function diffPlans(before: Plan, after: Plan): PlanDiff {
  const affected = new Set<string>();
  const touch = (o: Obligation) => {
    affected.add(o.payer);
    affected.add(o.payee);
  };

  const plan = fieldChanges(
    {
      currency: before.currency,
      effectiveDate: before.effectiveDate,
      endDate: before.endDate,
      contractValue: before.contractValue,
    },
    {
      currency: after.currency,
      effectiveDate: after.effectiveDate,
      endDate: after.endDate,
      contractValue: after.contractValue,
    },
  );
  if (plan.length > 0) for (const p of after.parties) affected.add(p.key);

  const old = new Map(before.obligations.map((o) => [o.key, o]));
  const now = new Map(after.obligations.map((o) => [o.key, o]));
  const added = after.obligations.filter((o) => !old.has(o.key));
  const removed = before.obligations.filter((o) => !now.has(o.key));
  for (const o of [...added, ...removed]) touch(o);

  const changed: PlanDiff['changed'] = [];
  for (const o of after.obligations) {
    const prev = old.get(o.key);
    if (!prev) continue;
    const changes = fieldChanges(prev, o, NOT_MONEY);
    if (changes.length > 0) {
      changed.push({ key: o.key, title: o.title, changes });
      touch(o);
      touch(prev);
    }
  }

  const oldPhases = new Map(before.phases.map((p) => [p.key, p]));
  const phases: PlanDiff['phases'] = [];
  for (const p of after.phases) {
    const prev = oldPhases.get(p.key);
    const changes = prev
      ? fieldChanges(prev, p, new Set(['clauseIds']))
      : [{ field: 'phase', before: null, after: p.name }];
    if (changes.length > 0) phases.push({ key: p.key, changes });
  }
  // A moved phase moves the money tied to it.
  for (const ph of phases) {
    for (const o of after.obligations) {
      const ref = o.kind === 'milestone' ? o.due : o.kind === 'retainage' ? o.release : null;
      if (ref && (ref.kind === 'phase_end' || ref.kind === 'phase_start') && ref.phase === ph.key) {
        touch(o);
      }
    }
  }

  return {
    plan,
    added,
    removed,
    changed,
    phases,
    affectedParties: [...affected].sort(),
    empty: plan.length + added.length + removed.length + changed.length + phases.length === 0,
  };
}
