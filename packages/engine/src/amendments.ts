import { mergeTerms, readObligation, readTest, toFlat } from '@clausework/agents';
import { diffPlans, explainObligation } from '@clausework/billing';
import {
  type Clause,
  DomainError,
  locateQuote,
  NewAmendment,
  type Obligation,
  type Plan,
  parseInput,
  type TestCase,
} from '@clausework/core';
import { approvals } from '@clausework/db';
import { activate } from './activate.ts';
import { saveVersion } from './compile.ts';
import { type Engine, serially, today } from './context.ts';
import {
  type AgreementRow,
  activeVersion,
  loadAgreement,
  loadVersion,
  partiesWhoMustApprove,
  recordEvent,
} from './repo.ts';
import { allApproved } from './review.ts';
import { findSample, sampleFile } from './samples.ts';

/**
 * Turns an email or chat thread into an amendment version. The change cites the message it came
 * from, verbatim; the new version is re-tested and goes to the parties it affects as a diff.
 * Parties the change does not touch keep their approval, recorded as carried over.
 */
export async function draftAmendment(
  engine: Engine,
  agreement: AgreementRow,
  input: NewAmendment,
): Promise<void> {
  await serially(engine, agreement.id, () => draftNow(engine, agreement, input));
}

async function draftNow(
  engine: Engine,
  agreement: AgreementRow,
  input: NewAmendment,
): Promise<void> {
  const parsed = parseInput(NewAmendment, input);
  let text: string;
  let name: string;
  if ('sample' in parsed) {
    const sample = findSample(parsed.sample);
    if (sample?.kind !== 'thread') throw new DomainError('not_found', 'No such sample thread');
    const file = sampleFile(sample);
    if (file.kind !== 'text') throw new DomainError('invalid', 'Sample thread is not text');
    text = file.text;
    name = sample.title;
  } else {
    text = parsed.text;
    name = parsed.name ?? 'Pasted thread';
  }
  if (!engine.agents)
    throw new DomainError('unavailable', 'No model is configured to read the thread');
  const base = await activeVersion(engine.db, agreement);
  if (!base) throw new DomainError('conflict', 'The agreement has no plan yet');
  const plan = base.plan;

  const draft = await engine.agents.drafter.draft({
    plan: {
      title: plan.title,
      currency: plan.currency,
      effectiveDate: plan.effectiveDate,
      parties: plan.parties,
      phases: plan.phases.map((p) => ({ key: p.key, name: p.name })),
      obligations: plan.obligations.map((o) => ({
        ...toFlat(o, plan.currency),
        explanation: explainObligation(plan, o),
      })),
    },
    thread: text,
  });
  if (!draft.agreed || draft.changes.length === 0) {
    throw new DomainError('conflict', `No agreed change found in the thread. ${draft.summary}`);
  }

  const clauseId = `c${plan.clauses.length + 1}`;
  const located = locateQuote(text, draft.quote);
  const clause: Clause = {
    id: clauseId,
    ref: `${name}${draft.date ? `, ${draft.date}` : ''}`.slice(0, 120),
    kind: 'other',
    quote: draft.quote,
  };
  const problems: string[] = located
    ? []
    : ['The quoted agreement could not be found in the thread'];
  const byKey = new Map(plan.obligations.map((o) => [o.key, o]));
  const touched = new Set<string>();
  for (const change of draft.changes) {
    touched.add(change.key);
    if (change.op === 'remove') {
      byKey.delete(change.key);
      continue;
    }
    if (!change.obligation) {
      problems.push(`${change.key}: no obligation given`);
      continue;
    }
    // An update names only what changes; every other term keeps its current value.
    const before = byKey.get(change.key);
    const flat =
      change.op === 'update' && before
        ? mergeTerms(toFlat(before, plan.currency), change.obligation)
        : change.obligation;
    const read = readObligation(flat, plan.currency);
    problems.push(...read.problems);
    if (!read.obligation) continue;
    const clauseIds = read.obligation.clauseIds
      .map((c) => (c === 'amendment' ? clauseId : c))
      .filter((c) => c === clauseId || plan.clauses.some((x) => x.id === c));
    byKey.set(read.obligation.key, {
      ...read.obligation,
      clauseIds: clauseIds.includes(clauseId) ? clauseIds : [...clauseIds, clauseId],
    } as Obligation);
  }
  const tests: TestCase[] = plan.tests.filter((t) => !touched.has(t.obligation));
  for (const t of draft.tests) {
    const read = readTest(t, plan.currency);
    problems.push(...read.problems);
    if (read.test) tests.push(read.test);
  }
  // Half an amendment is worse than none: if any change could not be read, nothing is saved.
  if (problems.length > 0) {
    throw new DomainError('invalid', 'The amendment could not be read from the thread', problems);
  }

  const next: Plan = {
    ...plan,
    clauses: [...plan.clauses, clause],
    obligations: [...byKey.values()],
    tests,
  };
  const diff = diffPlans(plan, next);
  const versionId = await saveVersion(engine, agreement, {
    plan: next,
    origin: 'amendment',
    note: draft.summary,
    spans: { ...base.spans, [clauseId]: null },
    evidence: {
      source: name,
      quote: draft.quote,
      from: draft.from,
      date: draft.date,
      text,
      problems,
    },
    effectiveFrom: draft.effectiveFrom,
  });

  const on = await today(engine.db);
  const version = await loadVersion(engine.db, versionId);
  for (const p of partiesWhoMustApprove(next)) {
    if (diff.affectedParties.includes(p)) continue;
    await engine.db.insert(approvals).values({
      agreementId: agreement.id,
      versionId,
      planHash: version.row.hash,
      partyKey: p,
      decision: 'approved',
      comment: 'Carried over: this amendment does not change anything this party pays or is paid.',
    });
  }
  // Re-read: saving the version moved the agreement's current version.
  const saved = await loadAgreement(engine.db, agreement.id);
  if (await allApproved(engine, saved, version)) {
    await activate(engine, saved);
    return;
  }
  await recordEvent(engine.db, agreement.id, {
    actor: 'agent',
    type: 'amendment_needs_approval',
    summary: `Waiting on ${diff.affectedParties.join(' and ')} to approve the amendment`,
    clauseIds: [clauseId],
    occurredOn: on,
  });
}
