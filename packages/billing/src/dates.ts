import type { DateRef, Interval, Plan } from '@clausework/core';

/** Dates are ISO calendar days (YYYY-MM-DD) in UTC. No time zones inside the money plan. */
export type IsoDay = string;

const parse = (d: IsoDay) => new Date(`${d}T00:00:00Z`);
const format = (d: Date): IsoDay => d.toISOString().slice(0, 10);

export function addDays(day: IsoDay, n: number): IsoDay {
  const d = parse(day);
  d.setUTCDate(d.getUTCDate() + n);
  return format(d);
}

/** Adds months, clamping to the month's last day (Jan 31 + 1 month = Feb 28). */
export function addMonths(day: IsoDay, n: number): IsoDay {
  const d = parse(day);
  const targetMonth = d.getUTCMonth() + n;
  const anchor = new Date(Date.UTC(d.getUTCFullYear(), targetMonth, 1));
  const lastDay = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0),
  ).getUTCDate();
  anchor.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return format(anchor);
}

export function addInterval(day: IsoDay, interval: Interval, n: number): IsoDay {
  switch (interval) {
    case 'week':
      return addDays(day, 7 * n);
    case 'month':
      return addMonths(day, n);
    case 'quarter':
      return addMonths(day, 3 * n);
    case 'year':
      return addMonths(day, 12 * n);
  }
}

/** Whole days from `a` to `b` (negative when b is earlier). */
export function daysBetween(a: IsoDay, b: IsoDay): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / 86_400_000);
}

/** Whole months elapsed after `periodIndex` periods of `interval`. */
export function monthsElapsed(interval: Interval, periodIndex: number): number {
  if (interval === 'week') return Math.floor((periodIndex * 12) / 52);
  return periodIndex * (interval === 'month' ? 1 : interval === 'quarter' ? 3 : 12);
}

/** Where each phase actually sits. Starts as the plan's dates; the runtime moves them. */
export type PhaseDates = Record<string, { start: IsoDay | null; end: IsoDay | null }>;

export function plannedPhaseDates(plan: Plan): PhaseDates {
  return Object.fromEntries(plan.phases.map((p) => [p.key, { start: p.start, end: p.end }]));
}

/** The calendar day a reference points at, or null when what it depends on has no date yet. */
export function resolveDate(plan: Plan, ref: DateRef, phases: PhaseDates): IsoDay | null {
  switch (ref.kind) {
    case 'date':
      return ref.date;
    case 'effective':
      return plan.effectiveDate ? addDays(plan.effectiveDate, ref.offsetDays) : null;
    case 'phase_start': {
      const at = phases[ref.phase]?.start;
      return at ? addDays(at, ref.offsetDays) : null;
    }
    case 'phase_end': {
      const at = phases[ref.phase]?.end;
      return at ? addDays(at, ref.offsetDays) : null;
    }
  }
}
