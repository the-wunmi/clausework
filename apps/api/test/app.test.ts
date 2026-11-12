import { createDb, createPool } from '@clausework/db';
import { runMigrations } from '@clausework/db/migrate';
import {
  createEngine,
  type Engine,
  ensureOwnerKey,
  issueSession,
  launchWorkflows,
  resetOwnerKey,
  sessionIsValid,
  shutdownWorkflows,
  waitForIdle,
} from '@clausework/engine';
import { MemorySimStore, PayPalSimulator } from '@clausework/paypal';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

let engine: Engine;
let app: ReturnType<typeof createApp>;
let ownerKey: string;

beforeAll(async () => {
  await runMigrations(process.env.DATABASE_URL);
  const db = createDb(createPool(process.env.DATABASE_URL));
  await db.execute(sql`truncate agreements, webhook_events, settings, audits cascade`);
  engine = await createEngine({
    db,
    gateway: new PayPalSimulator({ store: new MemorySimStore(), publicUrl: 'http://web.test' }),
    agents: null,
    log: () => {},
  });
  await launchWorkflows(engine);
  ownerKey = (await ensureOwnerKey(db)) as string;
  app = createApp(engine);
});

afterAll(async () => {
  await waitForIdle();
  await shutdownWorkflows();
  await engine.lanes.close();
});

const asOwner = () => ({ authorization: `Bearer ${ownerKey}` });
const get = (path: string) => app.request(path, { headers: asOwner() });
const post = (path: string, body: unknown, headers: Record<string, string> = asOwner()) =>
  app.request(path, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the API', () => {
  it('describes itself, with its PayPal and the samples', async () => {
    const res = await get('/api/meta');
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { paypal: { mode: string }; samples: { key: string }[] };
    expect(meta.paypal.mode).toBe('mock');
    expect(meta.samples.map((s) => s.key)).toContain('agency');
  });

  it('answers malformed input with 422 and the reasons', async () => {
    const res = await post('/api/agreements', { kind: 'text', name: 'x', text: 'too short' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid');
  });

  it('reads a ledger question from the body the web app sends', async () => {
    const tooShort = await post('/api/ledger/ask', { question: ' a ' });
    expect(tooShort.status).toBe(422);
    // A well-formed question gets as far as the model, which these tests run without.
    const ok = await post('/api/ledger/ask', { question: 'What is at risk this month?' });
    expect(((await ok.json()) as { error: string }).error).toBe('unavailable');
  });

  it('stores an upload and queues the compiler without waiting for it', async () => {
    const text =
      'This agreement is between Acme and Beta. Acme pays Beta $1,000 per month from 1 January 2027.';
    const res = await post('/api/agreements', { kind: 'text', name: 'short.txt', text });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const detail = (await (await get(`/api/agreements/${id}`)).json()) as {
      agreement: { stage: string; sourceText: string };
    };
    // The compile runs as a workflow; with no model configured here it fails soon after.
    expect(['reading', 'failed']).toContain(detail.agreement.stage);
    expect(detail.agreement.sourceText).toBe(text);
  });

  it('refuses a portal link it did not issue', async () => {
    const res = await app.request('/api/portal/not-a-real-token');
    expect(res.status).toBe(404);
  });

  it('rejects a webhook whose signature does not verify', async () => {
    const res = await app.request('/api/webhooks/paypal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'WH-forged',
        event_type: 'PAYMENT.CAPTURE.COMPLETED',
        resource: {},
      }),
    });
    expect(res.status).toBe(400);
  });

  it('has no demo clock or simulator routes, and 404s what it does not know', async () => {
    expect((await post('/api/clock', { advanceDays: 1 })).status).toBe(404);
    expect((await get('/api/sim/order/NOPE')).status).toBe(404);
    expect((await get('/api/nothing-here')).status).toBe(404);
  });
});

describe('who may do what', () => {
  it('keeps the owner’s routes closed without the owner key or a session', async () => {
    expect((await app.request('/api/agreements')).status).toBe(401);
    expect((await post('/api/agreements', { sample: 'agency' }, {})).status).toBe(401);
    const wrong = { authorization: 'Bearer cw_not-the-key' };
    expect((await app.request('/api/agreements', { headers: wrong })).status).toBe(401);
  });

  it('trades the owner key for an httpOnly session cookie that then works on its own', async () => {
    expect((await post('/api/session', { key: 'cw_wrong' }, {})).status).toBe(403);
    const res = await post('/api/session', { key: ownerKey }, {});
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/cw_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    const session = cookie.split(';')[0] as string;
    expect((await app.request('/api/session', { headers: { cookie: session } })).status).toBe(200);
    expect(
      (await app.request('/api/session', { headers: { cookie: 'cw_session=1.forged' } })).status,
    ).toBe(401);
  });

  it('leaves health, readiness, PayPal webhooks and portal links open', async () => {
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/ready')).status).toBe(200);
    expect((await app.request('/api/portal/not-a-real-token')).status).toBe(404);
    const hook = await app.request('/api/webhooks/paypal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'WH-x', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }),
    });
    expect(hook.status).toBe(400);
  });

  it('refuses a cookie-signed change that does not come from Clausework’s own pages', async () => {
    const login = await post('/api/session', { key: ownerKey }, {});
    const session = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const change = (origin: string | null) =>
      app.request('/api/agreements', {
        method: 'POST',
        headers: {
          cookie: session,
          'content-type': 'application/json',
          host: 'clausework.example',
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ kind: 'text', name: 'x', text: 'too short' }),
      });
    expect((await change('https://evil.example')).status).toBe(403);
    expect((await change(null)).status).toBe(403);
    // From its own pages it reaches the route (which then refuses the short text itself).
    expect((await change('https://clausework.example')).status).toBe(422);
  });

  it('ends sessions when they expire, when forged, and when the key is reset', async () => {
    const token = await issueSession(engine);
    expect(await sessionIsValid(engine, token)).toBe(true);
    expect(await sessionIsValid(engine, token, Date.now() + 8 * 86_400_000)).toBe(false);
    const [expires] = token.split('.');
    expect(await sessionIsValid(engine, `${expires}.not-the-signature`)).toBe(false);
    expect(await sessionIsValid(engine, `${Number(expires) + 1}.${token.split('.')[1]}`)).toBe(
      false,
    );
    ownerKey = await resetOwnerKey(engine.db);
    expect(await sessionIsValid(engine, token)).toBe(false);
  });

  it('limits wrong keys, but never locks out the right one', async () => {
    const from = { 'x-forwarded-for': '203.0.113.9' };
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await post('/api/session', { key: `cw_guess_${i}` }, from)).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 403)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect((await post('/api/session', { key: ownerKey }, from)).status).toBe(200);
  });

  it('limits wrong bearer keys the same way', async () => {
    const from = { 'x-forwarded-for': '203.0.113.10' };
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await app.request('/api/agreements', {
        headers: { ...from, authorization: `Bearer cw_guess_${i}` },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
    expect(
      (await app.request('/api/agreements', { headers: { ...from, ...asOwner() } })).status,
    ).toBe(200);
  });
});
