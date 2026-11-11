'use client';

import type { AgreementDetail, DecisionView, EventView } from '@clausework/core';
import { api } from '@/lib/api';
import { clauseRef, day, humanize } from '@/lib/format';
import { actionTitle, clauseById, humanText, keyNames, partyName } from '@/lib/plan';
import { useResource } from '@/lib/use-resource';
import { ErrorNote, Pill, Skeleton } from '../ui';

type Item =
  | { at: string; event: EventView; decision?: undefined }
  | { at: string; decision: DecisionView; event?: undefined };

const ACTOR: Record<string, string> = {
  system: 'Clausework',
  agent: 'Schedule agent',
  owner: 'You',
  paypal: 'PayPal',
};

/**
 * Events the engine records with the `agent` actor that the schedule agent did not do: compiling
 * and drafting amendments are Clausework reading the agreement.
 */
const COMPILER_EVENTS = new Set(['plan_compiled', 'amendment_drafted', 'amendment_needs_approval']);

const OUTCOME_TONE = {
  executed: 'seal',
  rejected: 'red',
  escalated: 'amber',
  no_action: 'muted',
} as const;
const OUTCOME_LABEL = {
  executed: 'Executed',
  rejected: 'Rejected by code',
  escalated: 'Sent to a person',
  no_action: 'No action needed',
} as const;

export function ActivityView({ detail }: { detail: AgreementDetail }) {
  const id = detail.agreement.id;
  const events = useResource(() => api.events(id), [id, detail], 10_000, id);
  const decisions = useResource(() => api.decisions(id), [id, detail], 10_000, id);
  const plan = detail.version?.plan;
  const clauses = plan ? clauseById(plan) : new Map();
  const names = keyNames(plan);
  const text = (s: string) => humanText(s, clauses, names);
  const refOf = (cid: string) => clauseRef(clauses.get(cid)?.ref ?? 'Clause');
  const actorName = (e: EventView) =>
    e.actor.startsWith('party:')
      ? plan
        ? partyName(plan, e.actor.slice(6))
        : humanize(e.actor.slice(6))
      : e.actor === 'agent' && COMPILER_EVENTS.has(e.type)
        ? 'Clausework'
        : (ACTOR[e.actor] ?? humanize(e.actor));

  if ((events.loading && !events.data) || (decisions.loading && !decisions.data)) {
    return (
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }
  if (events.error && decisions.error)
    return <ErrorNote message={events.error.message} onRetry={() => void events.reload()} />;

  // Newest first by the day it happened, then by when it was recorded within that day.
  const items: Item[] = [
    ...(events.data ?? []).map((e) => ({ at: `${e.occurredOn} ${e.createdAt}`, event: e })),
    ...(decisions.data ?? []).map((d) => ({ at: `${d.occurredOn} ${d.createdAt}`, decision: d })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  if (items.length === 0) return <p className="text-ink-2">Nothing has happened yet.</p>;

  return (
    <ol className="relative max-w-[860px] space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[7px] before:w-px before:bg-rule">
      {items.map((it) =>
        it.decision ? (
          <DecisionItem key={`d-${it.decision.id}`} d={it.decision} text={text} refOf={refOf} />
        ) : (
          <li key={`e-${it.event.id}`} className="relative pl-7">
            <span
              className="absolute top-2 left-[3px] size-[9px] rounded-full border-2 border-paper bg-ink-3"
              aria-hidden
            />
            <div className="flex items-baseline justify-between gap-4">
              <EventLine actor={actorName(it.event)} summary={text(it.event.summary)} />
              <span className="num shrink-0 text-[12px] text-ink-3">
                {day(it.event.occurredOn, true)}
              </span>
            </div>
            {it.event.clauseIds.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {[...new Set(it.event.clauseIds.map(refOf))].map((r) => (
                  <span key={r} className="rounded bg-marker/70 px-1.5 text-[11.5px] text-ink">
                    {r}
                  </span>
                ))}
              </div>
            )}
          </li>
        ),
      )}
    </ol>
  );
}

/**
 * "PayPal refused …", "Northwind approved …": most summaries already open with who acted, so the
 * actor is printed only when the summary does not name them.
 */
function EventLine({ actor, summary }: { actor: string; summary: string }) {
  const named = summary.toLowerCase().startsWith(actor.toLowerCase());
  return (
    <p className="text-[13.5px] text-ink">
      {named ? (
        <>
          <span className="font-medium">{actor}</span>
          <span className="text-ink-2">{summary.slice(actor.length)}</span>
        </>
      ) : (
        <>
          <span className="font-medium">{actor}</span> <span className="text-ink-2">{summary}</span>
        </>
      )}
    </p>
  );
}

function DecisionItem({
  d,
  text,
  refOf,
}: {
  d: DecisionView;
  text: (s: string) => string;
  refOf: (clauseId: string) => string;
}) {
  const status = d.outcome.status;
  return (
    <li className="relative pl-7">
      <span
        className="absolute top-3 left-0 size-[15px] rounded-full border-2 border-paper bg-paypal"
        aria-hidden
      />
      <div className="rounded-[10px] border border-rule bg-sheet px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[12px] text-ink-3">
              {/* The trigger often opens with a name ("Discovery was moved"), so it keeps its case. */}
              {d.decidedBy === 'rules' ? 'Clausework rules' : 'Schedule agent'}, after:{' '}
              {text(d.trigger.summary)}
            </div>
            <div className="mt-0.5 text-[14px] font-medium text-ink">
              {actionTitle(d.proposal.action)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Pill tone={OUTCOME_TONE[status]}>{OUTCOME_LABEL[status]}</Pill>
            <span className="num text-[12px] text-ink-3">{day(d.occurredOn, true)}</span>
          </div>
        </div>
        {d.proposal.rationale && (
          <p className="mt-2 text-[13.5px] text-ink-2">{text(d.proposal.rationale)}</p>
        )}
        {d.proposal.clauseQuote && (
          <blockquote className="serif mt-2.5 border-l-2 border-marker-strong pl-3 text-[15px] leading-relaxed text-ink">
            “{d.proposal.clauseQuote}”
            {d.proposal.clauseId && (
              <footer className="mt-0.5 font-sans text-[12px] text-ink-3">
                {refOf(d.proposal.clauseId)}
              </footer>
            )}
          </blockquote>
        )}
        {status !== 'executed' && d.outcome.reason && (
          <p className={`mt-2 text-[12.5px] ${status === 'rejected' ? 'text-red' : 'text-ink-3'}`}>
            {text(d.outcome.reason)}
          </p>
        )}
      </div>
    </li>
  );
}
