import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Db, rateWindows, settings } from '@clausework/db';
import { eq, lt, sql } from 'drizzle-orm';
import type { Engine } from './context.ts';

/**
 * Who may act as the owner. One workspace has one owner key: generated on first boot, shown once
 * and stored only as a hash. The browser trades it for a signed session cookie; scripts send it
 * as a bearer token. Parties never need it: their portal link is their credential.
 */

const OWNER_KEY = 'owner_key';
/** Held while the first key is made, so two processes starting together make only one. */
const SETUP_LOCK = 4_120_771;
/** A browser session lasts a working week, then asks for the key again. */
const SESSION_DAYS = 7;

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
const newKey = () => `cw_${randomBytes(24).toString('base64url')}`;

/**
 * Makes sure the workspace has an owner key. Returns the key only when this call created it, so
 * the server can show it once. `fromEnv` lets a deployment choose its key instead.
 */
export async function ensureOwnerKey(db: Db, fromEnv?: string): Promise<string | null> {
  return db.transaction(async (t) => {
    await t.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
    const [row] = await t.select().from(settings).where(eq(settings.key, OWNER_KEY));
    if (fromEnv) {
      const hash = hashKey(fromEnv);
      if ((row?.value as { hash?: string } | undefined)?.hash !== hash) {
        await t
          .insert(settings)
          .values({ key: OWNER_KEY, value: { hash } })
          .onConflictDoUpdate({ target: settings.key, set: { value: { hash } } });
      }
      return null;
    }
    if (row) return null;
    const key = newKey();
    await t.insert(settings).values({ key: OWNER_KEY, value: { hash: hashKey(key) } });
    return key;
  });
}

/** The way back in after losing the key. The old key and every session signed before stop working. */
export async function resetOwnerKey(db: Db): Promise<string> {
  const key = newKey();
  await db
    .insert(settings)
    .values({ key: OWNER_KEY, value: { hash: hashKey(key) } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { hash: hashKey(key) } } });
  return key;
}

async function ownerKeyHash(db: Db): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, OWNER_KEY));
  return (row?.value as { hash?: string } | undefined)?.hash ?? null;
}

const sameText = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function ownerKeyIsValid(db: Db, key: string): Promise<boolean> {
  const hash = await ownerKeyHash(db);
  return hash !== null && sameText(hash, hashKey(key));
}

/**
 * A session token: its expiry, signed with the server secret and the current key's hash, so
 * resetting the key ends every session.
 */
export async function issueSession(engine: Engine, now = Date.now()): Promise<string> {
  const expires = now + SESSION_DAYS * 86_400_000;
  return `${expires}.${await sign(engine, String(expires))}`;
}

export async function sessionIsValid(
  engine: Engine,
  token: string,
  now = Date.now(),
): Promise<boolean> {
  const [expires, signature] = token.split('.');
  if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) < now) return false;
  return sameText(signature, await sign(engine, expires));
}

async function sign(engine: Engine, value: string): Promise<string> {
  const keyHash = (await ownerKeyHash(engine.db)) ?? '';
  return createHmac('sha256', `${engine.secret}:${keyHash}`).update(value).digest('base64url');
}

export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 86_400;

/**
 * Counts one use of something costly (a model call) against `limit` per hour. In Postgres, so the
 * limit holds across server processes. Old windows are cleared as new ones open.
 */
export async function withinRate(db: Db, bucket: string, limit: number): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  const [row] = await db
    .insert(rateWindows)
    .values({ bucket, windowStart })
    .onConflictDoUpdate({
      target: [rateWindows.bucket, rateWindows.windowStart],
      set: { uses: sql`${rateWindows.uses} + 1` },
    })
    .returning({ uses: rateWindows.uses });
  if ((row?.uses ?? 0) === 1) {
    await db.delete(rateWindows).where(lt(rateWindows.windowStart, windowStart));
  }
  return (row?.uses ?? 0) <= limit;
}
