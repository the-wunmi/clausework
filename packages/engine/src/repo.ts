import { type PhaseDates, plannedPhaseDates } from '@clausework/billing';
import { DomainError, Plan, type Span } from '@clausework/core';
import {
  agreements,
  approvals,
  type Db,
  events,
  phaseDates,
  planVersions,
  type Tx,
} from '@clausework/db';
import { and, asc, desc, eq } from 'drizzle-orm';

export type AgreementRow = typeof agreements.$inferSelect;
export type VersionRow = typeof planVersions.$inferSelect;

/** A plan version with its plan parsed into bigint amounts. */
export interface Version {
  row: VersionRow;
  plan: Plan;
  spans: Record<string, Span | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` could be a row id, so a malformed one is not found instead of a database error. */
export const isUuid = (id: string): boolean => UUID.test(id);

export async function loadAgreement(db: Db | Tx, id: string): Promise<AgreementRow> {
  const [row] = isUuid(id) ? await db.select().from(agreements).where(eq(agreements.id, id)) : [];
  if (!row) throw new DomainError('not_found', 'No such agreement');
  return row;
}

export function toVersion(row: VersionRow): Version {
  return {
    row,
    plan: Plan.parse(row.plan),
    spans: row.spans as Record<string, Span | null>,
  };
}

export async function loadVersion(db: Db | Tx, id: string): Promise<Version> {
  const [row] = await db.select().from(planVersions).where(eq(planVersions.id, id));
  if (!row) throw new DomainError('not_found', 'No such plan version');
  return toVersion(row);
}

export async function currentVersion(
  db: Db | Tx,
  agreement: AgreementRow,
): Promise<Version | null> {
  return agreement.currentVersionId ? loadVersion(db, agreement.currentVersionId) : null;
}

export async function liveVersion(db: Db | Tx, agreement: AgreementRow): Promise<Version | null> {
  return agreement.liveVersionId ? loadVersion(db, agreement.liveVersionId) : null;
}

/** The live version, or the one under review while none is live yet. */
export async function activeVersion(db: Db | Tx, agreement: AgreementRow): Promise<Version | null> {
  return (await liveVersion(db, agreement)) ?? (await currentVersion(db, agreement));
}

export async function listVersions(db: Db | Tx, agreementId: string): Promise<VersionRow[]> {
  return db
    .select()
    .from(planVersions)
    .where(eq(planVersions.agreementId, agreementId))
    .orderBy(asc(planVersions.version));
}

export async function nextVersionNumber(db: Db | Tx, agreementId: string): Promise<number> {
  const [last] = await db
    .select({ version: planVersions.version })
    .from(planVersions)
    .where(eq(planVersions.agreementId, agreementId))
    .orderBy(desc(planVersions.version))
    .limit(1);
  return (last?.version ?? 0) + 1;
}

export type PhaseRow = typeof phaseDates.$inferSelect;

export async function loadPhaseRows(db: Db | Tx, agreementId: string): Promise<PhaseRow[]> {
  return db.select().from(phaseDates).where(eq(phaseDates.agreementId, agreementId));
}

/** Where each phase sits now: the plan's dates, overridden by any move recorded since. */
export async function currentPhaseDates(
  db: Db | Tx,
  agreementId: string,
  plan: Plan,
): Promise<PhaseDates> {
  const dates = plannedPhaseDates(plan);
  for (const row of await loadPhaseRows(db, agreementId)) {
    if (dates[row.phaseKey]) dates[row.phaseKey] = { start: row.start, end: row.end };
  }
  return dates;
}

export type ApprovalRow = typeof approvals.$inferSelect;

/** The latest approval per party among `rows`, which must be oldest first. */
function latestPerParty(rows: ApprovalRow[]): Map<string, ApprovalRow> {
  const latest = new Map<string, ApprovalRow>();
  for (const r of rows) latest.set(r.partyKey, r);
  return latest;
}

/** Each party's latest position on a version. */
export async function latestApprovals(
  db: Db | Tx,
  agreementId: string,
  versionId: string,
): Promise<Map<string, ApprovalRow>> {
  return latestPerParty(
    await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.agreementId, agreementId), eq(approvals.versionId, versionId)))
      .orderBy(asc(approvals.createdAt)),
  );
}

/** Each party's latest position on any version, so a view can say "approved v1, not v2 yet". */
export async function lastApprovalByParty(
  db: Db | Tx,
  agreementId: string,
): Promise<Map<string, ApprovalRow>> {
  return latestPerParty(
    await db
      .select()
      .from(approvals)
      .where(eq(approvals.agreementId, agreementId))
      .orderBy(asc(approvals.createdAt)),
  );
}

/** Parties who pay or are paid under a plan. Each must approve it. */
export function partiesWhoMustApprove(plan: Plan): string[] {
  const keys = new Set<string>();
  for (const o of plan.obligations) {
    keys.add(o.payer);
    keys.add(o.payee);
  }
  return plan.parties.map((p) => p.key).filter((k) => keys.has(k));
}

export interface EventInput {
  actor: string;
  type: string;
  summary: string;
  clauseIds?: string[];
  data?: Record<string, unknown>;
  occurredOn: string;
}

export async function recordEvent(db: Db | Tx, agreementId: string, e: EventInput): Promise<void> {
  await db.insert(events).values({
    agreementId,
    actor: e.actor,
    type: e.type,
    summary: e.summary,
    clauseIds: e.clauseIds ?? [],
    data: e.data ?? {},
    occurredOn: e.occurredOn,
  });
}
