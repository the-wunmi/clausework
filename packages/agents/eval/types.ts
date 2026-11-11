import type { ModelClient } from '../src/index.ts';

/** One scored check. A harmful failure fails the run whatever the pass rate. */
export interface Check {
  check: string;
  ok: boolean;
  harmful: boolean;
  note?: string;
}

/** A case runs the agent once against the real model and scores what came back. */
export interface EvalCase {
  agent: string;
  name: string;
  run(model: ModelClient): Promise<Check[]>;
}

export const check = (name: string, ok: boolean, harmful = false, note?: string): Check => ({
  check: name,
  ok,
  harmful: !ok && harmful,
  note,
});
