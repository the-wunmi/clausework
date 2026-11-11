import type { PhaseDates } from '@clausework/billing';
import { DomainError, type Obligation, type Party, type Plan } from '@clausework/core';
import { agreements, type Db, type Tx } from '@clausework/db';
import type { PartyRef } from '@clausework/paypal';
import { eq } from 'drizzle-orm';
import {
  type AgreementRow,
  currentPhaseDates,
  loadAgreement,
  loadVersion,
  type Version,
} from './repo.ts';

/**
 * A running agreement's fixed context for one piece of work: the agreement, the approved version
 * and its plan, and where the phases sit. Loaded once and passed along; only phase dates and
 * charge rows can change between steps, and those are re-read where it matters.
 */
export interface Live {
  agreement: AgreementRow;
  version: Version;
  plan: Plan;
  owner: Party;
  phases: PhaseDates;
}

export async function loadLive(db: Db | Tx, agreementOrId: AgreementRow | string): Promise<Live> {
  const agreement =
    typeof agreementOrId === 'string' ? await loadAgreement(db, agreementOrId) : agreementOrId;
  if (!agreement.liveVersionId) throw new DomainError('conflict', 'The agreement is not live yet');
  const version = await loadVersion(db, agreement.liveVersionId);
  const owner = version.plan.parties.find((p) => p.key === agreement.ownerParty);
  if (!owner) throw new DomainError('conflict', 'The agreement has no owner party');
  return {
    agreement,
    version,
    plan: version.plan,
    owner,
    phases: await currentPhaseDates(db, agreement.id, version.plan),
  };
}

export async function liveAgreementIds(db: Db | Tx): Promise<string[]> {
  const rows = await db
    .select({ id: agreements.id })
    .from(agreements)
    .where(eq(agreements.status, 'active'));
  return rows.map((r) => r.id);
}

export function party(live: Live, key: string): Party {
  const p = live.plan.parties.find((x) => x.key === key);
  if (!p) throw new DomainError('invalid', `No party ${key}`);
  return p;
}

/** A party as PayPal sees them. A party without an email gets a stable placeholder address so every PayPal call has one. */
export function partyRef(p: Party): PartyRef {
  return { name: p.name, email: p.email ?? `${p.key}@parties.clausework.test` };
}

export function obligation(live: Live, key: string): Obligation {
  const o = live.plan.obligations.find((x) => x.key === key);
  if (!o) throw new DomainError('invalid', `No obligation ${key}`);
  return o;
}

/**
 * Who runs the money for an obligation. The owner's PayPal account collects what is owed to the
 * owner and pays out what the owner owes. Money between two other parties is tracked, not moved.
 */
export function flowOf(
  live: Live,
  o: Pick<Obligation, 'payer' | 'payee'>,
): 'collect' | 'pay' | 'track' {
  if (o.payee === live.owner.key) return 'collect';
  if (o.payer === live.owner.key) return 'pay';
  return 'track';
}

/**
 * Each clause's printed reference, once. Two clauses the reader split from one section share a
 * reference; a key with no clause is left out rather than shown raw.
 */
export function clauseRefs(plan: Plan, ids: string[]): string[] {
  const refs = ids
    .map((id) => plan.clauses.find((c) => c.id === id)?.ref.trim())
    .filter((r): r is string => Boolean(r));
  return [...new Set(refs)];
}
