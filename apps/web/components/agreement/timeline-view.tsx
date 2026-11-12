'use client';

import type { AgreementDetail, ChargeStatus, ChargeView, PhaseView } from '@clausework/core';
import dynamic from 'next/dynamic';
import { useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import {
  addDays,
  chargeStatus,
  day,
  daysBetween,
  isLive,
  money,
  refused,
  retainageNote,
  STATUS_LABEL,
  tidyLabel,
} from '@/lib/format';
import { actionTitle, clauseById, humanText, keyNames } from '@/lib/plan';
import { useApp } from '../app-context';
import { Pill, Skeleton, Spinner } from '../ui';
import type { GanttDependency, GanttTask } from './gantt';

const Gantt = dynamic(() => import('./gantt'), {
  ssr: false,
  loading: () => <Skeleton className="h-full w-full" />,
});

/** Calendar days as local-midnight Dates, so Bryntum shows the same day the API sent. */
const toDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};
const fromDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const STATUS_COLOR: Record<ChargeStatus, string> = {
  scheduled: '#9aa1b0',
  awaiting_approval: '#0070e0',
  issued: '#16213a',
  authorized: '#0070e0',
  paid: '#0d6b57',
  overdue: '#b4232a',
  failed: '#b4232a',
  cancelled: '#c3c7cf',
  held: '#8f5a00',
  released: '#0d6b57',
  refunded: '#8f5a00',
  unclaimed: '#8f5a00',
};

/** A charge as the timeline needs it: real, or projected from the plan before it goes live. */
interface Dated {
  id: string;
  obligationKey: string;
  kind: ChargeView['kind'];
  label: string;
  /** Net of any retainage withheld. */
  amount: string | null;
  grossAmount?: string | null;
  currency?: string;
  status: ChargeStatus;
  problem?: string | null;
  /** Where the marker sits: the day it was paid once it is paid, otherwise the day it is due. */
  dueDate: string;
  /** The contractual due date, kept for the tooltip when the marker sits on the paid day. */
  due?: string | null;
  paidOn?: string | null;
  planned?: boolean;
}

const PAID = new Set<ChargeStatus>(['paid', 'released']);

/** A delivered phase is drawn where it actually ran: it ends on the day it was delivered. */
function drawnDates(p: PhaseView): { start: string | null; end: string | null } {
  const { start, end, completedOn } = p.current;
  if (!completedOn) return { start, end };
  return { start: start && start < completedOn ? start : completedOn, end: completedOn };
}

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
const SHORT: Partial<Record<ChargeView['kind'], string>> = {
  usage: 'Usage',
  late_fee: 'Late fee',
  revenue_share: 'Share payout',
  split: 'Split',
  service_credit: 'Credit',
};

/** "Late fee · Feb", "Retainer · Mar": short and distinct, since a row has little room. */
function rowLabel(c: Dated, title: string): string {
  if (
    c.kind === 'deposit' ||
    c.kind === 'milestone' ||
    c.kind === 'retainage' ||
    c.kind === 'prepaid'
  ) {
    return title;
  }
  const word =
    SHORT[c.kind] ??
    (() => {
      const last = title.split(/\s+/).pop() ?? 'Fee';
      return last.length <= 12 ? last.charAt(0).toUpperCase() + last.slice(1) : 'Fee';
    })();
  return `${word} · ${MONTH.format(new Date(`${c.dueDate}T00:00:00Z`))}`;
}

/**
 * Before go-live there are no charges yet; the plan's fixed payments are placed where its dates
 * put them, so both sides can see the schedule they are approving.
 */
function planned(detail: AgreementDetail): Dated[] {
  const plan = detail.version?.plan;
  if (!plan) return [];
  const phaseEnd = new Map(detail.phases.map((p) => [p.key, p.current.end]));
  const phaseStart = new Map(detail.phases.map((p) => [p.key, p.current.start]));
  const at = (ref: unknown): string | null => {
    const r = ref as { kind?: string; date?: string; phase?: string; offsetDays?: number } | null;
    if (!r) return null;
    const off = r.offsetDays ?? 0;
    if (r.kind === 'date') return r.date ?? null;
    if (r.kind === 'effective') return plan.effectiveDate ? addDays(plan.effectiveDate, off) : null;
    const base =
      r.kind === 'phase_start' ? phaseStart.get(r.phase ?? '') : phaseEnd.get(r.phase ?? '');
    return base ? addDays(base, off) : null;
  };
  const amountOf = (a: unknown): string | null => {
    const v = a as { kind?: string; amount?: string; bps?: number } | string | null;
    if (typeof v === 'string') return v;
    if (v?.kind === 'fixed') return v.amount ?? null;
    if (v?.kind === 'percent_of_contract' && plan.contractValue && v.bps !== undefined) {
      return ((BigInt(plan.contractValue) * BigInt(v.bps)) / 10_000n).toString();
    }
    return null;
  };
  const out: Dated[] = [];
  for (const o of plan.obligations) {
    const base = {
      obligationKey: o.key,
      kind: o.kind,
      status: 'scheduled' as const,
      planned: true,
    };
    if (o.kind === 'deposit' || o.kind === 'milestone') {
      const due = at(o.due);
      if (due)
        out.push({
          ...base,
          id: `plan:${o.key}`,
          label: o.title,
          amount: amountOf(o.amount),
          dueDate: due,
        });
    } else if (o.kind === 'recurring') {
      const start = at(o.start);
      if (!start) continue;
      const months = { week: 0, month: 1, quarter: 3, year: 12 }[String(o.interval)] ?? 1;
      if (months === 0) continue;
      const cycles = Math.min(Number(o.cycles ?? 24), 24);
      for (let i = 0; i < cycles; i++) {
        const d = new Date(`${start}T00:00:00Z`);
        d.setUTCMonth(d.getUTCMonth() + i * months);
        const due = d.toISOString().slice(0, 10);
        if (plan.endDate && due > plan.endDate) break;
        out.push({
          ...base,
          id: `plan:${o.key}:${i}`,
          label: o.title,
          amount: amountOf(o.amount),
          dueDate: due,
        });
      }
    }
  }
  return out;
}

/** Periodic obligations get one collapsed row with their payments rolled up onto it. */
const MAX_OWN_ROWS = 3;

function build(detail: AgreementDetail) {
  const tasks: GanttTask[] = [];
  const deps: GanttDependency[] = [];
  const labels: Record<string, string> = {};
  const tips: Record<string, string[]> = {};
  const currency = detail.agreement.currency ?? 'USD';
  const plan = detail.version?.plan;
  let min: string | null = null;
  let max: string | null = null;
  const see = (d: string | null) => {
    if (!d) return;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  };

  const phaseTasks: GanttTask[] = detail.phases.flatMap((p) => {
    const { start, end } = drawnDates(p);
    if (!start || !end) return [];
    see(start);
    see(end);
    tips[`phase:${p.key}`] = [
      p.name,
      p.current.completedOn
        ? `Delivered ${day(p.current.completedOn)}`
        : `${day(start)} to ${day(end)}`,
      ...(p.blockedBy ? [`Waiting on ${tidyLabel(p.blockedBy.label)}`] : []),
    ];
    const cls = p.current.completedOn
      ? 'cw-phase cw-phase-done'
      : p.blockedBy
        ? 'cw-phase cw-phase-blocked'
        : 'cw-phase';
    return [
      {
        id: `phase:${p.key}`,
        name: p.name,
        startDate: toDate(start),
        // Bryntum ends a bar at the start of its end date; the API's end day is inclusive.
        endDate: toDate(addDays(end, 1)),
        manuallyScheduled: true as const,
        cls,
        // A delivered phase is history; moving it would rewrite what already happened. It stays
        // draggable so the attempt can explain why it is locked (see the Gantt's onLocked).
        resizable: !p.current.completedOn,
      },
    ];
  });
  const firstPhase = phaseTasks[0];
  if (firstPhase) {
    tasks.push({
      id: 'delivery',
      name: 'Delivery',
      startDate: firstPhase.startDate,
      manuallyScheduled: true,
      expanded: true,
      draggable: false,
      resizable: false,
      children: phaseTasks,
    });
  }

  const dated: Dated[] =
    detail.charges.length > 0
      ? detail.charges.flatMap((c) => {
          // A payment that has landed is drawn on the day it landed, so lateness shows.
          const at = PAID.has(c.status) && c.paidOn ? c.paidOn : c.dueDate;
          return at ? [{ ...c, label: tidyLabel(c.label), dueDate: at, due: c.dueDate }] : [];
        })
      : planned(detail);
  const byObligation = new Map<string, Dated[]>();
  for (const c of dated)
    byObligation.set(c.obligationKey, [...(byObligation.get(c.obligationKey) ?? []), c]);

  const milestone = (c: Dated, rollup: boolean): GanttTask => {
    see(c.dueDate);
    const state = chargeStatus(c);
    const amount = c.amount ? money(c.amount, currency) : 'Variable';
    labels[`charge:${c.id}`] = `${amount}  ${c.planned ? 'Planned' : state.label}`;
    const title = plan?.obligations.find((o) => o.key === c.obligationKey)?.title ?? c.label;
    const held = retainageNote({ ...c, currency: c.currency ?? currency });
    tips[`charge:${c.id}`] = [
      c.label,
      `${amount}${held ? ` (${held})` : ''}`,
      c.planned ? 'Planned from the plan’s dates' : state.label,
      ...(state.reason ? [`PayPal: ${state.reason}`] : []),
      ...(c.paidOn && PAID.has(c.status)
        ? [`Paid ${day(c.paidOn)}${c.due && c.due !== c.paidOn ? `, due ${day(c.due)}` : ''}`]
        : [`Due ${day(c.dueDate)}`]),
    ];
    const tone = refused(c) ? 'failed' : c.status;
    return {
      id: `charge:${c.id}`,
      name: rowLabel(c, title),
      cls: `cw-st-${tone}`,
      startDate: toDate(c.dueDate),
      duration: 0,
      manuallyScheduled: true,
      draggable: false,
      resizable: false,
      rollup,
      eventColor: STATUS_COLOR[tone],
    };
  };

  const paymentRows: GanttTask[] = [];
  for (const [key, charges] of byObligation) {
    const title = plan?.obligations.find((o) => o.key === key)?.title ?? key;
    const first = charges[0];
    if (!first) continue;
    if (charges.length <= MAX_OWN_ROWS) {
      for (const c of charges) paymentRows.push(milestone(c, false));
    } else {
      paymentRows.push({
        id: `group:${key}`,
        name: `${title} (${charges.length} payments)`,
        startDate: toDate(first.dueDate),
        manuallyScheduled: true,
        expanded: false,
        draggable: false,
        resizable: false,
        children: charges.map((c) => milestone(c, true)),
      });
    }
  }
  const firstPayment = paymentRows[0];
  if (firstPayment) {
    tasks.push({
      id: 'payments',
      name: 'Payments on PayPal',
      startDate: firstPayment.startDate,
      manuallyScheduled: true,
      expanded: true,
      draggable: false,
      resizable: false,
      children: paymentRows,
    });
  }

  // Each phase hands off to the payment its delivery triggers; a gating payment holds the next
  // phase until PayPal confirms it. Red when the payment is holding the phase now.
  const chargeIds = new Set(dated.map((c) => `charge:${c.id}`));
  for (const p of detail.phases) {
    if (!p.current.start) continue;
    for (const o of plan?.obligations ?? []) {
      if (
        o.kind === 'milestone' &&
        (o.phase === p.key || (o.due as { phase?: string } | undefined)?.phase === p.key)
      ) {
        for (const c of byObligation.get(o.key) ?? []) {
          if (!chargeIds.has(`charge:${c.id}`)) continue;
          deps.push({
            id: `d:${p.key}:${c.id}`,
            fromTask: `phase:${p.key}`,
            toTask: `charge:${c.id}`,
            type: 2,
          });
        }
      }
    }
    if (p.gatedBy) {
      const gates = byObligation.get(p.gatedBy) ?? [];
      const gate = p.blockedBy
        ? (gates.find((c) => c.id === p.blockedBy?.chargeId) ?? gates[0])
        : gates[0];
      if (gate) {
        deps.push({
          id: `g:${gate.id}:${p.key}`,
          fromTask: `charge:${gate.id}`,
          toTask: `phase:${p.key}`,
          type: 2,
          cls: p.blockedBy ? 'cw-gate cw-gate-blocking' : 'cw-gate',
        });
      }
    }
  }

  return { tasks, deps, labels, tips, min: min as string | null, max: max as string | null };
}

/** Tall enough for the rows that show (collapsed groups count once), within 260 to 560 pixels. */
function ganttHeight(tasks: GanttTask[]): number {
  const rows = (ts: GanttTask[]): number =>
    ts.reduce((n, t) => n + 1 + (t.expanded && t.children ? rows(t.children) : 0), 0);
  return Math.min(560, Math.max(260, 70 + rows(tasks) * 40));
}

export function TimelineView({
  detail,
  today,
  onChange,
}: {
  detail: AgreementDetail;
  today: string;
  onChange: (d: AgreementDetail) => void;
}) {
  const { run, toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  // Polling hands over a new detail object every time; the Gantt is rebuilt only when what it
  // draws changed, and never while a bar is being dragged.
  const fingerprint = JSON.stringify([
    detail.phases,
    detail.charges,
    detail.version?.plan.obligations,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content, not identity.
  const built = useMemo(() => build(detail), [fingerprint]);
  // A ref, not state: re-rendering the Gantt while a bar is held would cancel the drag.
  const dragging = useRef(false);
  const shown = useRef(built);
  if (!dragging.current) shown.current = built;
  const { tasks, deps, labels, tips, min, max } = shown.current;
  const live = isLive(detail.agreement);

  // Today is always in view: the reader should see how far off the first payment is.
  const first = min && min < today ? min : today;
  const spanStart = addDays(first, -10);
  const naturalEnd = max ?? addDays(today, 120);
  // A long agreement opens on its first eight months; scroll for the rest.
  const spanEnd =
    daysBetween(spanStart, naturalEnd) > 250 ? addDays(spanStart, 250) : addDays(naturalEnd, 21);
  const preset = daysBetween(spanStart, spanEnd) > 150 ? 'monthAndYear' : 'weekAndMonth';
  // Bryntum compares Date props by identity; a new Date each render would reset the view.
  const dates = useMemo(
    () => ({ start: toDate(spanStart), end: toDate(spanEnd), today: toDate(today) }),
    [spanStart, spanEnd, today],
  );

  const clauses = detail.version ? clauseById(detail.version.plan) : undefined;
  const names = keyNames(detail.version?.plan);
  const reportAgent = async (since: number) => {
    const decisions = await api.decisions(detail.agreement.id).catch(() => []);
    const fresh = decisions.find((d) => new Date(d.createdAt).getTime() >= since - 2000);
    if (fresh) {
      toast({
        tone: 'agent',
        title: actionTitle(fresh.proposal.action),
        body: humanText(fresh.proposal.rationale || fresh.outcome.reason, clauses, names),
      });
    }
  };

  const movePhase = async (
    key: string,
    body: { start?: string; end?: string; completedOn?: string },
  ) => {
    const since = Date.now();
    setBusy(key);
    const d = await run(
      () => api.movePhase(detail.agreement.id, key, body),
      'The phase did not move',
    );
    setBusy(null);
    if (d) {
      onChange(d);
      await reportAgent(since);
    } else {
      // Put the bar back where the server says it is.
      onChange({ ...detail });
    }
  };

  if (tasks.length === 0) {
    return (
      <div className="sheet max-w-[640px] px-6 py-5">
        <p className="serif text-[18px] text-ink">
          {!detail.version
            ? 'The timeline appears once the plan is compiled'
            : live
              ? 'Nothing is scheduled yet'
              : 'The schedule runs once every party approves'}
        </p>
        <p className="mt-1.5 text-[13.5px] text-ink-2">
          {!detail.version
            ? 'It shows delivery phases and every payment the plan schedules.'
            : 'This plan has no delivery phases or fixed-date payments to place in advance. Shares, usage and fees are charged as they happen, and each appears here when it does.'}
        </p>
      </div>
    );
  }
  const delivered = new Set(detail.phases.filter((p) => p.current.completedOn).map((p) => p.key));
  const phaseName = (k: string) => detail.phases.find((p) => p.key === k)?.name ?? names.get(k);

  return (
    <div
      className={`grid gap-5 ${detail.phases.length > 0 ? 'xl:grid-cols-[minmax(0,1fr)_260px]' : ''}`}
    >
      <div className="min-w-0">
        <div className="sheet overflow-hidden" style={{ height: ganttHeight(tasks) }}>
          <Gantt
            tasks={tasks}
            dependencies={deps}
            start={dates.start}
            end={dates.end}
            today={dates.today}
            onDragging={(held) => {
              dragging.current = held;
            }}
            preset={preset}
            labels={labels}
            tips={tips}
            lockedIds={detail.phases
              .filter((p) => p.current.completedOn)
              .map((p) => `phase:${p.key}`)}
            onLocked={(name) =>
              toast({
                tone: 'info',
                title: `${name} is delivered`,
                body: 'A delivered phase is part of the record, so it cannot be moved.',
              })
            }
            onPhaseMoved={(taskId, s, e) => {
              const key = taskId.slice('phase:'.length);
              void movePhase(key, { start: fromDate(s), end: addDays(fromDate(e), -1) });
            }}
          />
        </div>
        <Legend />
        {detail.charges.length === 0 && (
          <p className="mt-2 text-[12.5px] text-ink-3">
            {live ? '' : 'The schedule runs once every party approves. '}These are the plan's fixed
            payments where its dates put them. Usage, shares, late fees and payouts appear as they
            happen.
          </p>
        )}
      </div>
      {detail.phases.length > 0 && (
        <aside className="space-y-3">
          <h2 className="serif text-[17px] font-medium">Phases</h2>
          <p className="text-[12.5px] text-ink-2">
            Drag a phase to move it. The schedule agent re-dates the payments tied to it and
            explains why, citing the clause.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
            {detail.phases.map((p) => (
              <PhaseRow
                key={p.key}
                phase={p}
                live={live}
                busy={busy === p.key}
                waitingOn={(p.dependsOn ?? [])
                  .filter((k) => !delivered.has(k))
                  .map((k) => phaseName(k) ?? 'an earlier phase')}
                onDelivered={() => void movePhase(p.key, { completedOn: today })}
              />
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}

function PhaseRow({
  phase: p,
  live,
  busy,
  waitingOn,
  onDelivered,
}: {
  phase: PhaseView;
  live: boolean;
  busy: boolean;
  /** Earlier phases this one depends on that are not yet delivered. */
  waitingOn: string[];
  onDelivered: () => void;
}) {
  const drawn = drawnDates(p);
  return (
    <div
      className={`rounded-[10px] border bg-sheet px-3.5 py-3 ${p.blockedBy ? 'border-red/40' : 'border-rule'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-ink">{p.name}</div>
          <div className="num text-[12.5px] text-ink-3">
            {p.current.completedOn
              ? `Delivered ${day(p.current.completedOn)}`
              : `${day(drawn.start, true)} to ${day(drawn.end)}`}
          </div>
        </div>
        {p.current.completedOn ? (
          <Pill tone="seal">Delivered</Pill>
        ) : p.blockedBy ? (
          <Pill tone="red">Blocked</Pill>
        ) : null}
      </div>
      {p.blockedBy && (
        <p className="mt-2 text-[12.5px] text-red">
          Waiting on {tidyLabel(p.blockedBy.label)} (
          {STATUS_LABEL[p.blockedBy.status].toLowerCase()}). The contract does not oblige work to
          start until PayPal confirms it.
        </p>
      )}
      {!p.current.completedOn && live && (
        <>
          <button
            type="button"
            className="btn btn-quiet mt-2.5 h-7 px-2.5 text-[12px]"
            disabled={busy || p.blockedBy !== null || waitingOn.length > 0}
            onClick={onDelivered}
          >
            {busy && <Spinner className="size-3" />}
            Mark delivered
          </button>
          {waitingOn.length > 0 && (
            <p className="mt-1.5 text-[12px] text-ink-3">
              Deliver {waitingOn.join(' and ')} first.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Legend() {
  const payments: [string, string][] = [
    ['Paid', STATUS_COLOR.paid],
    ['Issued', STATUS_COLOR.issued],
    ['Scheduled', STATUS_COLOR.scheduled],
    ['Awaiting PayPal', STATUS_COLOR.awaiting_approval],
    ['Overdue or refused', STATUS_COLOR.overdue],
  ];
  return (
    <div className="mt-3 space-y-1.5 text-[12px] text-ink-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="w-[68px] text-ink-3">Payments</span>
        {payments.map(([label, color]) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rotate-45" style={{ background: color }} aria-hidden />
            {label}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="w-[68px] text-ink-3">Phases</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-5 rounded-sm bg-seal" aria-hidden />
          Delivered
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="hatched h-2.5 w-5 rounded-sm border border-red" aria-hidden />
          Held by an unpaid gate
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0 w-5 border-t-2 border-dashed border-paypal" aria-hidden />
          Payment gates the next phase
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-0 border-l-2 border-[#f5a623]" aria-hidden />
          Today
        </span>
      </div>
    </div>
  );
}
