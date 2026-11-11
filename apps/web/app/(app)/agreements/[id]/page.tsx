'use client';

import type { AgreementDetail, Stage } from '@clausework/core';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ActivityView } from '@/components/agreement/activity-view';
import { AmendmentsView } from '@/components/agreement/amendments-view';
import { ContractView } from '@/components/agreement/contract-view';
import { LedgerView } from '@/components/agreement/ledger-view';
import { PlanView } from '@/components/agreement/plan-view';
import { TimelineView } from '@/components/agreement/timeline-view';
import { useApp } from '@/components/app-context';
import { TabPanel, Tabs } from '@/components/tabs';
import { ErrorNote, Money, Pill, Skeleton, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { atRisk, day, stageOf, todayIso } from '@/lib/format';
import { hasApproved } from '@/lib/plan';
import { useResource } from '@/lib/use-resource';
import { markSeen } from '@/lib/use-seen-version';

const TABS = [
  ['contract', 'Contract'],
  ['plan', 'Money plan and approvals'],
  ['timeline', 'Timeline'],
  ['ledger', 'Ledger'],
  ['activity', 'Activity'],
  ['amend', 'Amendments'],
] as const;
type Tab = (typeof TABS)[number][0];

const STEPS = ['Read', 'Compile', 'Review', 'Approve', 'Go live', 'Running'] as const;
const STEP_OF: Record<Stage, number> = {
  reading: 0,
  compiling: 1,
  failed: 1,
  needs_owner: 2,
  needs_review: 2,
  awaiting_approvals: 3,
  ready_to_activate: 4,
  awaiting_payer_setup: 4,
  live: 5,
  completed: 6,
};

export default function AgreementPage() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { meta } = useApp();
  const tab = (TABS.find(([k]) => k === search.get('tab'))?.[0] ?? 'contract') as Tab;
  const setTab = (t: Tab) => router.replace(`/agreements/${id}?tab=${t}`, { scroll: false });

  const res = useResource(
    () => api.agreement(id),
    [id],
    // Fast while clauses arrive, and while a payer is approving on PayPal in another tab;
    // otherwise the detail changes mostly through this page's own actions, which set it directly.
    (d) =>
      !d
        ? 30_000
        : d.agreement.stage === 'reading' || d.agreement.stage === 'compiling'
          ? 1500
          : d.setup.some((s) => s.status === 'waiting')
            ? 3000
            : 30_000,
    id,
  );
  const detail = res.data;
  // A detail returned by this page's own action: its version is one the owner just made, so it is
  // not a change behind their back.
  const onChange = (d: AgreementDetail) => {
    markSeen(d.version?.hash);
    res.set(d);
  };

  if (res.error && !detail) {
    if (res.error.status === 404) {
      return (
        <div className="sheet mx-auto mt-10 max-w-[520px] px-8 py-10 text-center">
          <p className="serif text-[24px] text-ink">Agreement not found</p>
          <p className="mt-2 text-ink-2">
            There is no agreement at this address. It may have been a mistyped or old link.
          </p>
          <Link href="/" className="btn btn-primary mt-6">
            Back to agreements
          </Link>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <Link href="/" className="text-[13px] text-ink-2 hover:text-ink">
          All agreements
        </Link>
        <ErrorNote message={res.error.message} onRetry={() => void res.reload()} />
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-[420px]" />
        <Skeleton className="h-6 w-[620px]" />
        <Skeleton className="mt-6 h-[480px]" />
      </div>
    );
  }

  const a = detail.agreement;
  // An amendment under review: the live plan keeps running while its next version waits.
  const pendingVersion =
    a.activatedAt &&
    detail.liveVersionId &&
    detail.version &&
    detail.version.id !== detail.liveVersionId
      ? detail.version.version
      : null;
  const chip = stageOf(a, { unconfirmed: detail.version?.unconfirmed.length, pendingVersion });
  return (
    <>
      <div className="mb-2 text-[13px]">
        <Link href="/" className="text-ink-2 hover:text-ink">
          All agreements
        </Link>
      </div>
      <header className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="serif text-[30px] leading-tight font-medium tracking-[-0.01em]">
              {a.title}
            </h1>
            <p className="mt-1 text-[13.5px] text-ink-2">
              {a.counterparties.length > 0 && <>With {a.counterparties.join(', ')}. </>}
              {detail.version?.plan.effectiveDate && (
                <>Effective {day(detail.version.plan.effectiveDate)}. </>
              )}
              {detail.version?.plan.contractValue && (
                <>
                  Contract value{' '}
                  <Money value={detail.version.plan.contractValue} currency={a.currency} />.
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Pill tone={chip.tone}>{chip.label}</Pill>
            <PrimaryAction detail={detail} onChange={onChange} goTo={setTab} />
          </div>
        </div>
        <Stepper stage={a.stage} live={a.activatedAt !== null} pending={pendingVersion} />
        {/* Your side is fixed once anyone has approved: their approval is of the plan as you framed it. */}
        {a.stage === 'needs_owner' && !detail.parties.some((p) => p.approval) && (
          <ChooseSide detail={detail} onChange={onChange} />
        )}
        {a.stage === 'failed' && (
          <div className="mt-4">
            <ErrorNote message={a.failure ?? 'The agreement could not be compiled.'} />
          </div>
        )}
      </header>

      <Tabs
        id="agreement"
        label="Agreement views"
        tabs={TABS}
        value={tab}
        onChange={setTab}
        className="mb-6"
        marks={{
          ledger: detail.charges.some(atRisk) ? (
            <span
              className="ml-1.5 inline-block size-1.5 rounded-full bg-red align-middle"
              title="Has charges at risk: overdue or refused by PayPal"
            />
          ) : null,
        }}
      />

      <TabPanel id="agreement" tab={tab}>
        {tab === 'contract' && <ContractView detail={detail} onChange={onChange} />}
        {tab === 'plan' && (
          <PlanView detail={detail} onChange={onChange} onStale={() => void res.reload()} />
        )}
        {tab === 'timeline' && (
          <TimelineView detail={detail} today={meta?.today ?? todayIso()} onChange={onChange} />
        )}
        {tab === 'ledger' && <LedgerView detail={detail} onChange={onChange} />}
        {tab === 'activity' && <ActivityView detail={detail} />}
        {tab === 'amend' && (
          <AmendmentsView detail={detail} onChange={onChange} onDrafted={() => setTab('plan')} />
        )}
      </TabPanel>
    </>
  );
}

function Stepper({
  stage,
  live,
  pending,
}: {
  stage: Stage;
  live: boolean;
  pending: number | null;
}) {
  // Once a plan has run on PayPal it stays at Running; an amendment is shown as a marker on it.
  const at = live && stage !== 'completed' ? 5 : STEP_OF[stage];
  return (
    <ol className="mt-5 grid grid-cols-6 gap-1.5" aria-label="Progress">
      {STEPS.map((s, i) => {
        const done = i < at;
        const current = i === at;
        return (
          <li key={s} aria-current={current ? 'step' : undefined}>
            <div
              className={`h-1 rounded-full ${
                done ? 'bg-seal' : current ? (stage === 'failed' ? 'bg-red' : 'bg-ink') : 'bg-rule'
              }`}
            />
            <div
              className={`mt-1.5 text-[12px] ${current ? 'font-semibold text-ink' : done ? 'text-seal' : 'text-ink-3'}`}
            >
              {s}
              {current && i === 5 && pending !== null && (
                <span className="ml-1.5 font-normal text-amber">v{pending} awaiting approval</span>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function PrimaryAction({
  detail,
  onChange,
  goTo,
}: {
  detail: AgreementDetail;
  onChange: (d: AgreementDetail) => void;
  goTo: (t: Tab) => void;
}) {
  const { run, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const id = detail.agreement.id;
  switch (detail.agreement.stage) {
    case 'reading':
    case 'compiling':
      return (
        <span className="inline-flex items-center gap-2 text-[13px] text-ink-2">
          <Spinner className="size-3.5" />
          {detail.progress?.step ?? 'Working'}
        </span>
      );
    case 'failed':
      return (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const d = await run(() => api.recompile(id), 'Could not recompile');
            setBusy(false);
            if (d) onChange(d);
          }}
        >
          {busy && <Spinner className="size-3.5" />}
          Recompile
        </button>
      );
    case 'needs_review':
    case 'awaiting_approvals': {
      const n = detail.version?.unconfirmed.length ?? 0;
      if (n > 0) {
        return (
          <button type="button" className="btn btn-primary" onClick={() => goTo('plan')}>
            Confirm {n} uncertain term{n === 1 ? '' : 's'}
          </button>
        );
      }
      const owner = detail.parties.find((p) => p.isOwner);
      if (owner && hasApproved(owner)) {
        // The owner's part is done; what is left is getting the others to sign.
        const waiting = detail.parties.filter(
          (p) => p.mustApprove && !p.isOwner && !hasApproved(p),
        ).length;
        return (
          <button type="button" className="btn btn-quiet" onClick={() => goTo('plan')}>
            {waiting > 0 ? 'Share approval links' : 'See approvals'}
          </button>
        );
      }
      return (
        <button type="button" className="btn btn-primary" onClick={() => goTo('plan')}>
          Review and approve
        </button>
      );
    }
    case 'ready_to_activate':
      return (
        <button
          type="button"
          className="btn btn-paypal"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const d = await run(() => api.activate(id), 'Could not go live');
            setBusy(false);
            if (d) {
              onChange(d);
              toast({
                tone: 'success',
                title: 'Live on PayPal',
                body: 'Payers now approve their PayPal payments.',
              });
              goTo('plan');
            }
          }}
        >
          {busy && <Spinner className="size-3.5" />}
          Go live on PayPal
        </button>
      );
    case 'awaiting_payer_setup':
      return (
        <button type="button" className="btn btn-paypal" onClick={() => goTo('plan')}>
          Finish PayPal setup
        </button>
      );
    case 'live':
      return (
        <button type="button" className="btn btn-quiet" onClick={() => goTo('timeline')}>
          Open the timeline
        </button>
      );
    case 'completed':
      return (
        <Link href={`/audit?agreement=${encodeURIComponent(id)}`} className="btn btn-primary">
          Audit what was paid
        </Link>
      );
    default:
      return null;
  }
}

function ChooseSide({
  detail,
  onChange,
}: {
  detail: AgreementDetail;
  onChange: (d: AgreementDetail) => void;
}) {
  const { run } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="mt-5 rounded-[10px] border border-amber/30 bg-amber-soft px-5 py-4">
      <div className="serif text-[17px] text-ink">Which party are you?</div>
      <p className="mt-0.5 mb-3 text-[13px] text-ink-2">
        Clausework shows money in and out from your side, and sends the others their own approval
        links.
      </p>
      <div className="flex flex-wrap gap-2">
        {detail.parties.map((p) => (
          <button
            key={p.key}
            type="button"
            className="btn btn-quiet"
            disabled={busy !== null}
            onClick={async () => {
              setBusy(p.key);
              const d = await run(
                () => api.setOwner(detail.agreement.id, p.key),
                'Could not set your side',
              );
              setBusy(null);
              if (d) onChange(d);
            }}
          >
            {busy === p.key && <Spinner className="size-3.5" />}
            {p.name}
            <span className="text-ink-3">{p.role}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
