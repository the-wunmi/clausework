import { createHmac } from 'node:crypto';
import type { Draft, Source } from '@clausework/agents';
import {
  checkPlan,
  describeFailure,
  diffPlans,
  type PlanIssue,
  runTests,
  type TestResult,
} from '@clausework/billing';
import {
  canonicalJson,
  DomainError,
  hashToken,
  locateQuotes,
  NewAgreement,
  newId,
  type Plan,
  parseInput,
  type Span,
  sha256,
} from '@clausework/core';
import { agreements, type Db, partyLinks, planVersions, type Tx } from '@clausework/db';
import { and, eq, type SQL } from 'drizzle-orm';
import { type Engine, runDirectly, type Step, serially, today } from './context.ts';
import { pdfText } from './pdf.ts';
import {
  type AgreementRow,
  currentVersion,
  loadAgreement,
  nextVersionNumber,
  recordEvent,
} from './repo.ts';
import { findSample, sampleFile } from './samples.ts';
import { enqueueCompile } from './workflows.ts';

/** How many repair passes the compiler gets before the remaining failures go to a person. */
const MAX_REPAIRS = 2;

/** Stores the document and queues the compiler. Returns before any model call. */
export async function createAgreement(
  engine: Engine,
  input: NewAgreement,
): Promise<{ id: string }> {
  const parsed = parseInput(NewAgreement, input);
  let sampleKey: string | null = null;
  let source:
    | { kind: 'pdf'; base64: string; name: string }
    | { kind: 'text'; text: string; name: string };
  if ('sample' in parsed) {
    const sample = findSample(parsed.sample);
    if (sample?.kind !== 'contract') throw new DomainError('not_found', 'No such sample');
    sampleKey = sample.key;
    source = sampleFile(sample);
  } else {
    source = parsed;
  }
  const text = source.kind === 'pdf' ? (await pdfText(source.base64)).text : source.text;
  const compileRun = newId();
  const [row] = await engine.db
    .insert(agreements)
    .values({
      title: source.name.replace(/\.(pdf|txt|md)$/i, ''),
      status: 'reading',
      sourceKind: source.kind,
      sourceName: source.name,
      sourceText: text,
      sourcePdf: source.kind === 'pdf' ? source.base64 : null,
      sampleKey,
      progress: { step: 'Reading the agreement', clauses: [] },
      compileRun,
    })
    .returning({ id: agreements.id });
  const id = (row as { id: string }).id;
  await recordEvent(engine.db, id, {
    actor: 'owner',
    type: 'uploaded',
    summary: `Uploaded ${source.name}`,
    occurredOn: await today(engine.db),
  });
  await enqueueCompile(id, compileRun);
  return { id };
}

export async function recompile(engine: Engine, agreement: AgreementRow): Promise<void> {
  // In the agreement's lane, on the row as it is once the lane is held: an approval that made it
  // live meanwhile must stop the recompile.
  await serially(engine, agreement.id, async () =>
    recompileNow(engine, await loadAgreement(engine.db, agreement.id)),
  );
}

async function recompileNow(engine: Engine, agreement: AgreementRow): Promise<void> {
  if (agreement.liveVersionId) {
    throw new DomainError(
      'conflict',
      'A live agreement changes through amendments, not recompiling',
    );
  }
  const [run] = await engine.db
    .update(agreements)
    .set({
      status: 'reading',
      failure: null,
      progress: { step: 'Reading the agreement', clauses: [] },
      compileRun: newId(),
    })
    .where(eq(agreements.id, agreement.id))
    .returning({ compileRun: agreements.compileRun });
  await enqueueCompile(agreement.id, run?.compileRun as string);
}

function sourceOf(agreement: AgreementRow): Source {
  return agreement.sourcePdf
    ? { kind: 'pdf', data: agreement.sourcePdf }
    : { kind: 'text', data: agreement.sourceText };
}

export function locateClauses(
  sourceText: string,
  plan: Pick<Plan, 'clauses'>,
): Record<string, Span | null> {
  const spans = locateQuotes(
    sourceText,
    plan.clauses.map((c) => c.quote),
  );
  return Object.fromEntries(plan.clauses.map((c, i) => [c.id, spans[i] ?? null]));
}

/**
 * Reads, compiles, tests, repairs and saves a version for review. Each model call is a step: run as a workflow, a crash
 * resumes after the last call that answered rather than paying for it again.
 */
export async function runCompile(
  engine: Engine,
  agreementId: string,
  step: Step = runDirectly,
  run?: string,
): Promise<void> {
  const agents = engine.agents;
  const agreement = await loadAgreement(engine.db, agreementId);
  // A recompile names a new run; this one then stops at its next check and writes nothing.
  const mine = run
    ? and(eq(agreements.id, agreementId), eq(agreements.compileRun, run))
    : eq(agreements.id, agreementId);
  const superseded = async () =>
    run !== undefined && (await loadAgreement(engine.db, agreementId)).compileRun !== run;
  if (await superseded()) return;
  if (!agents) {
    await fail(
      engine.db,
      agreement,
      'No model is configured. Set ANTHROPIC_API_KEY and recompile.',
      mine,
    );
    return;
  }
  const source = sourceOf(agreement);
  const { reading } = await step('read', () => agents.compiler.read(source));
  const spans = locateClauses(agreement.sourceText, reading);
  if (await superseded()) return;
  await engine.db
    .update(agreements)
    .set({
      status: 'compiling',
      title: reading.title,
      progress: {
        step: 'Compiling the money plan',
        clauses: reading.clauses.map((c) => ({ ...c, span: spans[c.id] ?? null })),
      },
    })
    .where(mine);

  let draft = await step('compile', () => agents.compiler.compile(source, reading));
  let origin: 'compile' | 'repair' = 'compile';
  let results: TestResult[] = [];
  let issues: PlanIssue[] = [];
  for (let attempt = 0; ; attempt++) {
    const problems = problemsOf(draft);
    results = draft.plan ? runTests(draft.plan) : [];
    issues = draft.plan ? checkPlan(draft.plan) : [];
    if (problems.length === 0 || attempt >= MAX_REPAIRS) break;
    await engine.db
      .update(agreements)
      .set({
        progress: {
          step: `Repairing ${problems.length} failing check${problems.length === 1 ? '' : 's'}`,
          clauses: reading.clauses.map((c) => ({ ...c, span: spans[c.id] ?? null })),
        },
      })
      .where(mine);
    const before = draft;
    draft = await step(`repair:${attempt + 1}`, () =>
      agents.compiler.repair(source, reading, before, problems),
    );
    if (await superseded()) return;
    origin = 'repair';
  }
  if (await superseded()) return;
  if (!draft.plan) {
    await fail(
      engine.db,
      agreement,
      `The compiler could not produce a valid plan: ${draft.problems.slice(0, 3).join('; ')}`,
      mine,
    );
    return;
  }
  const plan = draft.plan;
  // Its own step, so a recovered run does not save the version twice; skipped if this run was
  // superseded, or already saved before a crash (the agreement then left reading/compiling).
  await step('save', async () => {
    const now = await loadAgreement(engine.db, agreementId);
    if ((run && now.compileRun !== run) || !['reading', 'compiling'].includes(now.status)) return;
    await saveVersion(engine, now, {
      plan,
      origin,
      note:
        origin === 'repair'
          ? 'Compiled, then repaired after generated tests failed'
          : 'Compiled from the agreement',
      spans,
      results,
      issues,
      model: draft.metadata,
    });
  });
}

function problemsOf(draft: Draft): string[] {
  if (!draft.plan) return draft.problems;
  const plan = draft.plan;
  return [
    ...runTests(plan)
      .filter((r) => !r.pass)
      .map((r) => `Test ${describeFailure(plan, r)}`),
    ...checkPlan(plan).map((i) => `Plan issue${i.subject ? ` (${i.subject})` : ''}: ${i.message}`),
  ];
}

async function fail(
  db: Db,
  agreement: AgreementRow,
  failure: string,
  where: SQL | undefined = eq(agreements.id, agreement.id),
): Promise<void> {
  const updated = await db
    .update(agreements)
    .set({ status: 'failed', failure, progress: null })
    .where(where)
    .returning({ id: agreements.id });
  if (updated.length === 0) return;
  await recordEvent(db, agreement.id, {
    actor: 'system',
    type: 'compile_failed',
    summary: failure,
    occurredOn: await today(db),
  });
}

export interface NewVersion {
  plan: Plan;
  origin: 'compile' | 'repair' | 'amendment' | 'edit';
  note: string;
  spans: Record<string, Span | null>;
  results?: TestResult[];
  issues?: PlanIssue[];
  model?: Record<string, unknown>;
  evidence?: Record<string, unknown> | null;
  effectiveFrom?: string | null;
}

/** Saves a plan version as the one under review. Approvals bind to its hash, so they start over. */
export async function saveVersion(
  engine: Engine,
  agreement: AgreementRow,
  input: NewVersion,
): Promise<string> {
  const results = input.results ?? runTests(input.plan);
  const issues = input.issues ?? checkPlan(input.plan);
  const previous = await currentVersion(engine.db, agreement);
  const diff = previous ? diffPlans(previous.plan, input.plan) : null;
  const on = await today(engine.db);
  const hash = sha256(input.plan);
  return engine.db.transaction(async (tx) => {
    const version = await nextVersionNumber(tx, agreement.id);
    const [row] = await tx
      .insert(planVersions)
      .values({
        agreementId: agreement.id,
        version,
        plan: input.plan,
        hash,
        origin: input.origin,
        note: input.note,
        spans: input.spans,
        testResults: results.map((r) => ({
          obligation: r.test.obligation,
          name: r.test.name,
          given: r.test.given,
          expect: r.test.expect,
          actual: r.actual,
          pass: r.pass,
          error: r.error,
        })),
        issues,
        diff,
        evidence: input.evidence ?? null,
        effectiveFrom: input.effectiveFrom ?? null,
        model: input.model ?? null,
      })
      .returning({ id: planVersions.id });
    const versionId = (row as { id: string }).id;
    const ownerParty = agreement.ownerParty ?? defaultOwner(agreement, input.plan);
    await tx
      .update(agreements)
      .set({
        currentVersionId: versionId,
        title: input.plan.title,
        status: agreement.liveVersionId ? 'active' : 'review',
        progress: null,
        failure: null,
        ownerParty:
          ownerParty && input.plan.parties.some((p) => p.key === ownerParty) ? ownerParty : null,
      })
      .where(eq(agreements.id, agreement.id));
    await ensurePartyLinks(tx, engine.secret, agreement.id, input.plan);
    const passing = results.filter((r) => r.pass).length;
    await recordEvent(tx, agreement.id, {
      actor: input.origin === 'edit' ? 'owner' : 'agent',
      type: input.origin === 'amendment' ? 'amendment_drafted' : 'plan_compiled',
      summary:
        input.origin === 'amendment'
          ? `Drafted amendment v${version}: ${input.note}`
          : `${input.origin === 'edit' ? 'Edited' : 'Compiled'} money plan v${version}: ${input.plan.obligations.length} obligations, ${passing} of ${results.length} tests passing`,
      clauseIds: [],
      data: {
        version,
        hash,
        canonicalLength: canonicalJson(input.plan).length,
      },
      occurredOn: on,
    });
    return versionId;
  });
}

function defaultOwner(agreement: AgreementRow, plan: Plan): string | null {
  const wanted = agreement.sampleKey ? findSample(agreement.sampleKey)?.ownerParty : null;
  if (!wanted) return null;
  const exact = plan.parties.find((p) => p.key === wanted);
  if (exact) return exact.key;
  const loose = plan.parties.find(
    (p) => p.role.toLowerCase().includes(wanted) || p.key.includes(wanted),
  );
  return loose?.key ?? null;
}

/**
 * A party's portal token: an HMAC of the agreement and party under the server secret, so the owner
 * can be shown the link again without the token ever being stored. Only its hash is kept, for lookup.
 */
export function portalToken(secret: string, agreementId: string, partyKey: string): string {
  return createHmac('sha256', secret)
    .update(`portal:${agreementId}:${partyKey}`)
    .digest('base64url');
}

async function ensurePartyLinks(
  tx: Tx,
  secret: string,
  agreementId: string,
  plan: Plan,
): Promise<void> {
  for (const p of plan.parties) {
    await tx
      .insert(partyLinks)
      .values({
        agreementId,
        partyKey: p.key,
        tokenHash: hashToken(portalToken(secret, agreementId, p.key)),
      })
      .onConflictDoNothing();
  }
}
