import {
  AmendmentDrafter,
  ClaudeModelClient,
  ContractCompiler,
  LedgerAnalyst,
  ScheduleAgent,
  TransactionMatcher,
} from '@clausework/agents';
import { createDb, createPool, type Db } from '@clausework/db';
import { createGateway, type PayPalGateway } from '@clausework/paypal';
import pg from 'pg';
import { type Agents, type Engine, Lanes, loadSecret, setWorkspaceTimeZone } from './context.ts';

export * from './access.ts';
export * from './activate.ts';
export * from './alerts.ts';
export * from './amendments.ts';
export * from './audit.ts';
export * from './compile.ts';
export * from './context.ts';
export * from './ledger.ts';
export * from './live.ts';
export * from './operations.ts';
export * from './repo.ts';
export * from './review.ts';
export * from './rules.ts';
export * from './samples.ts';
export * from './views.ts';
export * from './webhooks.ts';
export * from './workflows.ts';

export interface EngineOptions {
  db?: Db;
  env?: Record<string, string | undefined>;
  /** Replaces PayPal (tests use the simulator). Otherwise PAYPAL_MODE picks sandbox or live. */
  gateway?: PayPalGateway;
  /** Replaces the model (tests use scripted agents). Null turns judgement over to the owner. */
  agents?: Agents | null;
  log?: Engine['log'];
}

export async function createEngine(options: EngineOptions = {}): Promise<Engine> {
  const env = options.env ?? process.env;
  const db = options.db ?? createDb(createPool(env.DATABASE_URL));
  const publicUrl = (env.CLAUSEWORK_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  if (env.CLAUSEWORK_TIMEZONE) await setWorkspaceTimeZone(db, env.CLAUSEWORK_TIMEZONE);
  const agents =
    options.agents !== undefined
      ? options.agents
      : env.ANTHROPIC_API_KEY
        ? claudeAgents(env)
        : null;
  return {
    db,
    gateway: options.gateway ?? createGateway(env),
    agents,
    publicUrl,
    secret: await loadSecret(db, env.CLAUSEWORK_SECRET),
    alertWebhookUrl: env.CLAUSEWORK_ALERT_WEBHOOK_URL || null,
    // Its own pool: a lane holds a connection while its work runs on the main pool.
    lanes: new Lanes(new pg.Pool({ connectionString: env.DATABASE_URL, max: 16, keepAlive: true })),
    log: options.log ?? defaultLog,
  };
}

/** Failures (anything carrying an error) go to stderr, so journald files them as errors. */
function defaultLog(message: string, data?: Record<string, unknown>): void {
  const write = data && 'error' in data ? console.error : console.log;
  write(`[clausework] ${message}`, data ?? '');
}

function claudeAgents(env: Record<string, string | undefined>): Agents {
  const model = env.CLAUSEWORK_MODEL || undefined;
  const careful = new ClaudeModelClient({ model, effort: 'medium' });
  const quick = new ClaudeModelClient({ model, effort: 'low' });
  return {
    compiler: new ContractCompiler(careful),
    schedule: new ScheduleAgent(careful),
    matcher: new TransactionMatcher(careful),
    drafter: new AmendmentDrafter(careful),
    analyst: new LedgerAnalyst(quick),
    model: careful.model,
  };
}
