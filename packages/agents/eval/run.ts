/**
 * Evaluates the agents against the real model. Each case has known right answers and answers that
 * would be harmful. Exits non-zero on any harmful answer or when fewer than the threshold of checks
 * pass. Writes a JSON report to eval/reports/.
 *
 *   pnpm eval                       every case once
 *   pnpm eval --only=matcher        cases whose agent or name contains "matcher"
 *   pnpm eval --trials=3            each case three times, to see how often it varies
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ClaudeModelClient, type ModelClient, type ModelReply } from '../src/index.ts';
import { amendmentCases } from './amendment-cases.ts';
import { compileCases } from './compile-cases.ts';
import { ledgerCases } from './ledger-cases.ts';
import { matcherCases } from './matcher-cases.ts';
import { scheduleCases } from './schedule-cases.ts';
import type { Check, EvalCase } from './types.ts';

const { values: args } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    trials: { type: 'string', default: '1' },
    only: { type: 'string', default: '' },
    /** Compiling a contract takes several minutes, so cases run side by side. */
    concurrency: { type: 'string', default: '6' },
    /** Below this share of checks passed, the run fails. Any harmful answer fails it regardless. */
    threshold: { type: 'string', default: '0.9' },
  },
});

const CASES: EvalCase[] = [
  ...compileCases,
  ...scheduleCases,
  ...matcherCases,
  ...amendmentCases,
  ...ledgerCases,
];

interface Outcome extends Check {
  agent: string;
  case: string;
  trial: number;
}

const usage = { calls: 0, input: 0, output: 0, cacheRead: 0 };

/** Counts what a run costs, without the agents having to know they are being evaluated. */
function metered(model: ModelClient): ModelClient {
  return {
    model: model.model,
    async complete(request): Promise<ModelReply> {
      const reply = await model.complete(request);
      usage.calls++;
      usage.input += Number(reply.metadata.inputTokens ?? 0);
      usage.output += Number(reply.metadata.outputTokens ?? 0);
      usage.cacheRead += Number(reply.metadata.cacheReadTokens ?? 0);
      return reply;
    },
  };
}

async function runCase(model: ModelClient, c: EvalCase, trial: number): Promise<Outcome[]> {
  const at = { agent: c.agent, case: c.name, trial };
  let checks: Check[];
  try {
    checks = await c.run(model);
  } catch (err) {
    // A thrown reply (refusal, malformed output) is a failure of the case, not of the run.
    checks = [{ check: 'answers', ok: false, harmful: false, note: (err as Error).message }];
  }
  console.log(`\n${c.agent}: ${c.name} (trial ${trial})`);
  for (const r of checks) {
    const mark = r.ok ? '  ✓' : r.harmful ? '  ✗ HARMFUL' : '  ✗';
    console.log(`${mark} ${r.check}${r.note ? ` (${r.note})` : ''}`);
  }
  return checks.map((r) => ({ ...at, ...r }));
}

async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++] as () => Promise<T>;
        out.push(await job());
      }
    }),
  );
  return out;
}

function summarise(outcomes: Outcome[]) {
  return [...Map.groupBy(outcomes, (o) => o.agent)].map(([agent, list]) => ({
    agent,
    passed: list.filter((o) => o.ok).length,
    checks: list.length,
    harmful: list.filter((o) => o.harmful).length,
  }));
}

async function main() {
  const trials = Number(args.trials);
  const model = metered(new ClaudeModelClient({ effort: 'medium' }));
  const wanted = CASES.filter((c) => `${c.agent} ${c.name}`.includes(args.only));
  const jobs = Array.from({ length: trials }, (_, i) =>
    wanted.map((c) => () => runCase(model, c, i + 1)),
  ).flat();
  console.log(`Running ${jobs.length} cases against ${model.model}`);
  const outcomes = (await pool(jobs, Number(args.concurrency))).flat();

  const byAgent = summarise(outcomes);
  console.log('\nagent        passed  harmful');
  for (const a of byAgent) {
    console.log(
      `${a.agent.padEnd(12)} ${`${a.passed}/${a.checks}`.padStart(6)}  ${String(a.harmful).padStart(7)}`,
    );
  }
  const passed = outcomes.filter((o) => o.ok).length;
  const harmful = outcomes.filter((o) => o.harmful).length;
  const share = outcomes.length ? passed / outcomes.length : 0;
  console.log(
    `\n${passed}/${outcomes.length} checks passed (${(share * 100).toFixed(1)}%), ${harmful} harmful. ` +
      `${usage.calls} model calls; tokens: ${usage.input} in, ${usage.output} out, ${usage.cacheRead} cache read.`,
  );

  const dir = new URL('./reports/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`${new Date().toISOString().replaceAll(':', '-')}.json`, dir);
  writeFileSync(
    file,
    JSON.stringify(
      { model: model.model, trials, only: args.only, usage, byAgent, outcomes },
      null,
      2,
    ),
  );
  console.log(`Report: ${file.pathname}`);
  if (harmful > 0 || share < Number(args.threshold)) process.exitCode = 1;
}

await main();
