'use client';

import type { ChargeView, PortalView } from '@clausework/core';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ObligationCard } from '@/components/agreement/obligation-card';
import { PlanChanged } from '@/components/agreement/plan-view';
import { useApp } from '@/components/app-context';
import { Wordmark } from '@/components/shell';
import {
  ChargeAmount,
  ChargeStatusPill,
  ErrorNote,
  Money,
  Pill,
  Skeleton,
  Spinner,
} from '@/components/ui';
import { api } from '@/lib/api';
import {
  addDays,
  day,
  isAwaitingPayment,
  PRODUCT_LABEL,
  STAGE_LABEL,
  stamp,
  tidyLabel,
  uniqueRefs,
} from '@/lib/format';
import { hasApproved } from '@/lib/plan';
import { PORTAL_TOKEN_KEY } from '@/lib/portal';
import { useResource } from '@/lib/use-resource';
import { useSeenVersion } from '@/lib/use-seen-version';

export default function PortalPage() {
  const { token } = useParams<{ token: string }>();
  const res = useResource(
    () => api.portal(token),
    [token],
    // Faster while this party still has a PayPal step open, so approving it shows up promptly.
    (d) => (d?.setup.some((s) => s.status === 'waiting') ? 3000 : 15_000),
    token,
  );
  const p = res.data;
  useEffect(() => {
    if (p) sessionStorage.setItem(PORTAL_TOKEN_KEY, token);
  }, [p, token]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-rule bg-[#ebe9e2]">
        <div className="mx-auto flex h-14 max-w-[1080px] items-center justify-between px-6">
          <Wordmark className="text-[19px]" />
          {p && (
            <span className="text-[13px] text-ink-2">
              Signed in by link as <span className="font-medium text-ink">{p.party.name}</span>
            </span>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-[1080px] px-6 pt-8 pb-16">
        {res.error && !p ? (
          res.error.status === 404 ? (
            <div className="sheet mx-auto mt-6 max-w-[520px] px-8 py-10 text-center">
              <p className="serif text-[24px] text-ink">This link does not work</p>
              <p className="mt-2 text-ink-2">
                It may be mistyped or replaced by a newer one. Ask whoever sent it for a new link.
              </p>
            </div>
          ) : (
            <ErrorNote message={res.error.message} onRetry={() => void res.reload()} />
          )
        ) : !p ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-[460px]" />
            <Skeleton className="h-[420px]" />
          </div>
        ) : (
          <Portal portal={p} token={token} onChange={res.set} onStale={() => void res.reload()} />
        )}
      </main>
    </div>
  );
}

function Portal({
  portal: p,
  token,
  onChange,
  onStale,
}: {
  portal: PortalView;
  token: string;
  onChange: (p: PortalView) => void;
  onStale: () => void;
}) {
  const v = p.version;
  const mine = v?.plan.obligations.filter((o) => p.obligationKeys.includes(o.key)) ?? [];
  const myTests = v?.tests.filter((t) => p.obligationKeys.includes(t.obligation)) ?? [];
  const passing = myTests.filter((t) => t.pass).length;
  const currency = v?.plan.currency ?? 'USD';
  const mySetup = p.setup.filter((s) => s.party === p.party.key);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[13px] text-ink-2">
            {p.owner
              ? `${p.owner.name} shared this money plan with you`
              : 'A money plan shared with you'}
          </p>
          <h1 className="serif mt-1 text-[30px] leading-tight font-medium">{p.title}</h1>
          <p className="mt-1 text-[13.5px] text-ink-2">
            You are {p.party.name}
            {p.party.role && p.party.role !== p.party.name ? ` (${p.party.role})` : ''} under this
            agreement.
          </p>
        </div>
        <Pill tone="ink">
          {p.live && p.stage === 'awaiting_approvals'
            ? 'Live, amendment pending'
            : STAGE_LABEL[p.stage]}
        </Pill>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="serif text-[19px] font-medium">Your lines of the plan</h2>
            {myTests.length > 0 && (
              <span
                className={`text-[13px] ${passing === myTests.length ? 'text-seal' : 'text-red'}`}
              >
                {passing} of {myTests.length} tests written from the clauses pass
              </span>
            )}
          </div>
          <p className="text-[13px] text-ink-2">
            Each line was compiled from a clause of the agreement and is quoted here. You approve
            only the lines that involve you.
          </p>
          {v && mine.length > 0 ? (
            mine.map((o) => <ObligationCard key={o.key} obligation={o} version={v} />)
          ) : (
            <p className="text-ink-2">No payments involve you under this version.</p>
          )}
          {v?.diff && !v.diff.empty && (
            <p className="rounded-md bg-amber-soft px-3 py-2 text-[13px] text-amber">
              This is version {v.version}, an amendment
              {v.effectiveFrom ? ` that applies from ${day(v.effectiveFrom)}` : ''}. Your earlier
              approval does not carry over.
            </p>
          )}
        </div>

        <aside className="space-y-5">
          <Decision portal={p} token={token} onChange={onChange} onStale={onStale} />

          {mySetup.length > 0 && (
            <section>
              <h2 className="serif mb-2 text-[17px] font-medium">Set up payments</h2>
              <p className="mb-3 text-[12.5px] text-ink-2">
                Approve each one on PayPal once. After that, the plan runs without you.
              </p>
              <ul className="space-y-2">
                {mySetup.map((s) => (
                  <li
                    key={s.obligationKey}
                    className="sheet flex items-center justify-between gap-3 px-3.5 py-3"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{s.title}</span>
                      <span className="block text-[12px] text-ink-3">
                        PayPal {PRODUCT_LABEL[s.product]}
                      </span>
                    </span>
                    {s.status === 'done' ? (
                      <Pill tone="seal">Done</Pill>
                    ) : s.actionUrl ? (
                      <a className="btn btn-paypal h-8 px-3 text-[12.5px]" href={s.actionUrl}>
                        Approve on PayPal
                      </a>
                    ) : (
                      <Pill tone="muted">Not ready</Pill>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {p.statements.length > 0 && (
            <section>
              <h2 className="serif mb-2 text-[17px] font-medium">Your statements</h2>
              <ul className="sheet divide-y divide-rule-2">
                {p.statements.map((s) => (
                  <li key={s.chargeId} className="px-3.5 py-2.5 text-[13px]">
                    <div className="flex items-baseline justify-between gap-2">
                      <Money
                        value={s.amount}
                        currency={currency}
                        className="font-semibold text-ink"
                      />
                      <ChargeStatusPill
                        charge={{
                          status: s.status,
                          problem: p.charges.find((c) => c.id === s.chargeId)?.problem,
                        }}
                        inline
                      />
                    </div>
                    <div className="mt-0.5 text-ink-2">{s.line}</div>
                    {s.date && <div className="num text-[12px] text-ink-3">{day(s.date)}</div>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>

      {p.charges.length > 0 && <Charges portal={p} />}
    </>
  );
}

/** Under its group's heading a charge needs only what sets it apart: "Dec 2026", not the title again. */
function rowLabel(c: ChargeView, title: string | undefined): string {
  const label = tidyLabel(c.label);
  return title && label.startsWith(`${title} · `) ? label.slice(title.length + 3) : label;
}

/** How far ahead the charges list looks before "Show all". */
const AHEAD_DAYS = 92;

/**
 * This party's charges, one group per line of the plan. A long plan has dozens of monthly rows,
 * so each group shows what is open or due in the next three months, and the rest on request.
 */
function Charges({ portal: p }: { portal: PortalView }) {
  const [all, setAll] = useState(false);
  const today = p.today;
  const horizon = addDays(today, AHEAD_DAYS);
  const titles = new Map(p.version?.plan.obligations.map((o) => [o.key, o.title]));
  const open = (c: ChargeView) =>
    c.status !== 'cancelled' &&
    (c.problem !== null ||
      isAwaitingPayment(c) ||
      (c.dueDate !== null && c.dueDate <= horizon && c.dueDate >= today) ||
      (c.paidOn !== null && c.paidOn >= addDays(today, -31)));
  const visible = p.charges.filter((c) => c.status !== 'cancelled');
  const shown = all ? visible : visible.filter(open);
  const hidden = visible.length - shown.length;
  const groups = new Map<string, ChargeView[]>();
  for (const c of shown) groups.set(c.obligationKey, [...(groups.get(c.obligationKey) ?? []), c]);

  return (
    <section className="mt-10">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="serif text-[19px] font-medium">Your charges</h2>
        <span className="text-[13px] text-ink-2">
          {all
            ? `All ${visible.length} charges`
            : 'Open now, paid in the last month, or due in the next three months'}
          {(hidden > 0 || all) && (
            <button
              type="button"
              className="ml-3 font-medium text-seal hover:underline"
              onClick={() => setAll((v) => !v)}
            >
              {all ? 'Show what is next' : `Show all ${visible.length}`}
            </button>
          )}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="sheet px-4 py-3 text-[13px] text-ink-2">
          Nothing is due in the next three months.
        </p>
      ) : (
        <div className="sheet overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-rule-2 text-left text-[12px] text-ink-3">
                <th className="px-4 py-2.5 font-normal">Charge</th>
                <th className="px-4 py-2.5 font-normal">Due</th>
                <th className="px-4 py-2.5 text-right font-normal">Amount</th>
                <th className="px-4 py-2.5 font-normal">Status</th>
                <th className="px-4 py-2.5 font-normal">Clause</th>
                <th className="px-4 py-2.5">
                  <span className="sr-only">Pay</span>
                </th>
              </tr>
            </thead>
            {[...groups].map(([key, charges]) => (
              <tbody key={key}>
                <tr className="border-b border-rule-2 bg-[#faf9f6]">
                  <th
                    colSpan={6}
                    className="px-4 py-2 text-left text-[12.5px] font-medium text-ink"
                  >
                    {titles.get(key) ?? tidyLabel(charges[0]?.label ?? '')}
                    <span className="ml-2 font-normal text-ink-3">
                      {charges.length} charge{charges.length === 1 ? '' : 's'}
                    </span>
                  </th>
                </tr>
                {charges.map((c) => (
                  <tr key={c.id} className="border-b border-rule-2 align-top last:border-0">
                    <td className="px-4 py-2.5 text-ink">{rowLabel(c, titles.get(key))}</td>
                    <td className="num px-4 py-2.5 whitespace-nowrap text-ink-2">
                      {day(c.dueDate)}
                      {c.paidOn && (
                        <span className="block text-[12px] text-ink-3">Paid {day(c.paidOn)}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-ink">
                      <ChargeAmount charge={c} className="items-end" />
                    </td>
                    <td className="px-4 py-2.5">
                      <ChargeStatusPill charge={c} inline />
                    </td>
                    <td className="px-4 py-2.5 text-ink-2">
                      {uniqueRefs(c.clauseRefs).join(', ')}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {c.payUrl &&
                        c.payer === p.party.key &&
                        (c.status === 'issued' || c.status === 'overdue') && (
                          <a className="btn btn-paypal h-7 px-2.5 text-[12px]" href={c.payUrl}>
                            Pay with PayPal
                          </a>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </section>
  );
}

function Decision({
  portal: p,
  token,
  onChange,
  onStale,
}: {
  portal: PortalView;
  token: string;
  onChange: (p: PortalView) => void;
  onStale: () => void;
}) {
  const { run, toast } = useApp();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const a = p.party.approval;
  const seen = useSeenVersion(p.version?.hash);
  // Whether this party pays under any line; one that is only paid reads about being paid.
  const pays =
    p.version?.plan.obligations.some(
      (o) => p.obligationKeys.includes(o.key) && o.payer === p.party.key,
    ) ?? false;

  if (!p.party.mustApprove) {
    return (
      <p className="text-[13px] text-ink-2">
        No payment in this plan involves you, so nothing needs your approval.
      </p>
    );
  }
  if (a && hasApproved(p.party)) {
    return (
      <div className="rounded-[10px] border border-seal/30 bg-seal-soft px-4 py-3.5">
        <div className="serif text-[17px] text-seal-deep">
          You approved version {p.version?.version}
        </div>
        <p className="mt-1 text-[13px] text-seal-deep/80">
          Recorded {stamp(a.at)}. If anything changes, you will be asked again.
        </p>
      </div>
    );
  }

  const decide = async (decision: 'approved' | 'changes_requested') => {
    setBusy(decision);
    const next = await run(
      () =>
        api.portalDecide(token, {
          decision,
          comment: comment.trim() || undefined,
          planHash: p.version?.hash,
        }),
      'Your decision was not recorded',
      (e) => e.status === 409 && onStale(),
    );
    setBusy(null);
    if (next) {
      onChange(next);
      setComment('');
      toast({ tone: 'success', title: decision === 'approved' ? 'Approved' : 'Changes requested' });
    }
  };

  return (
    <div className="sheet px-4 py-4">
      <div className="serif text-[17px] text-ink">Your decision</div>
      {a?.current && a.decision === 'changes_requested' && (
        <p className="mt-1 text-[12.5px] text-red">
          You asked for changes. You can approve once they are made.
        </p>
      )}
      <p className="mt-1 mb-3 text-[13px] text-ink-2">
        Approving signs the money, not just the words.{' '}
        {pays
          ? 'Nothing is charged until every party approves.'
          : 'You are confirming what you will be paid and when. Payments to you start once every party approves.'}
      </p>
      {seen.changed && (
        <PlanChanged version={p.version?.version ?? null} onReviewed={seen.acknowledge} />
      )}
      <textarea
        aria-label="Comment for the other parties"
        className="field mb-2 h-16 resize-none text-[13px]"
        placeholder="Comment (optional)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="flex gap-2">
        <button
          type="button"
          className="btn btn-primary flex-1 justify-center"
          disabled={busy !== null || seen.changed}
          onClick={() => void decide('approved')}
        >
          {busy === 'approved' && <Spinner className="size-3.5" />}
          Approve my lines
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          disabled={busy !== null}
          onClick={() => void decide('changes_requested')}
        >
          Request changes
        </button>
      </div>
    </div>
  );
}
