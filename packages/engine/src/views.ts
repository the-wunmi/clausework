import { daysBetween, explainObligation } from '@clausework/billing';
import type {
  AgreementDetail,
  AgreementSummary,
  AuditView,
  ChargeView,
  ClauseView,
  DecisionView,
  EventView,
  LedgerRow,
  Minor,
  PartyView,
  PhaseView,
  PortalView,
  SetupStep,
  Stage,
  Totals,
  VersionView,
} from '@clausework/core';
import { CONFIDENT, DomainError, type Plan, productFor, type Span } from '@clausework/core';
import {
  agentDecisions,
  agreements,
  audits,
  bindings,
  charges,
  events,
  ledgerEntries,
} from '@clausework/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import { portalToken } from './compile.ts';
import { type Engine, today } from './context.ts';
import { clauseRefs } from './live.ts';
import { type ChargeRow, chargeByKey } from './money.ts';
import { gateCharge } from './phases.ts';
import {
  type AgreementRow,
  activeVersion,
  currentVersion,
  lastApprovalByParty,
  latestApprovals,
  listVersions,
  liveVersion,
  loadAgreement,
  loadPhaseRows,
  loadVersion,
  partiesWhoMustApprove,
  type Version,
} from './repo.ts';
import { allApproved } from './review.ts';
import { SUBSCRIPTION_DECIDED } from './webhooks.ts';

/** bigint → JSON string of minor units, everywhere in a value. */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

const m = (v: bigint | null | undefined): Minor | null =>
  v === null || v === undefined ? null : v.toString();

async function stageOf(
  engine: Engine,
  agreement: AgreementRow,
  version: Version | null,
): Promise<Stage> {
  if (agreement.status === 'reading') return 'reading';
  if (agreement.status === 'compiling') return 'compiling';
  if (agreement.status === 'failed') return 'failed';
  if (agreement.status === 'completed') return 'completed';
  if (!version) return 'reading';
  const live = agreement.liveVersionId === version.row.id;
  if (live) {
    const setup = await setupSteps(engine, agreement, version.plan);
    return setup.some((s) => s.status === 'waiting') ? 'awaiting_payer_setup' : 'live';
  }
  // An agreement that ended before it was ever run here is for auditing, not billing.
  if (version.plan.endDate && version.plan.endDate < (await today(engine.db))) return 'completed';
  if (!agreement.ownerParty) return 'needs_owner';
  const failing = (version.row.testResults as { pass: boolean }[]).some((t) => !t.pass);
  const unsure = version.plan.obligations.some((o) => o.confidence < CONFIDENT);
  if (failing || unsure) return 'needs_review';
  return (await allApproved(engine, agreement, version))
    ? 'ready_to_activate'
    : 'awaiting_approvals';
}

async function totalsOf(engine: Engine, agreement: AgreementRow, on: string): Promise<Totals> {
  const owner = agreement.ownerParty;
  const ledger = await engine.db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.agreementId, agreement.id));
  const rows = await engine.db.select().from(charges).where(eq(charges.agreementId, agreement.id));
  let collected = 0n;
  let paidOut = 0n;
  for (const e of ledger) {
    if (e.kind === 'collected' && e.toParty === owner) collected += e.amount;
    if (e.kind === 'paid_out' && e.fromParty === owner) paidOut += e.amount;
  }
  let scheduled = 0n;
  let overdue = 0n;
  for (const c of rows) {
    if (c.payee !== owner || c.amount === null) continue;
    if (c.status === 'overdue') overdue += c.amount;
    else if (
      ['scheduled', 'issued', 'authorized', 'awaiting_approval'].includes(c.status) &&
      (c.dueDate ?? on) >= on
    ) {
      scheduled += c.amount;
    }
  }
  return {
    collected: collected.toString(),
    paidOut: paidOut.toString(),
    scheduled: scheduled.toString(),
    overdue: overdue.toString(),
  };
}

export async function agreementSummary(
  engine: Engine,
  agreement: AgreementRow,
): Promise<AgreementSummary> {
  const version = await currentVersion(engine.db, agreement);
  const on = await today(engine.db);
  const plan = version?.plan ?? null;
  const must = plan ? partiesWhoMustApprove(plan) : [];
  const approvals = version
    ? await latestApprovals(engine.db, agreement.id, version.row.id)
    : new Map();
  const approved = must.filter((p) => {
    const a = approvals.get(p);
    return a?.decision === 'approved' && a.planHash === version?.row.hash;
  }).length;
  const [next] = await engine.db
    .select()
    .from(charges)
    .where(and(eq(charges.agreementId, agreement.id), eq(charges.status, 'scheduled')))
    .orderBy(asc(charges.dueDate))
    .limit(1);
  return {
    id: agreement.id,
    title: agreement.title,
    status: agreement.status,
    stage: await stageOf(engine, agreement, version),
    sourceKind: agreement.sourceKind,
    sourceName: agreement.sourceName,
    currency: plan?.currency ?? null,
    ownerParty: agreement.ownerParty,
    counterparties: plan
      ? plan.parties.filter((p) => p.key !== agreement.ownerParty).map((p) => p.name)
      : [],
    obligationCount: plan?.obligations.length ?? 0,
    totals: await totalsOf(engine, agreement, on),
    nextCharge: next?.dueDate
      ? { label: next.label, dueDate: next.dueDate, amount: m(next.amount) }
      : null,
    approvals: { required: must.length, approved },
    createdAt: agreement.createdAt.toISOString(),
    activatedAt: agreement.activatedAt?.toISOString() ?? null,
    sampleKey: agreement.sampleKey,
  };
}

export async function listAgreements(engine: Engine): Promise<AgreementSummary[]> {
  const rows = await engine.db.select().from(agreements).orderBy(desc(agreements.createdAt));
  return Promise.all(rows.map((r) => agreementSummary(engine, r)));
}

function clauseViews(plan: Plan, spans: Record<string, Span | null>): ClauseView[] {
  return plan.clauses.map((c) => ({ ...c, span: spans[c.id] ?? null }));
}

/**
 * A version as the UI shows it. `usageBilling` is whether this PayPal account has Usage-Based
 * Billing; without it, usage is invoiced at period close, and the plan says so.
 */
export function versionView(
  version: Version,
  owner: string | null,
  usageBilling = true,
): VersionView {
  const { plan, row } = version;
  const runsOn = (o: Plan['obligations'][number]) => {
    const product = productFor(o, owner);
    return product === 'usage_billing' && !usageBilling ? 'invoicing' : product;
  };
  return plain({
    id: row.id,
    version: row.version,
    origin: row.origin,
    note: row.note,
    hash: row.hash,
    createdAt: row.createdAt.toISOString(),
    effectiveFrom: row.effectiveFrom,
    plan: {
      title: plan.title,
      currency: plan.currency,
      effectiveDate: plan.effectiveDate,
      endDate: plan.endDate,
      contractValue: m(plan.contractValue),
      parties: plan.parties,
      clauses: clauseViews(plan, version.spans),
      phases: plan.phases,
      obligations: plan.obligations.map((o) => ({
        ...o,
        clauseIds: [...new Set(o.clauseIds)],
        ambiguities: o.ambiguities.map((a) => readable(plan, a)),
      })),
    },
    tests: row.testResults,
    issues: row.issues,
    diff: row.diff,
    evidence: row.evidence
      ? (({ source, quote, from, date }) => ({ source, quote, from, date }))(
          row.evidence as Record<string, string | null>,
        )
      : null,
    products: Object.fromEntries(plan.obligations.map((o) => [o.key, runsOn(o)])),
    unconfirmed: plan.obligations.filter((o) => o.confidence < CONFIDENT).map((o) => o.key),
    explanations: Object.fromEntries(
      plan.obligations.map((o) => [o.key, explainObligation(plan, o)]),
    ),
  }) as VersionView;
}

/**
 * Model-written notes in the names people use: any party or obligation key the model let slip
 * (`writer_a_royalty`) becomes the party's name or the obligation's title.
 */
export function readable(plan: Plan, text: string): string {
  const names = new Map<string, string>([
    ...plan.parties.map((p) => [p.key, p.name] as const),
    ...plan.obligations.map((o) => [o.key, o.title] as const),
  ]);
  const keys = [...names.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  if (keys.length === 0) return text;
  return text.replace(new RegExp(`\\b(${keys.join('|')})\\b`, 'g'), (k) => names.get(k) ?? k);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function chargeView(plan: Plan, owner: string | null, c: ChargeRow): ChargeView {
  const name = (k: string) => plan.parties.find((p) => p.key === k)?.name ?? k;
  const data = (c.paypalData ?? {}) as {
    approveUrl?: string | null;
    payerViewUrl?: string | null;
    /** Net of retainage, as invoiced (minor units as a string). */
    invoiced?: string;
    refused?: string;
  };
  const net = data.invoiced !== undefined ? BigInt(data.invoiced) : null;
  return {
    id: c.id,
    agreementId: c.agreementId,
    chargeKey: c.chargeKey,
    obligationKey: c.obligationKey,
    kind: c.kind as ChargeView['kind'],
    label: c.label,
    payer: c.payer,
    payee: c.payee,
    payerName: name(c.payer),
    payeeName: name(c.payee),
    amount: m(net ?? c.amount),
    grossAmount: net !== null && c.amount !== null && net !== c.amount ? m(c.amount) : null,
    currency: c.currency,
    status: c.status,
    // A refusal is current only while the charge still waits to move.
    problem: data.refused && ['scheduled', 'failed'].includes(c.status) ? data.refused : null,
    issueDate: c.issueDate,
    dueDate: c.dueDate,
    paidOn: c.paidOn,
    periodIndex: c.periodIndex,
    clauseIds: c.clauseIds,
    clauseRefs: clauseRefs(plan, c.clauseIds),
    paypalProduct: c.paypalProduct as ChargeView['paypalProduct'],
    paypalRef: c.paypalRef,
    basis: c.basis,
    payUrl:
      c.status === 'awaiting_approval'
        ? (data.approveUrl ?? null)
        : ['issued', 'overdue'].includes(c.status)
          ? (data.payerViewUrl ?? null)
          : null,
    direction: c.payee === owner ? 'in' : c.payer === owner ? 'out' : 'other',
  };
}

async function setupSteps(
  engine: Engine,
  agreement: AgreementRow,
  plan: Plan,
): Promise<SetupStep[]> {
  if (!agreement.liveVersionId) return [];
  const rows = await engine.db
    .select()
    .from(bindings)
    .where(eq(bindings.agreementId, agreement.id));
  const steps: SetupStep[] = [];
  for (const b of rows) {
    const o = plan.obligations.find((x) => x.key === b.obligationKey);
    if (!o) continue;
    if (b.role === 'deposit_order') {
      const charge = await chargeByKey(engine.db, agreement.id, o.key);
      const done = charge ? !['awaiting_approval', 'scheduled'].includes(charge.status) : false;
      steps.push({
        obligationKey: o.key,
        title: `Authorize the ${o.title.toLowerCase()} on PayPal`,
        product: 'orders',
        party: o.payer,
        status: done ? 'done' : 'waiting',
        actionUrl: done ? null : ((b.data as { approveUrl?: string }).approveUrl ?? null),
      });
    }
    if (b.role === 'subscription') {
      const done = SUBSCRIPTION_DECIDED.includes(b.state);
      steps.push({
        obligationKey: o.key,
        title: `Approve the ${o.title.toLowerCase()} subscription on PayPal`,
        product: 'subscriptions',
        party: o.payer,
        status: done ? 'done' : 'waiting',
        actionUrl: done ? null : ((b.data as { approveUrl?: string }).approveUrl ?? null),
      });
    }
  }
  return steps;
}

export async function agreementDetail(engine: Engine, id: string): Promise<AgreementDetail> {
  const agreement = await loadAgreement(engine.db, id);
  const version = await currentVersion(engine.db, agreement);
  const summary = await agreementSummary(engine, agreement);
  const plan = version?.plan ?? null;
  const approvals = version
    ? await latestApprovals(engine.db, agreement.id, version.row.id)
    : new Map();
  const earlier = await lastApprovalByParty(engine.db, agreement.id);
  const must = plan ? partiesWhoMustApprove(plan) : [];
  const parties: PartyView[] = (plan?.parties ?? []).map((p) => {
    const a = approvals.get(p.key) ?? earlier.get(p.key);
    return {
      ...p,
      isOwner: p.key === agreement.ownerParty,
      mustApprove: must.includes(p.key),
      approval: a
        ? {
            decision: a.decision,
            comment: a.comment,
            at: a.createdAt.toISOString(),
            versionId: a.versionId,
            current: a.planHash === version?.row.hash,
          }
        : null,
      portalUrl: `${engine.publicUrl}/p/${portalToken(engine.secret, agreement.id, p.key)}`,
    };
  });
  const rows = await engine.db
    .select()
    .from(charges)
    .where(eq(charges.agreementId, agreement.id))
    .orderBy(asc(charges.dueDate), asc(charges.periodIndex));
  const phaseRows = await loadPhaseRows(engine.db, agreement.id);
  const phases: PhaseView[] = [];
  for (const p of plan?.phases ?? []) {
    const row = phaseRows.find((r) => r.phaseKey === p.key);
    let blockedBy: PhaseView['blockedBy'] = null;
    if (p.gatedBy && agreement.liveVersionId && plan && !row?.completedOn) {
      const gate = await gateCharge(engine, agreement.id, p.gatedBy);
      // An authorized deposit is secured: it is captured as the phase starts, so it holds nothing.
      if (gate && gate.status !== 'paid' && gate.status !== 'authorized')
        blockedBy = { chargeId: gate.id, label: gate.label, status: gate.status };
    }
    phases.push({
      ...p,
      current: {
        start: row?.start ?? p.start,
        end: row?.end ?? p.end,
        completedOn: row?.completedOn ?? null,
      },
      blockedBy,
    });
  }
  const versions = version ? await listVersions(engine.db, agreement.id) : [];
  const progress = agreement.progress as AgreementDetail['progress'];
  const { usageBilling } = await engine.gateway.capabilities();
  return {
    agreement: {
      ...summary,
      sourceText: agreement.sourceText,
      hasPdf: agreement.sourcePdf !== null,
      failure: agreement.failure,
    },
    version: version ? versionView(version, agreement.ownerParty, usageBilling) : null,
    liveObligations:
      agreement.liveVersionId && agreement.liveVersionId !== version?.row.id
        ? versionView(await loadVersion(engine.db, agreement.liveVersionId), agreement.ownerParty)
            .plan.obligations
        : null,
    liveVersionId: agreement.liveVersionId,
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      origin: v.origin,
      note: v.note,
      createdAt: v.createdAt.toISOString(),
      effectiveFrom: v.effectiveFrom,
    })),
    parties,
    phases,
    charges: plan ? rows.map((c) => chargeView(plan, agreement.ownerParty, c)) : [],
    setup: plan ? await setupSteps(engine, agreement, plan) : [],
    progress: progress ?? null,
  };
}

export async function portalView(
  engine: Engine,
  agreement: AgreementRow,
  partyKey: string,
): Promise<PortalView> {
  const detail = await agreementDetail(engine, agreement.id);
  const party = detail.parties.find((p) => p.key === partyKey);
  if (!party) throw new DomainError('not_found', 'This party is no longer part of the agreement');
  const plan = detail.version?.plan;
  const keys = (plan?.obligations ?? [])
    .filter((o) => o.payer === partyKey || o.payee === partyKey)
    .map((o) => o.key);
  const mine = detail.charges.filter((c) => c.payer === partyKey || c.payee === partyKey);
  const payouts = await engine.db
    .select()
    .from(charges)
    .where(
      and(
        eq(charges.agreementId, agreement.id),
        eq(charges.payee, partyKey),
        eq(charges.paypalProduct, 'payouts'),
      ),
    );
  return {
    agreementId: agreement.id,
    title: detail.agreement.title,
    party: { ...party, portalUrl: null },
    owner: plan?.parties.find((p) => p.key === agreement.ownerParty) ?? null,
    stage: detail.agreement.stage,
    live: detail.liveVersionId !== null,
    version: detail.version,
    obligationKeys: keys,
    charges: mine,
    setup: detail.setup.filter((s) => s.party === partyKey),
    statements: payouts
      .filter((c) => c.amount !== null)
      .map((c) => ({
        chargeId: c.id,
        date: c.paidOn ?? c.issueDate,
        amount: (c.amount as bigint).toString(),
        line: (c.paypalData as { statement?: string } | null)?.statement ?? c.basis ?? c.label,
        status: c.status,
      })),
  };
}

export async function eventViews(engine: Engine, agreementId: string): Promise<EventView[]> {
  const rows = await engine.db
    .select()
    .from(events)
    .where(eq(events.agreementId, agreementId))
    .orderBy(desc(events.createdAt))
    .limit(300);
  return plain(
    rows.map((e) => ({
      id: e.id,
      actor: e.actor,
      type: e.type,
      summary: e.summary,
      clauseIds: e.clauseIds,
      data: e.data as Record<string, unknown>,
      occurredOn: e.occurredOn,
      createdAt: e.createdAt.toISOString(),
    })),
  );
}

export async function decisionViews(engine: Engine, agreementId: string): Promise<DecisionView[]> {
  const rows = await engine.db
    .select()
    .from(agentDecisions)
    .where(eq(agentDecisions.agreementId, agreementId))
    .orderBy(desc(agentDecisions.occurredOn), desc(agentDecisions.createdAt))
    .limit(100);
  return plain(
    rows
      .filter((d) => d.decidedBy !== 'pending')
      .map((d) => ({
        id: d.id,
        trigger: d.trigger as DecisionView['trigger'],
        proposal: (d.proposal ?? {
          action: 'none',
          rationale: '',
          clauseId: null,
          clauseQuote: null,
        }) as DecisionView['proposal'],
        outcome: d.outcome as DecisionView['outcome'],
        decidedBy: d.decidedBy,
        occurredOn: d.occurredOn,
        createdAt: d.createdAt.toISOString(),
      })),
  );
}

export async function ledgerRows(engine: Engine): Promise<LedgerRow[]> {
  const on = await today(engine.db);
  const live = await engine.db.select().from(agreements).where(eq(agreements.status, 'active'));
  const out: LedgerRow[] = [];
  for (const a of live) {
    const version = await liveVersion(engine.db, a);
    if (!version) continue;
    const rows = await engine.db.select().from(charges).where(eq(charges.agreementId, a.id));
    for (const c of rows) {
      const view = chargeView(version.plan, a.ownerParty, c);
      const other =
        view.direction === 'in'
          ? view.payerName
          : view.direction === 'out'
            ? view.payeeName
            : `${view.payerName} → ${view.payeeName}`;
      out.push({
        ...view,
        agreementTitle: a.title,
        counterparty: other,
        daysOverdue:
          c.dueDate && c.dueDate < on && ['issued', 'overdue'].includes(c.status)
            ? daysBetween(c.dueDate, on)
            : null,
      });
    }
  }
  return out.sort((x, y) => (x.dueDate ?? '9999').localeCompare(y.dueDate ?? '9999'));
}

export async function auditView(
  engine: Engine,
  row: typeof audits.$inferSelect,
): Promise<AuditView> {
  const agreement = row.agreementId ? await loadAgreement(engine.db, row.agreementId) : null;
  const version = agreement ? await activeVersion(engine.db, agreement) : null;
  const plan = version?.plan ?? null;
  const matches = (row.matches ?? []) as {
    transactionId: string;
    chargeId: string | null;
    obligationKey: string | null;
    reason: string;
  }[];
  const report = row.report as Record<string, unknown> | null;
  return plain({
    id: row.id,
    agreementId: row.agreementId,
    agreementTitle: agreement?.title ?? null,
    status: row.status,
    perspective: row.perspective,
    sourceName: row.sourceName,
    currency: plan?.currency ?? null,
    failure: row.failure,
    createdAt: row.createdAt.toISOString(),
    report: report
      ? {
          ...report,
          leaks: (report.leaks as { clauseIds: string[] }[]).map((l) => ({
            ...l,
            clauseRefs: plan ? clauseRefs(plan, l.clauseIds) : l.clauseIds,
          })),
        }
      : null,
    transactions: (
      row.transactions as { id: string; date: string; amount: string; memo: string }[]
    ).map((t) => {
      const match = matches.find((x) => x.transactionId === t.id);
      return {
        id: t.id,
        date: t.date,
        amount: t.amount,
        memo: t.memo,
        matchedTo: match?.chargeId ?? match?.obligationKey ?? null,
        reason: match?.reason ?? null,
      };
    }),
  }) as AuditView;
}

export async function auditViews(engine: Engine): Promise<AuditView[]> {
  const rows = await engine.db.select().from(audits).orderBy(desc(audits.createdAt));
  return Promise.all(rows.map((r) => auditView(engine, r)));
}

/** The agreement a PayPal object belongs to: a charge's order or invoice, or a bound subscription. */
export async function agreementForPayPalRef(
  engine: Engine,
  paypalId: string,
): Promise<string | null> {
  const [charge] = await engine.db
    .select({ agreementId: charges.agreementId })
    .from(charges)
    .where(eq(charges.paypalRef, paypalId))
    .limit(1);
  if (charge) return charge.agreementId;
  const [binding] = await engine.db
    .select({ agreementId: bindings.agreementId })
    .from(bindings)
    .where(eq(bindings.paypalId, paypalId))
    .limit(1);
  return binding?.agreementId ?? null;
}
