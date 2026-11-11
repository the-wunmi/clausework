import { agreements, events, settings } from '@clausework/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Engine } from './context.ts';

/**
 * Telling the owner when something needs them, without their watching the dashboard. Events of
 * these kinds are posted to CLAUSEWORK_ALERT_WEBHOOK_URL (a Slack incoming webhook, or anything
 * that takes a JSON POST) by a scheduled workflow, in order, each once.
 */
export const ALERT_TYPES = [
  'escalated',
  'paypal_refused',
  'payment_failed',
  'payout_unclaimed',
  'payout_returned',
  'compile_failed',
  'phase_held',
  'amendment_needs_approval',
] as const;

const CURSOR = 'alert_cursor';
const BATCH = 50;
const NO_ID = '00000000-0000-0000-0000-000000000000';

export interface Alert {
  eventId: string;
  agreementId: string;
  agreement: string;
  type: string;
  summary: string;
  occurredOn: string;
  link: string;
  /**
   * Where the next read starts once this one is delivered: the event's time as Postgres wrote it
   * (microseconds, which a JS date would lose) and its id, for events in the same microsecond.
   */
  cursor: { at: string; id: string };
}

/**
 * Alerts not yet delivered, oldest first. On the first run the cursor starts now, so turning
 * alerts on does not replay the agreement's history.
 */
export async function pendingAlerts(engine: Engine): Promise<Alert[]> {
  const [row] = await engine.db.select().from(settings).where(eq(settings.key, CURSOR));
  const cursor = row?.value as { at: string; id: string } | undefined;
  if (!cursor) {
    const [now] = (await engine.db.execute<{ at: string }>(sql`select now()::text as at`)).rows;
    await advanceAlerts(engine, { at: now?.at as string, id: NO_ID });
    return [];
  }
  const rows = await engine.db
    .select({
      id: events.id,
      agreementId: events.agreementId,
      title: agreements.title,
      type: events.type,
      summary: events.summary,
      occurredOn: events.occurredOn,
      at: sql<string>`${events.createdAt}::text`,
    })
    .from(events)
    .innerJoin(agreements, eq(agreements.id, events.agreementId))
    .where(
      and(
        inArray(events.type, [...ALERT_TYPES]),
        sql`(${events.createdAt}, ${events.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)`,
        // A transaction still open stamps its events with its start time; once committed they
        // could land behind the cursor. A few seconds' settling time keeps them in front.
        sql`${events.createdAt} < now() - interval '5 seconds'`,
      ),
    )
    .orderBy(asc(events.createdAt), asc(events.id))
    .limit(BATCH);
  return rows.map((r) => ({
    eventId: r.id,
    agreementId: r.agreementId,
    agreement: r.title,
    type: r.type,
    summary: r.summary,
    occurredOn: r.occurredOn,
    link: `${engine.publicUrl}/agreements/${r.agreementId}?tab=activity`,
    cursor: { at: r.at, id: r.id },
  }));
}

export async function advanceAlerts(engine: Engine, cursor: Alert['cursor']): Promise<void> {
  await engine.db
    .insert(settings)
    .values({ key: CURSOR, value: cursor })
    .onConflictDoUpdate({ target: settings.key, set: { value: cursor } });
}

/** Text as Slack shows it, so a name a party typed cannot turn into a link or a mention. */
const slack = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Posts one alert. Throws on anything but a 2xx, so the workflow step retries it. */
export async function deliverAlert(url: string, alert: Alert): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      // `text` is what Slack shows; the rest is for anything else that reads the alert.
      text: `*${slack(alert.agreement)}*: ${slack(alert.summary)}\n<${alert.link}|Open in Clausework>`,
      type: alert.type,
      agreementId: alert.agreementId,
      occurredOn: alert.occurredOn,
      link: alert.link,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`The alert webhook answered ${res.status}`);
}
