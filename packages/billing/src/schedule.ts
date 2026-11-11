import type { Obligation, ObligationKind, Plan } from '@clausework/core';
import {
  addDays,
  addInterval,
  addMonths,
  type IsoDay,
  type PhaseDates,
  resolveDate,
} from './dates.ts';
import { recurringAmount, resolveAmount } from './evaluate.ts';

/** Projections stop here when the agreement has no end date and the obligation no cycle count. */
export const DEFAULT_HORIZON_MONTHS = 24;

export interface ProjectedCharge {
  /** Stable across projections: `<obligation>:<period>` or `<obligation>`. */
  id: string;
  obligationKey: string;
  kind: ObligationKind;
  payer: string;
  payee: string;
  clauseIds: string[];
  label: string;
  /** When the charge is raised. Null while what it depends on (a phase) has no date. */
  issueDate: IsoDay | null;
  /** When it must be paid. */
  dueDate: IsoDay | null;
  /** Null when the amount depends on what happens (usage, receipts). */
  amount: bigint | null;
  periodIndex: number | null;
  periodStart: IsoDay | null;
  periodEnd: IsoDay | null;
}

export interface ProjectOptions {
  phases: PhaseDates;
  /** Inclusive horizon. Defaults to the plan's end date or 24 months after the effective date. */
  until?: IsoDay;
}

const base = (o: Obligation) => ({
  obligationKey: o.key,
  kind: o.kind,
  payer: o.payer,
  payee: o.payee,
  clauseIds: o.clauseIds,
});

const MONTH = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const periodName = (start: IsoDay) => MONTH.format(new Date(`${start}T00:00:00Z`));

/**
 * Every charge, payout and release the plan will raise, in date order. Deterministic: the schedule
 * agent, the Gantt and the audit all read the same projection.
 */
export function projectCharges(plan: Plan, options: ProjectOptions): ProjectedCharge[] {
  const horizon =
    options.until ??
    plan.endDate ??
    (plan.effectiveDate ? addMonths(plan.effectiveDate, DEFAULT_HORIZON_MONTHS) : null);
  const out: ProjectedCharge[] = [];

  for (const o of plan.obligations) {
    switch (o.kind) {
      case 'deposit': {
        const due = resolveDate(plan, o.due, options.phases);
        out.push({
          ...base(o),
          id: o.key,
          label: o.title,
          issueDate: due,
          dueDate: due,
          amount: resolveAmount(plan, o.amount),
          periodIndex: null,
          periodStart: null,
          periodEnd: null,
        });
        break;
      }
      case 'milestone': {
        const issue = resolveDate(plan, o.due, options.phases);
        out.push({
          ...base(o),
          id: o.key,
          label: o.title,
          issueDate: issue,
          dueDate: issue ? addDays(issue, o.netDays) : null,
          amount: resolveAmount(plan, o.amount),
          periodIndex: null,
          periodStart: null,
          periodEnd: null,
        });
        break;
      }
      case 'prepaid': {
        const at = plan.effectiveDate;
        out.push({
          ...base(o),
          id: o.key,
          label: o.title,
          issueDate: at,
          dueDate: at,
          amount: o.price,
          periodIndex: null,
          periodStart: null,
          periodEnd: null,
        });
        break;
      }
      case 'recurring': {
        const start = resolveDate(plan, o.start, options.phases);
        if (!start || !horizon) break;
        for (let i = 0; o.cycles === null || i < o.cycles; i++) {
          const periodStart = addInterval(start, o.interval, i);
          if (periodStart > horizon) break;
          out.push({
            ...base(o),
            id: `${o.key}:${i}`,
            label: `${o.title} · ${periodName(periodStart)}`,
            issueDate: periodStart,
            dueDate: periodStart,
            amount: recurringAmount(o, i),
            periodIndex: i,
            periodStart,
            periodEnd: addDays(addInterval(start, o.interval, i + 1), -1),
          });
        }
        break;
      }
      case 'usage':
      case 'revenue_share': {
        const start = plan.effectiveDate;
        if (!start || !horizon) break;
        for (let i = 0; ; i++) {
          const periodStart = addInterval(start, o.period, i);
          if (periodStart > horizon) break;
          const periodEnd = addDays(addInterval(start, o.period, i + 1), -1);
          const settle = addDays(periodEnd, 1);
          out.push({
            ...base(o),
            id: `${o.key}:${i}`,
            label: `${o.title} · ${periodName(periodStart)}`,
            issueDate: settle,
            dueDate: settle,
            amount: null,
            periodIndex: i,
            periodStart,
            periodEnd,
          });
        }
        break;
      }
      case 'retainage': {
        const release = resolveDate(plan, o.release, options.phases);
        out.push({
          ...base(o),
          id: o.key,
          label: `${o.title} released`,
          issueDate: release,
          dueDate: release,
          amount: null,
          periodIndex: null,
          periodStart: null,
          periodEnd: null,
        });
        break;
      }
      case 'late_fee':
      case 'split':
      case 'service_credit':
        // Raised only by events: a late payment, a receipt, a missed service level.
        break;
    }
  }

  return out.sort(
    (a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.id.localeCompare(b.id),
  );
}
