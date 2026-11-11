import { createServer } from 'node:http';
import { DomainError } from '@clausework/core';
import { agreements, charges, webhookEvents } from '@clausework/db';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  type Agents,
  alertOwnerNow,
  checkPayPalNow,
  decide,
  Lanes,
  loadAgreement,
  runCompile,
  runHourlyNow,
} from '../src/index.ts';
import {
  agencyWithRetainage,
  compiledAgreement,
  deliver,
  run,
  ScriptedScheduleAgent,
  setToday,
  type TestEngine,
  testEngine,
} from './harness.ts';

const payer = { name: 'Northwind Outfitters', email: 'ap@northwind.test' };
const quiet = () => new ScriptedScheduleAgent(() => ({ summary: '', actions: [] }));

async function liveAgency(engine: TestEngine): Promise<string> {
  await setToday(engine, '2027-01-04');
  const id = await compiledAgreement(engine, agencyWithRetainage());
  for (const party of ['client', 'agency', 'motion']) {
    await decide(engine, await loadAgreement(engine.db, id), party, { decision: 'approved' });
  }
  await run(engine);
  return id;
}

const workflowsNamed = async (name: string) =>
  (await DBOS.listWorkflows({ workflowName: name })).map((w) => w.workflowID);

describe('durable work on DBOS', () => {
  it('runs each agreement’s rules once per day, however often the schedule fires', async () => {
    const engine = await testEngine(quiet());
    const id = await liveAgency(engine);
    const before = new Set(await workflowsNamed('rulesForDay'));

    // The schedule firing twice for the same slot, as two servers would.
    const slot = new Date('2027-01-04T10:00:00Z');
    await runHourlyNow(slot);
    await runHourlyNow(slot);
    await run(engine);
    const added = (await workflowsNamed('rulesForDay')).filter((w) => !before.has(w));
    // Today already ran (setToday), so the schedule queues only today's retry for this slot.
    expect(added).toEqual([`rules:${id}:2027-01-04:2027-01-04T10:00`]);
  });

  it('finds a paid invoice through the scheduled PayPal check when its webhook never came', async () => {
    const engine = await testEngine(quiet());
    const id = await liveAgency(engine);
    await setToday(engine, '2027-04-02');
    await deliver(engine, id, 'design', '2027-04-02');
    await run(engine);
    const invoice = (
      await engine.db.select().from(charges).where(eq(charges.agreementId, id))
    ).find((c) => c.chargeKey === 'phase_2');
    // PayPal takes the payment but its webhook is lost.
    engine.simulator.onWebhook(async () => {});
    await engine.simulator.payInvoice(invoice?.paypalRef as string, payer);

    // The check runs as a workflow; what it finds is queued from inside its step.
    await checkPayPalNow();
    await run(engine);
    const [paid] = await engine.db
      .select()
      .from(charges)
      .where(eq(charges.id, invoice?.id ?? ''));
    expect(paid?.status).toBe('paid');
  });

  it('queues a stored webhook again when nothing handled it', async () => {
    const engine = await testEngine(quiet());
    await liveAgency(engine);
    await engine.db.insert(webhookEvents).values({
      id: 'WH-STRANDED',
      type: 'PAYMENT.CAPTURE.COMPLETED',
      resourceId: 'nothing',
      payload: { id: 'WH-STRANDED', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} },
      verified: true,
      createdAt: new Date(Date.now() - 5 * 60_000),
    });
    await runHourlyNow();
    await run(engine);
    const [row] = await engine.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, 'WH-STRANDED'));
    expect(row?.processedAt).not.toBeNull();
  });

  it('keeps work on one agreement apart across processes, through Postgres', async () => {
    // Two pools stand in for two servers: they share nothing but the database.
    const a = new Lanes(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }));
    const b = new Lanes(new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }));
    const order: string[] = [];
    const work = (name: string) => async () => {
      order.push(`${name} start`);
      await new Promise((r) => setTimeout(r, 150));
      order.push(`${name} end`);
    };
    await Promise.all([a.run('agreement-1', work('a')), b.run('agreement-1', work('b'))]);
    expect([order[0]?.slice(0, 1), order[1]?.endsWith('end')]).toEqual([
      order[1]?.slice(0, 1),
      true,
    ]);

    // Different agreements do not wait on each other, and a held lane is re-entrant.
    const both: string[] = [];
    await Promise.all([
      a.run('agreement-2', () => a.run('agreement-2', async () => void both.push('a'))),
      b.run('agreement-3', async () => void both.push('b')),
    ]);
    expect(both.sort()).toEqual(['a', 'b']);
    await a.close();
    await b.close();
  });

  it('posts what needs the owner to the alert webhook, once each and in order', async () => {
    const received: { text: string; type: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    const engine = await testEngine(quiet());
    engine.alertWebhookUrl = `http://127.0.0.1:${port}/hook`;
    const id = await liveAgency(engine);
    await alertOwnerNow(); // The first run starts the cursor at now: no history is replayed.

    engine.simulator.failNext('payout', 'INSUFFICIENT_FUNDS', 422);
    await setToday(engine, '2027-04-02');
    await deliver(engine, id, 'design', '2027-04-02');
    await run(engine);
    const invoice = (
      await engine.db.select().from(charges).where(eq(charges.agreementId, id))
    ).find((c) => c.chargeKey === 'phase_2');
    await engine.simulator.payInvoice(invoice?.paypalRef as string, payer);
    await run(engine);

    await new Promise((r) => setTimeout(r, 5_500)); // Alerts settle for a few seconds first.
    await alertOwnerNow();
    await alertOwnerNow();
    server.close();
    expect(received.map((r) => r.type)).toEqual(['paypal_refused']);
    expect(received[0]?.text).toMatch(/PayPal refused .* payout to Kinetic/);
    expect(received[0]?.text).toContain(`/agreements/${id}?tab=activity`);
  });

  it('retries a compile whose workflow is gone, and a superseded compile writes nothing', async () => {
    const engine = await testEngine(quiet());
    await setToday(engine, '2027-01-04');
    const [row] = await engine.db
      .insert(agreements)
      .values({
        title: 'Stuck',
        status: 'compiling',
        sourceKind: 'text',
        sourceName: 'stuck.txt',
        sourceText: 'Acme pays Beta $1,000 a month.',
        compileRun: 'run-1',
        updatedAt: new Date(Date.now() - 60 * 60_000),
      })
      .returning();
    const id = (row as { id: string }).id;
    // A compiler that refuses, so the retried compile ends quickly and visibly.
    const reads: string[] = [];
    engine.agents = {
      ...(engine.agents as Agents),
      compiler: {
        read: async () => {
          reads.push('read');
          throw new DomainError('invalid', 'unreadable');
        },
      } as unknown as Agents['compiler'],
    };
    await runHourlyNow(new Date('2027-01-04T11:00:00Z'));
    await run(engine);
    expect(reads).toEqual(['read']);
    expect((await loadAgreement(engine.db, id)).status).toBe('failed');

    // A run that a recompile replaced stops before it writes anything.
    await engine.db
      .update(agreements)
      .set({ status: 'compiling', compileRun: 'run-2', failure: null })
      .where(eq(agreements.id, id));
    await runCompile(engine, id, undefined, 'run-1');
    expect(reads).toEqual(['read']);
    expect((await loadAgreement(engine.db, id)).status).toBe('compiling');
  });

  it('backs off a payout PayPal refused for want of funds, then sends it once the wait is over', async () => {
    const engine = await testEngine(quiet());
    const id = await liveAgency(engine);
    engine.simulator.failNext('payout', 'INSUFFICIENT_FUNDS', 422);
    await setToday(engine, '2027-04-02');
    await deliver(engine, id, 'design', '2027-04-02');
    await run(engine);
    const invoice = (
      await engine.db.select().from(charges).where(eq(charges.agreementId, id))
    ).find((c) => c.chargeKey === 'phase_2');
    await engine.simulator.payInvoice(invoice?.paypalRef as string, payer);
    await run(engine);
    const split = async () =>
      (await engine.db.select().from(charges).where(eq(charges.agreementId, id))).find(
        (c) => c.obligationKey === 'motion_share',
      );
    expect((await split())?.status).toBe('scheduled');

    // Straight away the refusal is still waiting out its backoff: nothing is sent.
    await checkPayPalNow();
    await run(engine);
    expect((await split())?.status).toBe('scheduled');
    expect((await split())?.paypalData).toMatchObject({ refusals: 1 });
    // Once the backoff is over, the next check sends it.
    await engine.db
      .update(charges)
      .set({
        paypalData: sql`${charges.paypalData} || '{"retryAt":"2000-01-01T00:00:00Z"}'::jsonb`,
      })
      .where(eq(charges.id, (await split())?.id as string));
    await checkPayPalNow();
    await run(engine);
    expect((await split())?.status).toBe('paid');
  });
});
