import { checkPlan, runTests } from '@clausework/billing';
import {
  ApprovalDecision,
  CONFIDENT,
  DomainError,
  hashToken,
  Obligation,
  ObligationEdit,
  OwnerInput,
  PartyInput,
  type Plan,
  parseInput,
} from '@clausework/core';
import { agreements, approvals, partyLinks } from '@clausework/db';
import { eq } from 'drizzle-orm';
import { activate } from './activate.ts';
import { saveVersion } from './compile.ts';
import { type Engine, serially, today } from './context.ts';
import {
  type AgreementRow,
  currentVersion,
  latestApprovals,
  loadAgreement,
  partiesWhoMustApprove,
  recordEvent,
  type Version,
} from './repo.ts';

/**
 * Runs `work` in the agreement's lane on the agreement as it is once the lane is held: the row the
 * caller loaded may be behind an edit or approval that held the lane first.
 */
async function inLane(
  engine: Engine,
  agreement: AgreementRow,
  work: (fresh: AgreementRow) => Promise<void>,
): Promise<void> {
  await serially(engine, agreement.id, async () =>
    work(await loadAgreement(engine.db, agreement.id)),
  );
}

export async function setOwner(
  engine: Engine,
  agreement: AgreementRow,
  input: OwnerInput,
): Promise<void> {
  await inLane(engine, agreement, (fresh) => setOwnerNow(engine, fresh, input));
}

async function setOwnerNow(
  engine: Engine,
  agreement: AgreementRow,
  input: OwnerInput,
): Promise<void> {
  const { party } = parseInput(OwnerInput, input);
  if (agreement.liveVersionId) throw new DomainError('conflict', 'The agreement is already live');
  const version = await requireVersion(engine, agreement);
  // Approvals are given as a party; changing who "you" are after one would let the owner sign
  // for someone else.
  if ((await latestApprovals(engine.db, agreement.id, version.row.id)).size > 0) {
    throw new DomainError(
      'conflict',
      'Approvals have started; which party you are can no longer change',
    );
  }
  if (!version.plan.parties.some((p) => p.key === party)) {
    throw new DomainError('invalid', `No party ${party}`);
  }
  await engine.db
    .update(agreements)
    .set({ ownerParty: party })
    .where(eq(agreements.id, agreement.id));
}

async function requireVersion(engine: Engine, agreement: AgreementRow): Promise<Version> {
  const version = await currentVersion(engine.db, agreement);
  if (!version) throw new DomainError('conflict', 'The agreement is still being read');
  return version;
}

/**
 * A party's decision on the version under review, bound to its hash. When the last required
 * approval arrives the plan goes live by itself: approval is the signature.
 */
export async function decide(
  engine: Engine,
  agreement: AgreementRow,
  partyKey: string,
  input: ApprovalDecision,
): Promise<void> {
  await inLane(engine, agreement, (fresh) => decideNow(engine, fresh, partyKey, input));
}

async function decideNow(
  engine: Engine,
  agreement: AgreementRow,
  partyKey: string,
  input: ApprovalDecision,
): Promise<void> {
  const { decision, comment, planHash } = parseInput(ApprovalDecision, input);
  const version = await requireVersion(engine, agreement);
  // Nobody signs a plan the owner has not stood behind, or one for an agreement already over.
  const unsure = version.plan.obligations.filter((o) => o.confidence < CONFIDENT);
  if (decision === 'approved' && unsure.length > 0) {
    throw new DomainError(
      'conflict',
      `${unsure.map((o) => o.title).join(', ')} still need${unsure.length === 1 ? 's' : ''} the owner to confirm or correct ${unsure.length === 1 ? 'it' : 'them'}`,
    );
  }
  if (
    decision === 'approved' &&
    version.plan.endDate &&
    version.plan.endDate < (await today(engine.db))
  ) {
    throw new DomainError(
      'conflict',
      `This agreement ended on ${version.plan.endDate}; audit it instead of billing it`,
    );
  }
  if (planHash && planHash !== version.row.hash) {
    throw new DomainError(
      'conflict',
      'The money plan changed while you were reading it. Review the new version.',
    );
  }
  const party = version.plan.parties.find((p) => p.key === partyKey);
  if (!party) throw new DomainError('not_found', 'No such party');
  if (!partiesWhoMustApprove(version.plan).includes(partyKey)) {
    throw new DomainError('forbidden', `${party.name} neither pays nor is paid under this plan`);
  }
  if (agreement.liveVersionId === version.row.id) {
    throw new DomainError('conflict', 'This version is already live');
  }
  const on = await today(engine.db);
  await engine.db.insert(approvals).values({
    agreementId: agreement.id,
    versionId: version.row.id,
    planHash: version.row.hash,
    partyKey,
    decision,
    comment: comment ?? null,
  });
  await recordEvent(engine.db, agreement.id, {
    actor: `party:${partyKey}`,
    type: decision === 'approved' ? 'approved' : 'changes_requested',
    summary:
      decision === 'approved'
        ? `${party.name} approved money plan v${version.row.version}`
        : `${party.name} asked for changes to v${version.row.version}${comment ? `: “${comment}”` : ''}`,
    data: { versionId: version.row.id, hash: version.row.hash },
    occurredOn: on,
  });
  if (decision === 'approved' && (await allApproved(engine, agreement, version))) {
    await activate(engine, await loadAgreement(engine.db, agreement.id));
  }
}

export async function allApproved(
  engine: Engine,
  agreement: AgreementRow,
  version: Version,
): Promise<boolean> {
  if (!agreement.ownerParty) return false;
  const latest = await latestApprovals(engine.db, agreement.id, version.row.id);
  return partiesWhoMustApprove(version.plan).every((p) => {
    const a = latest.get(p);
    return a?.decision === 'approved' && a.planHash === version.row.hash;
  });
}

/** Resolves a portal token to its agreement and party. */
export async function partyForToken(
  engine: Engine,
  token: string,
): Promise<{ agreement: AgreementRow; partyKey: string }> {
  const [link] = await engine.db
    .select()
    .from(partyLinks)
    .where(eq(partyLinks.tokenHash, hashToken(token)));
  if (!link) throw new DomainError('not_found', 'This link is not valid');
  return { agreement: await loadAgreement(engine.db, link.agreementId), partyKey: link.partyKey };
}

/**
 * The owner corrects one obligation, for example where the compiler was unsure. The plan is
 * re-tested and saved as a new version, so every party approves the corrected money again.
 */
export async function editObligation(
  engine: Engine,
  agreement: AgreementRow,
  key: string,
  input: ObligationEdit,
): Promise<void> {
  await inLane(engine, agreement, (fresh) => editObligationNow(engine, fresh, key, input));
}

async function editObligationNow(
  engine: Engine,
  agreement: AgreementRow,
  key: string,
  input: ObligationEdit,
): Promise<void> {
  const { obligation, note } = parseInput(ObligationEdit, input);
  const version = await requireVersion(engine, agreement);
  const parsed = parseInput(Obligation, obligation);
  if (parsed.key !== key) throw new DomainError('invalid', 'The obligation key cannot change');
  if (!version.plan.obligations.some((o) => o.key === key)) {
    throw new DomainError('not_found', `No obligation ${key}`);
  }
  const plan: Plan = {
    ...version.plan,
    obligations: version.plan.obligations.map((o) =>
      o.key === key ? { ...parsed, confidence: 1, ambiguities: [] } : o,
    ),
  };
  await saveVersion(engine, agreement, {
    plan,
    origin: 'edit',
    note: note ?? `Edited ${parsed.title}`,
    spans: version.spans,
    results: runTests(plan),
    issues: checkPlan(plan),
  });
}

/**
 * Corrects a party's name or PayPal email, for example to a sandbox account. Who gets paid is part
 * of the money, so it is a new version and every party approves again.
 */
export async function editParty(
  engine: Engine,
  agreement: AgreementRow,
  partyKey: string,
  input: PartyInput,
): Promise<void> {
  await inLane(engine, agreement, (fresh) => editPartyNow(engine, fresh, partyKey, input));
}

async function editPartyNow(
  engine: Engine,
  agreement: AgreementRow,
  partyKey: string,
  input: PartyInput,
): Promise<void> {
  const u = parseInput(PartyInput, input);
  if (agreement.liveVersionId) {
    throw new DomainError('conflict', 'A live agreement changes through an amendment');
  }
  const version = await requireVersion(engine, agreement);
  const party = version.plan.parties.find((p) => p.key === partyKey);
  if (!party) throw new DomainError('not_found', `No party ${partyKey}`);
  const updated = {
    ...party,
    name: u.name ?? party.name,
    email: u.email === undefined ? party.email : u.email,
  };
  if (updated.name === party.name && updated.email === party.email) return;
  const plan: Plan = {
    ...version.plan,
    parties: version.plan.parties.map((p) => (p.key === partyKey ? updated : p)),
  };
  await saveVersion(engine, agreement, {
    plan,
    origin: 'edit',
    note: `Updated ${updated.name}'s details`,
    spans: version.spans,
  });
}

/** The owner stands behind an obligation the compiler was unsure of, as written. */
export async function confirmObligation(
  engine: Engine,
  agreement: AgreementRow,
  key: string,
): Promise<void> {
  const version = await requireVersion(engine, agreement);
  const o = version.plan.obligations.find((x) => x.key === key);
  if (!o) throw new DomainError('not_found', `No obligation ${key}`);
  await editObligation(engine, agreement, key, {
    obligation: o,
    note: `Confirmed ${o.title} as written`,
  });
}
