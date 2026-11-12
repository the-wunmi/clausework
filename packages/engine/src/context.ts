import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type {
  AmendmentDrafter,
  ContractCompiler,
  LedgerAnalyst,
  ScheduleAgent,
  TransactionMatcher,
} from '@clausework/agents';
import { addDays } from '@clausework/billing';
import { DomainError, dayIn, isTimeZone } from '@clausework/core';
import type { Db, Tx } from '@clausework/db';
import { settings } from '@clausework/db';
import type { PayPalGateway } from '@clausework/paypal';
import { eq, inArray } from 'drizzle-orm';
import type pg from 'pg';

export interface Agents {
  compiler: ContractCompiler;
  schedule: ScheduleAgent;
  matcher: TransactionMatcher;
  drafter: AmendmentDrafter;
  analyst: LedgerAnalyst;
  model: string;
}

/** Everything the engine needs, built once at startup and passed first to every service. */
export interface Engine {
  db: Db;
  gateway: PayPalGateway;
  /** Null when no model is configured: rules still run, judgement goes to the owner. */
  agents: Agents | null;
  /** The web app's origin, for portal and return links. */
  publicUrl: string;
  /** Signs portal tokens. Generated once and kept in settings unless CLAUSEWORK_SECRET is set. */
  secret: string;
  /** Where alerts for the owner are posted, if anywhere (see `alerts.ts`). */
  alertWebhookUrl: string | null;
  /** Serialises work on each agreement across processes (see `Lanes`). */
  lanes: Lanes;
  log: (message: string, data?: Record<string, unknown>) => void;
}

// ── Durable steps ────────────────────────────────────────────────────────────

/**
 * Runs one named step. Inside a workflow this is a DBOS step, checkpointed once it returns, so a
 * recovered workflow skips it; services take one so the same code also runs directly (tests).
 */
export type Step = <T>(name: string, work: () => Promise<T>) => Promise<T>;
export const runDirectly: Step = (_name, work) => work();

// ── Server secret ────────────────────────────────────────────────────────────

const SECRET = 'secret';

/** The server secret: from the environment, or generated on first boot and kept in settings. */
export async function loadSecret(db: Db, fromEnv: string | undefined): Promise<string> {
  if (fromEnv) return fromEnv;
  const [row] = await db.select().from(settings).where(eq(settings.key, SECRET));
  const existing = (row?.value as { value?: string } | undefined)?.value;
  if (existing) return existing;
  const value = randomBytes(32).toString('base64url');
  await db.insert(settings).values({ key: SECRET, value: { value } }).onConflictDoNothing();
  return loadSecret(db, undefined);
}

// ── Time ─────────────────────────────────────────────────────────────────────

const CLOCK = 'clock';

/**
 * Days the engine's clock runs ahead of real time. Always zero in the product, which runs on real
 * time like PayPal; tests move it to play out months of an agreement against the simulator.
 */
export async function clockOffset(db: Db | Tx): Promise<number> {
  const [row] = await db.select().from(settings).where(eq(settings.key, CLOCK));
  const value = row?.value as { offsetDays?: number } | undefined;
  return value?.offsetDays ?? 0;
}

export async function setClockOffset(db: Db | Tx, offsetDays: number): Promise<void> {
  await db
    .insert(settings)
    .values({ key: CLOCK, value: { offsetDays } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { offsetDays } } });
}

const TIME_ZONE = 'time_zone';

/**
 * The workspace's IANA time zone. It decides which calendar day it is for every agreement, so a
 * charge due on 1 December falls due at midnight there, not at midnight UTC.
 */
export async function workspaceTimeZone(db: Db | Tx): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, TIME_ZONE));
  return (row?.value as { zone?: string } | undefined)?.zone ?? 'UTC';
}

export async function setWorkspaceTimeZone(db: Db | Tx, zone: string): Promise<void> {
  if (!isTimeZone(zone)) throw new DomainError('invalid', `Unknown time zone "${zone}"`);
  await db
    .insert(settings)
    .values({ key: TIME_ZONE, value: { zone } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { zone } } });
}

export const realToday = (zone = 'UTC'): string => dayIn(new Date(), zone);

/** Today's calendar day in the workspace's time zone, moved by the test clock. */
export async function today(db: Db | Tx): Promise<string> {
  const rows = await db
    .select()
    .from(settings)
    .where(inArray(settings.key, [CLOCK, TIME_ZONE]));
  const value = (key: string) => rows.find((r) => r.key === key)?.value as Record<string, unknown>;
  const offset = (value(CLOCK)?.offsetDays as number | undefined) ?? 0;
  const zone = (value(TIME_ZONE)?.zone as string | undefined) ?? 'UTC';
  return addDays(realToday(zone), offset);
}

// ── One lane per agreement ───────────────────────────────────────────────────

/**
 * One lane per agreement, across every server process. Rules, webhooks, agent actions and people's
 * edits all read a charge and then act on it at PayPal; holding the agreement's lane means no two
 * of them act on the same charge at once. The lane is a Postgres advisory lock held on its own
 * connection for as long as the work runs, so it also holds between processes, and is released by
 * Postgres if the process dies. Nested calls on a lane already held go straight through. The lock
 * lives in a session, so the database must be reached directly or through a session-mode pooler,
 * never a transaction-mode one (PgBouncer's default), which would lose it between statements.
 */
export class Lanes {
  readonly #held = new AsyncLocalStorage<ReadonlySet<string>>();

  constructor(private readonly pool: pg.Pool) {}

  async run<T>(agreementId: string, work: () => Promise<T>): Promise<T> {
    const holding = this.#held.getStore() ?? new Set<string>();
    if (holding.has(agreementId)) return work();
    const client = await this.pool.connect();
    const key = `clausework:agreement:${agreementId}`;
    // Any error on the lane's connection discards it: Postgres then ends its session, which
    // releases the lock, rather than a lock-holding connection going back to the pool.
    let broken = false;
    try {
      await client.query('select pg_advisory_lock(hashtextextended($1, 0))', [key]);
      try {
        return await this.#held.run(new Set([...holding, agreementId]), work);
      } finally {
        await client
          .query('select pg_advisory_unlock(hashtextextended($1, 0))', [key])
          .catch(() => {
            broken = true;
          });
      }
    } catch (err) {
      broken = true;
      throw err;
    } finally {
      client.release(broken);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Runs `work` in the agreement's lane. */
export function serially<T>(
  engine: Pick<Engine, 'lanes'>,
  agreementId: string,
  work: () => Promise<T>,
): Promise<T> {
  return engine.lanes.run(agreementId, work);
}
