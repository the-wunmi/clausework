import { DomainError, type MetaView, parseInput, toJson } from '@clausework/core';
import type { Engine } from '@clausework/engine';
import * as engine from '@clausework/engine';
import { sql } from 'drizzle-orm';
import { type Context, Hono, type Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { secureHeaders } from 'hono/secure-headers';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

const STATUS: Record<DomainError['code'], ContentfulStatusCode> = {
  not_found: 404,
  conflict: 409,
  invalid: 422,
  forbidden: 403,
  unavailable: 503,
};

/** Base64 PDFs are the largest thing the API takes. */
const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MAX_WEBHOOK_BYTES = 1024 * 1024;

/** JSON with bigint amounts as strings of minor units. */
const json = (value: unknown, status: ContentfulStatusCode = 200) =>
  new Response(toJson(value), { status, headers: { 'content-type': 'application/json' } });

const SESSION_COOKIE = 'cw_session';
/** Compiles, amendments, ledger questions and audits: each is a minute or so of model time. */
const MODEL_CALLS_PER_HOUR = 60;
/** The ledger page's assistant makes several small calls per question. */
const STUDIO_CALLS_PER_HOUR = 300;
/** Wrong keys per caller, and from everyone together, per hour. */
const LOGIN_FAILURES_PER_HOUR = 20;
const LOGIN_FAILURES_PER_HOUR_ALL = 200;
/** A payer returning from PayPal asks once; a few more cover retries and a second tab. */
const PORTAL_SYNCS_PER_HOUR = 30;
const Login = z.object({ key: z.string().min(1).max(200) });

/** The caller's address as the proxy in front saw it, for limiting sign-in attempts. */
const clientOf = (c: Context) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'local';

/** The request body, validated by the engine function it is handed to. Malformed JSON fails there. */
const body = <T>(c: Context): Promise<T> => c.req.json<T>().catch(() => undefined as T);

/**
 * The HTTP surface. One workspace with one owner, who signs in with the owner key. Parties use
 * their portal token, which only ever reaches their own agreement and their own approval. PayPal
 * authenticates its webhooks by signature.
 */
export function createApp(e: Engine) {
  const app = new Hono();

  app.onError((err) => {
    if (err instanceof DomainError) {
      return json(
        { error: err.code, message: err.message, details: err.details },
        STATUS[err.code],
      );
    }
    e.log('request failed', { error: err instanceof Error ? err.stack : String(err) });
    return json({ error: 'internal', message: 'Something went wrong on our side' }, 500);
  });
  app.notFound(() => json({ error: 'not_found', message: 'No such route' }, 404));
  app.use('*', secureHeaders());
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/webhooks/paypal') return next();
    return bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => json({ error: 'too_large', message: 'Body too large' }, 413),
    })(c, next);
  });

  /**
   * Counts a wrong key against the caller and against everyone, and says whether either is still
   * within its limit. Only failures count, so the right key is never locked out; the overall cap
   * bounds guessing even from callers who vary their forwarded address.
   */
  const countWrongKey = async (c: Context): Promise<boolean> =>
    (await engine.withinRate(e.db, `login:${clientOf(c)}`, LOGIN_FAILURES_PER_HOUR)) &&
    (await engine.withinRate(e.db, 'login:all', LOGIN_FAILURES_PER_HOUR_ALL));

  /**
   * The owner: a bearer key (scripts) or a session cookie (the browser). A wrong bearer key counts
   * against the same limits as a wrong sign-in, and is refused with 429 once they are spent.
   */
  const owner = async (c: Context): Promise<'bearer' | 'session' | 'limited' | null> => {
    const auth = c.req.header('authorization');
    if (auth?.startsWith('Bearer ')) {
      if (await engine.ownerKeyIsValid(e.db, auth.slice(7).trim())) return 'bearer';
      return (await countWrongKey(c)) ? null : 'limited';
    }
    const session = getCookie(c, SESSION_COOKIE);
    return session && (await engine.sessionIsValid(e, session)) ? 'session' : null;
  };

  /**
   * A browser change must come from Clausework's own pages. The cookie is SameSite=Lax, but a
   * sibling subdomain counts as the same site, so the origin is checked as well.
   */
  const fromOwnPages = (c: Context): boolean => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return true;
    const origin = c.req.header('origin');
    if (!origin) return false;
    try {
      const from = new URL(origin);
      // The public address, or the host the request came in on (the web app forwards it).
      const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
      return from.origin === new URL(e.publicUrl).origin || from.host === host;
    } catch {
      return false;
    }
  };
  const agreementOf = (c: Context) => engine.loadAgreement(e.db, c.req.param('id') as string);
  const detail = (id: string) => engine.agreementDetail(e, id);
  /** Runs a change and waits for the workflows it queued, so the answer shows their result. */
  const settled = <T>(work: () => Promise<T>) => engine.andWaitForQueued(work);
  /** The party's portal after a change, from a fresh read of the agreement. */
  const portalAfter = async (agreement: { id: string }, partyKey: string) =>
    json(await engine.portalView(e, await engine.loadAgreement(e.db, agreement.id), partyKey));

  // ── Open to anyone: health, PayPal, sessions and the party portal ──────────
  app.get('/api/health', () => json({ ok: true }));
  /** Ready once the database answers; a load balancer stops sending traffic when it does not. */
  app.get('/api/ready', async () => {
    try {
      await e.db.execute(sql`select 1`);
      return json({ ok: true });
    } catch {
      return json({ ok: false }, 503);
    }
  });

  // ── PayPal ──────────────────────────────────────────────────────────────────
  app.post('/api/webhooks/paypal', bodyLimit({ maxSize: MAX_WEBHOOK_BYTES }), async (c) => {
    const rawBody = await c.req.text();
    const headers = Object.fromEntries(c.req.raw.headers);
    const { accepted } = await engine.receiveWebhook(e, { headers, rawBody });
    return json({ accepted }, accepted ? 200 : 400);
  });

  app.post('/api/session', async (c) => {
    const { key } = parseInput(Login, await body(c));
    if (!(await engine.ownerKeyIsValid(e.db, key))) {
      if (!(await countWrongKey(c))) {
        return json({ error: 'rate_limited', message: 'Too many attempts. Try again later.' }, 429);
      }
      throw new DomainError('forbidden', 'That key is not this workspace’s owner key');
    }
    setCookie(c, SESSION_COOKIE, await engine.issueSession(e), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: e.publicUrl.startsWith('https://'),
      path: '/',
      maxAge: engine.SESSION_MAX_AGE_SECONDS,
    });
    // Through the context, which carries the cookie it set.
    return c.json({ ok: true });
  });
  app.delete('/api/session', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ── Party portal ────────────────────────────────────────────────────────────
  app.get('/api/portal/:token', async (c) => {
    const { agreement, partyKey } = await engine.partyForToken(e, c.req.param('token'));
    return json(await engine.portalView(e, agreement, partyKey));
  });
  app.post('/api/portal/:token/approvals', async (c) => {
    const { agreement, partyKey } = await engine.partyForToken(e, c.req.param('token'));
    const input = await body<Parameters<typeof engine.decide>[3]>(c);
    // A party signs what they were shown: their portal must send the plan's hash.
    if (!input?.planHash)
      throw new DomainError('invalid', 'planHash is required: approve the version you reviewed');
    await settled(() => engine.decide(e, agreement, partyKey, input));
    return portalAfter(agreement, partyKey);
  });

  // A payer back from PayPal checkout, through their portal: ask PayPal now.
  app.post('/api/portal/:token/paypal-sync', async (c) => {
    const { agreement, partyKey } = await engine.partyForToken(e, c.req.param('token'));
    // Anyone with the link can ask; each ask calls PayPal, so a link gets a few an hour.
    if (
      !(await engine.withinRate(e.db, `sync:${agreement.id}:${partyKey}`, PORTAL_SYNCS_PER_HOUR))
    ) {
      return portalAfter(agreement, partyKey);
    }
    await settled(() => engine.reconcileWithPayPal(e, agreement));
    return portalAfter(agreement, partyKey);
  });

  // ── Everything below is the owner's ────────────────────────────────────────
  app.use('/api/*', async (c, next) => {
    const how = await owner(c);
    if (how === 'limited') {
      return json({ error: 'rate_limited', message: 'Too many attempts. Try again later.' }, 429);
    }
    if (!how) {
      return json({ error: 'unauthenticated', message: 'Sign in with the owner key' }, 401);
    }
    if (how === 'session' && !fromOwnPages(c)) {
      return json({ error: 'forbidden', message: 'Changes must come from Clausework itself' }, 403);
    }
    await next();
  });
  app.get('/api/session', () => json({ ok: true }));
  /** The web app's AI route asks before each model call, so the owner's budget has one limit. */
  app.post('/api/session/model-call', async () => {
    if (!(await engine.withinRate(e.db, 'model:studio', STUDIO_CALLS_PER_HOUR))) {
      return json({ error: 'rate_limited', message: 'Too many model calls this hour' }, 429);
    }
    return json({ ok: true });
  });
  /** Routes that spend model time count against an hourly limit. */
  const modelCall = async (_c: Context, next: Next) => {
    if (!(await engine.withinRate(e.db, 'model:api', MODEL_CALLS_PER_HOUR))) {
      return json({ error: 'rate_limited', message: 'Too many model calls this hour' }, 429);
    }
    await next();
  };
  app.post('/api/agreements', modelCall);
  app.post('/api/agreements/:id/recompile', modelCall);
  app.post('/api/agreements/:id/amendments', modelCall);
  app.post('/api/ledger/ask', modelCall);
  app.post('/api/audits', modelCall);

  // ── Meta ──────────────────────────────────────────────────────────
  const meta = async (): Promise<MetaView> => {
    const caps = await e.gateway.capabilities();
    return {
      paypal: {
        mode: e.gateway.mode,
        usageBilling: caps.usageBilling,
        transactionSearch: caps.transactionSearch,
      },
      today: await engine.today(e.db),
      timeZone: await engine.workspaceTimeZone(e.db),
      model: e.agents?.model ?? null,
      samples: engine.sampleViews(),
    };
  };
  app.get('/api/meta', async () => json(await meta()));

  // ── Agreements ──────────────────────────────────────────────────────────────
  app.get('/api/agreements', async () => json(await engine.listAgreements(e)));
  app.post('/api/agreements', async (c) =>
    json(await engine.createAgreement(e, await body(c)), 201),
  );
  app.get('/api/agreements/:id', async (c) => json(await detail(c.req.param('id'))));
  app.get('/api/agreements/:id/source.pdf', async (c) => {
    const a = await agreementOf(c);
    if (!a.sourcePdf)
      throw new DomainError('not_found', 'This agreement was not uploaded as a PDF');
    return new Response(Buffer.from(a.sourcePdf, 'base64'), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${a.sourceName.replace(/"/g, '')}"`,
      },
    });
  });
  app.post('/api/agreements/:id/owner', async (c) => {
    const a = await agreementOf(c);
    await engine.setOwner(e, a, await body(c));
    return json(await detail(a.id));
  });
  app.post('/api/agreements/:id/obligations/:key/confirm', async (c) => {
    const a = await agreementOf(c);
    await engine.confirmObligation(e, a, c.req.param('key'));
    return json(await detail(a.id));
  });
  app.put('/api/agreements/:id/obligations/:key', async (c) => {
    const a = await agreementOf(c);
    await engine.editObligation(e, a, c.req.param('key'), await body(c));
    return json(await detail(a.id));
  });
  app.put('/api/agreements/:id/parties/:key', async (c) => {
    const a = await agreementOf(c);
    await engine.editParty(e, a, c.req.param('key'), await body(c));
    return json(await detail(a.id));
  });
  app.post('/api/agreements/:id/recompile', async (c) => {
    const a = await agreementOf(c);
    await engine.recompile(e, a);
    return json(await detail(a.id));
  });
  app.post('/api/agreements/:id/approvals', async (c) => {
    const a = await agreementOf(c);
    if (!a.ownerParty) throw new DomainError('conflict', 'Choose which party you are first');
    const ownerParty = a.ownerParty;
    const input = await body<Parameters<typeof engine.decide>[3]>(c);
    await settled(() => engine.decide(e, a, ownerParty, input));
    return json(await detail(a.id));
  });
  app.post('/api/agreements/:id/activate', async (c) => {
    const a = await agreementOf(c);
    await settled(() => engine.activate(e, a));
    return json(await detail(a.id));
  });
  app.get('/api/agreements/:id/events', async (c) =>
    json(await engine.eventViews(e, (await agreementOf(c)).id)),
  );
  app.get('/api/agreements/:id/decisions', async (c) =>
    json(await engine.decisionViews(e, (await agreementOf(c)).id)),
  );
  app.post('/api/agreements/:id/usage', async (c) => {
    const live = await engine.loadLive(e.db, c.req.param('id'));
    await engine.recordUsage(e, live, await body(c));
    return json(await detail(live.agreement.id));
  });
  app.patch('/api/agreements/:id/phases/:key', async (c) => {
    const live = await engine.loadLive(e.db, c.req.param('id'));
    const input = await body<Parameters<typeof engine.updatePhase>[3]>(c);
    await settled(() => engine.updatePhase(e, live, c.req.param('key'), input));
    return json(await detail(live.agreement.id));
  });
  app.post('/api/agreements/:id/amendments', async (c) => {
    const a = await agreementOf(c);
    const input = await body<Parameters<typeof engine.draftAmendment>[2]>(c);
    await settled(() => engine.draftAmendment(e, a, input));
    return json(await detail(a.id));
  });
  app.post('/api/agreements/:id/charges/:chargeId/remind', async (c) => {
    const live = await engine.loadLive(e.db, c.req.param('id'));
    await engine.remindCharge(e, live, c.req.param('chargeId'));
    return json(await detail(live.agreement.id));
  });
  app.post('/api/agreements/:id/paypal-sync', async (c) => {
    const a = await agreementOf(c);
    await settled(() => engine.reconcileWithPayPal(e, a));
    return json(await detail(a.id));
  });

  // ── Ledger and audit ────────────────────────────────────────────────────────
  app.get('/api/ledger', async () => json(await engine.ledgerRows(e)));
  app.post('/api/ledger/ask', async (c) => json(await engine.askLedger(e, await body(c))));
  app.get('/api/audits', async () => json(await engine.auditViews(e)));
  app.post('/api/audits', async (c) => json(await engine.createAudit(e, await body(c)), 201));
  app.get('/api/audits/:id', async (c) =>
    json(await engine.auditView(e, await engine.loadAudit(e, c.req.param('id')))),
  );

  return app;
}
