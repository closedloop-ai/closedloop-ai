/**
 * @file harness-fixtures.ts
 * @description Shared mock-harness support for the crewd suites that drive the
 * cascade with an injected registry (ISS-5296).
 *
 * `cascade.test.ts` and `audit.test.ts` each carried a private, near-identical
 * copy of `res` and `registry` (the only difference was an unasserted
 * `durationMs`), and `dispatch.test.ts` needs the same thing. Per the root
 * AGENTS.md rule on extracting a nontrivial fixture used across files, they live
 * here once.
 *
 * Deliberately NOT moved: `audit.test.ts`'s specialized builders
 * (`writingHarness`, `elicitingHarness`, `capturingHarness`). Those encode the
 * audit pass's own prompt/findings protocol, so they stay next to the suite that
 * owns that protocol.
 */

import type { HarnessRegistry } from "../../src/harness/index.js";
import type { Harness, RunOpts, RunResult } from "../../src/harness/types.js";
import {
  DEFAULT_MODEL,
  type HarnessName,
  NativeSchedule,
} from "../../src/model.js";

/** A `RunResult` with failure defaults; override only what the case is about. */
export function res(partial: Partial<RunResult> = {}): RunResult {
  return {
    ok: false,
    exitCode: 1,
    signal: null,
    timedOut: false,
    durationMs: 5,
    outputTail: "",
    ...partial,
  };
}

/**
 * A mock `Harness` that replays a scripted list of results (the last entry
 * repeats), records every `RunOpts` it saw, and reports availability.
 */
export type MockHarness = Harness & {
  calls: () => number;
  /** Every `run` opts seen, in order — lets tests assert the model threaded in. */
  runOpts: () => RunOpts[];
};

export function mockHarness(
  name: HarnessName,
  script: RunResult[],
  available = true
): MockHarness {
  let n = 0;
  const seen: RunOpts[] = [];
  return {
    name,
    capabilities: {
      nativeSchedule: NativeSchedule.None,
      availableModels: [DEFAULT_MODEL[name]],
      defaultModel: DEFAULT_MODEL[name],
    },
    isAvailable: () => Promise.resolve(available),
    listModels: () => Promise.resolve([DEFAULT_MODEL[name]]),
    run: (o: RunOpts) => {
      seen.push(o);
      return Promise.resolve(
        script[Math.min(n++, script.length - 1)] as RunResult
      );
    },
    calls: () => n,
    runOpts: () => seen,
  };
}

/**
 * A full `HarnessRegistry` whose three slots default to one always-failing
 * harness; override the slots the case cares about.
 */
export function registry(over: Partial<HarnessRegistry> = {}): HarnessRegistry {
  const base = mockHarness("claude", [res({ ok: false })]);
  return {
    claude: base,
    codex: base,
    opencode: base,
    ...over,
  };
}
