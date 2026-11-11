'use client';

import type { AgreementDetail, DiffView, PartyView, VersionView } from '@clausework/core';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { day, KIND_LABEL, PRODUCT_LABEL, productLabel, stamp, uniqueRefs } from '@/lib/format';
import {
  clauseById,
  formatTerm,
  hasApproved,
  humanText,
  keyNames,
  partyName,
  termLabel,
} from '@/lib/plan';
import { useSeenVersion } from '@/lib/use-seen-version';
import { useApp } from '../app-context';
import { Pill, Spinner } from '../ui';
import { ObligationCard } from './obligation-card';
import { ObligationReview } from './obligation-review';

const ORIGIN_LABEL: Record<VersionView['origin'], string> = {
  compile: 'Compiled from the agreement',
  repair: 'Repaired after a failing test',
  amendment: 'Amendment',
  edit: 'Edited by you',
};

export function PlanView({
  detail,
  onChange,
  onStale,
}: {
  detail: AgreementDetail;
  onChange: (d: AgreementDetail) => void;
  /** The plan changed under the reader: fetch it again so they see what they would approve. */
  onStale: () => void;
}) {
  const { run, toast } = useApp();
  const v = detail.version;
  if (!v) {
    return (
      <p className="text-ink-2">The money plan appears here once the agreement is compiled.</p>
    );
  }
  const owner = detail.parties.find((p) => p.isOwner) ?? null;
  const stage = detail.agreement.stage;
  const live = detail.liveVersionId === v.id;
  // An ended agreement is kept for the record and the audit; nothing is left to confirm or sign.
  const ended = stage === 'completed';

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-8">
        {v.diff && !v.diff.empty && <AmendmentDiff version={v} diff={v.diff} />}

        {v.unconfirmed.length > 0 && !ended && (
          <section>
            <h2 className="serif mb-1 text-[19px] font-medium">
              Confirm {v.unconfirmed.length} uncertain term{v.unconfirmed.length === 1 ? '' : 's'}
            </h2>
            <p className="mb-3 text-[13px] text-ink-2">
              The model was not sure these lines say what the contract says. Read each against its
              clause, then confirm it as written or correct it.
            </p>
            <div className="space-y-3">
              {v.plan.obligations
                .filter((o) => v.unconfirmed.includes(o.key))
                .map((o) => (
                  <ObligationCard
                    key={o.key}
                    obligation={o}
                    version={v}
                    review={<ObligationReview detail={detail} obligation={o} onChange={onChange} />}
                  />
                ))}
            </div>
          </section>
        )}

        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="serif text-[19px] font-medium">The money plan</h2>
            <span className="text-[12.5px] text-ink-3">
              Version {v.version},{' '}
              {v.origin === 'amendment' ? 'amendment' : v.origin === 'edit' ? 'edited' : 'compiled'}{' '}
              {stamp(v.createdAt)}
              {v.effectiveFrom && `, applies from ${day(v.effectiveFrom)}`}
            </span>
          </div>
          <MoneyPlanTable version={v} />
          {!ended && (
            <p className="mt-2 text-[12.5px] text-ink-3">
              Approvals bind to this exact version (fingerprint{' '}
              <span className="num">{v.hash.slice(0, 12)}</span>). Any change creates a new version
              that the affected parties approve again.
            </p>
          )}
        </section>

        <SetupSteps detail={detail} />

        {detail.versions.length > 1 && (
          <section>
            <h2 className="serif mb-3 text-[19px] font-medium">Versions</h2>
            <ol className="sheet divide-y divide-rule-2">
              {[...detail.versions]
                .sort((a, b) => b.version - a.version)
                .map((ver) => (
                  <li
                    key={ver.id}
                    className="flex items-center justify-between px-4 py-2.5 text-[13px]"
                  >
                    <span>
                      <span className="num font-medium text-ink">Version {ver.version}</span>
                      <span className="ml-2 text-ink-2">
                        {ver.note
                          ? humanText(ver.note, undefined, keyNames(v.plan))
                          : ORIGIN_LABEL[ver.origin]}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 text-ink-3">
                      {ver.id === detail.liveVersionId && <Pill tone="seal">Live on PayPal</Pill>}
                      {ver.id === v.id && ver.id !== detail.liveVersionId && (
                        <Pill tone="ink">Under review</Pill>
                      )}
                      {stamp(ver.createdAt)}
                    </span>
                  </li>
                ))}
            </ol>
          </section>
        )}
      </div>

      <aside className="space-y-4">
        <OwnerDecision detail={detail} onChange={onChange} onStale={onStale} live={live} />
        <h2 className="serif pt-2 text-[17px] font-medium">
          {ended ? 'The parties' : 'Who signs the money'}
        </h2>
        {detail.parties.map((p) => (
          <PartyCard
            key={p.key}
            party={p}
            ended={ended}
            editable={detail.agreement.activatedAt === null && !ended}
            onEdit={async (body) => {
              const d = await run(
                () => api.editParty(detail.agreement.id, p.key, body),
                `Could not update ${p.name}`,
              );
              if (d) {
                onChange(d);
                toast({
                  tone: 'success',
                  title: `Updated ${body.name ?? p.name}`,
                  body: 'A new version was created, so approvals start again.',
                });
              }
              return d !== null;
            }}
          />
        ))}
        {owner === null && !ended && (
          <p className="rounded-md bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
            Choose which party you are at the top of the page before approving.
          </p>
        )}
      </aside>
    </div>
  );
}

function MoneyPlanTable({ version }: { version: VersionView }) {
  const plan = version.plan;
  const clauses = clauseById(plan);
  return (
    <div className="sheet overflow-hidden">
      <table className="w-full table-fixed text-[13px]">
        <colgroup>
          <col className="w-[38%]" />
          <col className="w-[24%]" />
          <col className="w-[15%]" />
          <col className="w-[23%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-rule-2 text-left text-[12px] text-ink-3">
            <th className="px-4 py-2.5 font-normal">Obligation</th>
            <th className="px-4 py-2.5 font-normal">Who pays whom</th>
            <th className="px-4 py-2.5 font-normal">Runs on PayPal</th>
            <th className="px-4 py-2.5 font-normal">Clause</th>
          </tr>
        </thead>
        <tbody>
          {plan.obligations.map((o) => (
            <tr key={o.key} className="border-b border-rule-2 align-top last:border-0">
              <td className="px-4 py-3">
                <div className="font-medium text-ink">{o.title}</div>
                <div className="text-ink-2">
                  {version.explanations[o.key] ?? KIND_LABEL[o.kind]}
                </div>
              </td>
              <td className="px-4 py-3 text-ink-2">
                {partyName(plan, o.payer)} <span className="text-ink-3">to</span>{' '}
                {partyName(plan, o.payee)}
              </td>
              <td className="px-4 py-3 text-paypal-deep">
                {productLabel(version.products[o.key])}
              </td>
              <td className="px-4 py-3 text-ink-2">
                {uniqueRefs(o.clauseIds.map((c) => clauses.get(c)?.ref ?? c)).join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OwnerDecision({
  detail,
  onChange,
  onStale,
  live,
}: {
  detail: AgreementDetail;
  onChange: (d: AgreementDetail) => void;
  onStale: () => void;
  live: boolean;
}) {
  const { run, toast } = useApp();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const owner = detail.parties.find((p) => p.isOwner);
  const stage = detail.agreement.stage;
  const id = detail.agreement.id;
  const ownerApproved = owner !== undefined && hasApproved(owner);
  const seen = useSeenVersion(detail.version?.hash);
  const unconfirmed = detail.version?.unconfirmed.length ?? 0;

  const decide = async (decision: 'approved' | 'changes_requested') => {
    setBusy(decision);
    const d = await run(
      () =>
        api.approve(id, {
          decision,
          comment: comment.trim() || undefined,
          planHash: detail.version?.hash,
        }),
      'Your decision was not recorded',
      (e) => e.status === 409 && onStale(),
    );
    setBusy(null);
    if (d) {
      onChange(d);
      setComment('');
      toast({
        tone: 'success',
        title: decision === 'approved' ? 'You approved the money plan' : 'Changes requested',
      });
    }
  };
  const goLive = async () => {
    setBusy('activate');
    const d = await run(() => api.activate(id), 'Could not go live');
    setBusy(null);
    if (d) {
      onChange(d);
      toast({
        tone: 'success',
        title: 'Live on PayPal',
        body: 'Payers now complete their PayPal approvals.',
      });
    }
  };

  if (stage === 'completed') {
    return (
      <div className="rounded-[10px] border border-rule bg-sheet px-4 py-3.5">
        <div className="serif text-[17px] text-ink">This agreement has ended</div>
        <p className="mt-1 mb-3 text-[13px] text-ink-2">
          Nothing more is billed under it. Check what was actually paid against what it said.
        </p>
        <Link href={`/audit?agreement=${encodeURIComponent(id)}`} className="btn btn-primary">
          Audit what was paid
        </Link>
      </div>
    );
  }

  if (live || stage === 'live' || stage === 'awaiting_payer_setup') {
    return (
      <div className="rounded-[10px] border border-seal/30 bg-seal-soft px-4 py-3.5">
        <div className="serif text-[17px] text-seal-deep">Running on PayPal</div>
        <p className="mt-1 text-[13px] text-seal-deep/80">
          Every party approved version {detail.version?.version}. The schedule agent keeps PayPal in
          step with the contract.
        </p>
      </div>
    );
  }

  if (stage === 'ready_to_activate') {
    return (
      <div className="rounded-[10px] border border-seal/30 bg-seal-soft px-4 py-4">
        <div className="serif text-[17px] text-seal-deep">Everyone approved</div>
        <p className="mt-1 mb-3 text-[13px] text-seal-deep/80">
          Going live creates the PayPal orders, subscriptions, invoices and payouts this plan needs.
        </p>
        <button
          type="button"
          className="btn btn-paypal w-full justify-center"
          disabled={busy !== null}
          onClick={() => void goLive()}
        >
          {busy === 'activate' ? <Spinner className="size-3.5" /> : null}
          Go live on PayPal
        </button>
      </div>
    );
  }

  return (
    <div className="sheet px-4 py-4">
      <div className="serif text-[17px] text-ink">Your decision</div>
      {ownerApproved ? (
        <p className="mt-1 text-[13px] text-seal">
          You approved version {detail.version?.version} {stamp(owner?.approval?.at)}. Waiting on
          the other parties.
        </p>
      ) : (
        <>
          <p className="mt-1 mb-3 text-[13px] text-ink-2">
            Check each obligation against its clause. Approving signs the money, not just the words.
          </p>
          {unconfirmed > 0 && (
            <p className="mb-3 rounded-md bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
              Confirm or correct the {unconfirmed} uncertain line{unconfirmed === 1 ? '' : 's'}{' '}
              first. Nobody can approve a plan with terms the model was unsure of.
            </p>
          )}
          {seen.changed && (
            <PlanChanged version={detail.version?.version ?? null} onReviewed={seen.acknowledge} />
          )}
          <textarea
            aria-label="Comment for the other parties"
            className="field mb-2 h-16 resize-none text-[13px]"
            placeholder="Comment for the other parties (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-primary flex-1 justify-center"
              disabled={busy !== null || !owner || seen.changed || unconfirmed > 0}
              onClick={() => void decide('approved')}
            >
              {busy === 'approved' && <Spinner className="size-3.5" />}
              Approve plan
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              disabled={busy !== null || !owner}
              onClick={() => void decide('changes_requested')}
            >
              Request changes
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PartyCard({
  party: p,
  ended,
  editable,
  onEdit,
}: {
  party: PartyView;
  ended: boolean;
  editable: boolean;
  onEdit: (body: { name: string; email: string | null }) => Promise<boolean>;
}) {
  const { toast } = useApp();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [email, setEmail] = useState(p.email ?? '');
  const a = p.approval;
  const portalUrl = p.portalUrl;
  const status = ended ? null : !p.mustApprove ? (
    <Pill tone="muted">No money lines</Pill>
  ) : hasApproved(p) ? (
    <Pill tone="seal">Approved</Pill>
  ) : a?.current && a.decision === 'changes_requested' ? (
    <Pill tone="red">Changes requested</Pill>
  ) : a && !a.current ? (
    <Pill tone="amber">Needs to re-approve</Pill>
  ) : (
    <Pill tone="muted">Waiting</Pill>
  );

  return (
    <div className="sheet px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium text-ink">
            {p.name}
            {p.isOwner && <span className="ml-1.5 text-[12px] font-normal text-seal">(you)</span>}
          </div>
          <div className="truncate text-[12.5px] text-ink-3">
            {p.role}
            {p.email ? `, ${p.email}` : ''}
          </div>
        </div>
        {status}
      </div>
      {editing ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const ok = await onEdit({ name: name.trim(), email: email.trim() || null });
            setBusy(false);
            if (ok) setEditing(false);
          }}
        >
          <label className="block">
            <span className="label">Name</span>
            <input
              className="field mt-1 h-8 py-0 text-[13px]"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="label">PayPal email</span>
            <input
              className="field mt-1 h-8 py-0 text-[13px]"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <p className="text-[12px] text-ink-3">
            Saving creates a new version; every party approves again.
          </p>
          <div className="flex gap-2">
            <button
              type="submit"
              className="btn btn-primary h-7 px-2.5 text-[12px]"
              disabled={busy || !name.trim()}
            >
              {busy && <Spinner className="size-3" />}
              Save details
            </button>
            <button
              type="button"
              className="btn btn-quiet h-7 px-2.5 text-[12px]"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        editable && (
          <button
            type="button"
            className="mt-1.5 text-[12px] font-medium text-seal hover:underline"
            onClick={() => {
              setName(p.name);
              setEmail(p.email ?? '');
              setEditing(true);
            }}
          >
            Edit details
          </button>
        )
      )}
      {a?.comment && (
        <p className="serif mt-2 border-l-2 border-rule pl-2.5 text-[13.5px] text-ink-2">
          {a.comment}
        </p>
      )}
      {!p.isOwner && p.mustApprove && !ended && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {portalUrl && (
            <button
              type="button"
              className="btn btn-quiet h-7 px-2.5 text-[12px]"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(portalUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                } catch {
                  // Clipboard access needs a secure, focused page; the link is still one click away.
                  toast({
                    tone: 'error',
                    title: 'Could not copy the link',
                    body: 'Use "Open their view" and copy the address from there.',
                  });
                }
              }}
            >
              {copied ? 'Link copied' : 'Copy approval link'}
            </button>
          )}
          {portalUrl && (
            <a
              className="btn btn-quiet h-7 px-2.5 text-[12px]"
              href={portalUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open their view
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function SetupSteps({ detail }: { detail: AgreementDetail }) {
  const plan = detail.version?.plan;
  if (detail.setup.length === 0) return null;
  return (
    <section>
      <h2 className="serif mb-1 text-[19px] font-medium">PayPal setup</h2>
      <p className="mb-3 text-[13px] text-ink-2">
        Payers approve each recurring or authorized payment on PayPal once. After that the plan runs
        without them.
      </p>
      <ul className="sheet divide-y divide-rule-2">
        {detail.setup.map((s) => (
          <li
            key={`${s.obligationKey}:${s.party}`}
            className="flex items-center justify-between gap-4 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="font-medium text-ink">{s.title}</div>
              <div className="text-[12.5px] text-ink-3">
                {plan ? partyName(plan, s.party) : s.party} approves on PayPal{' '}
                {PRODUCT_LABEL[s.product]}
              </div>
            </div>
            {s.status === 'done' ? (
              <Pill tone="seal">Approved on PayPal</Pill>
            ) : s.status === 'not_needed' ? (
              <Pill tone="muted">Not needed</Pill>
            ) : s.actionUrl ? (
              <a
                className="btn btn-paypal h-8 px-3 text-[12.5px]"
                href={s.actionUrl}
                target="_blank"
                rel="noreferrer"
              >
                Approve on PayPal
              </a>
            ) : (
              <Pill tone="paypal">Waiting on PayPal</Pill>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AmendmentDiff({ version, diff }: { version: VersionView; diff: DiffView }) {
  const plan = version.plan;
  return (
    <section className="rounded-[10px] border border-ink/15 bg-sheet">
      <div className="border-b border-rule-2 px-5 py-3">
        <h2 className="serif text-[19px] font-medium">What changes in version {version.version}</h2>
        <p className="text-[13px] text-ink-2">
          {diff.affectedParties.map((k) => partyName(plan, k)).join(', ')} must approve before it
          takes effect
          {version.effectiveFrom ? ` on ${day(version.effectiveFrom)}` : ''}.
        </p>
      </div>
      {version.evidence && (
        <blockquote className="serif mx-5 mt-4 border-l-2 border-paypal/50 pl-3 text-[15px] text-ink">
          “{version.evidence.quote}”
          <footer className="mt-1 font-sans text-[12px] text-ink-3">
            {version.evidence.from ?? 'Thread'}
            {version.evidence.date ? `, ${version.evidence.date}` : ''}
          </footer>
        </blockquote>
      )}
      <ul className="space-y-2 px-5 py-4 text-[13.5px]">
        {diff.added.map((o) => (
          <li key={`a-${o.key}`} className="flex gap-2">
            <span className="w-16 shrink-0 font-semibold text-seal">Added</span>
            <span>
              <span className="font-medium">{o.title}</span>
              {version.explanations[o.key] && (
                <span className="text-ink-2">: {version.explanations[o.key]}</span>
              )}
            </span>
          </li>
        ))}
        {diff.changed.map((c) =>
          c.changes.map((ch) => (
            <li key={`c-${c.key}-${ch.field}`} className="flex gap-2">
              <span className="w-16 shrink-0 font-semibold text-amber">Changed</span>
              <span>
                <span className="font-medium">{c.title}</span>, {termLabel(ch.field).toLowerCase()}:{' '}
                <span className="num text-ink-3 line-through">
                  {formatTerm(ch.field, ch.before, plan)}
                </span>{' '}
                <span className="num font-medium text-ink">
                  {formatTerm(ch.field, ch.after, plan)}
                </span>
              </span>
            </li>
          )),
        )}
        {diff.removed.map((o) => (
          <li key={`r-${o.key}`} className="flex gap-2">
            <span className="w-16 shrink-0 font-semibold text-red">Removed</span>
            <span className="font-medium">{o.title}</span>
          </li>
        ))}
        {diff.phases.map((p) => (
          <li key={`p-${p.key}`} className="flex gap-2">
            <span className="w-16 shrink-0 font-semibold text-amber">Phase</span>
            <span>
              {plan.phases.find((x) => x.key === p.key)?.name ?? p.key}:{' '}
              {p.changes
                .map(
                  (ch) =>
                    `${termLabel(ch.field).toLowerCase()} ${formatTerm(ch.field, ch.before, plan)} to ${formatTerm(ch.field, ch.after, plan)}`,
                )
                .join('; ')}
            </span>
          </li>
        ))}
        {diff.plan.map((ch) => (
          <li key={`pl-${ch.field}`} className="flex gap-2">
            <span className="w-16 shrink-0 font-semibold text-amber">Changed</span>
            <span>
              {termLabel(ch.field)}:{' '}
              <span className="text-ink-3 line-through">
                {formatTerm(ch.field, ch.before, plan)}
              </span>{' '}
              {formatTerm(ch.field, ch.after, plan)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Shown when a newer version arrived while the reader had the plan open. */
export function PlanChanged({
  version,
  onReviewed,
}: {
  version: number | null;
  onReviewed: () => void;
}) {
  return (
    <div
      role="status"
      className="mb-3 rounded-md border border-amber/30 bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber"
    >
      <p>
        The plan changed while you had it open. Review version {version ?? 'the new version'} before
        approving: your approval signs exactly what is shown.
      </p>
      <button
        type="button"
        className="mt-1.5 font-semibold underline underline-offset-2"
        onClick={onReviewed}
      >
        I have reviewed version {version}
      </button>
    </div>
  );
}
