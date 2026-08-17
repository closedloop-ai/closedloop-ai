/**
 * @file historical-parse-worker-capability.test.ts
 * @description ISS-4573 / PR #4085 review (wongk): the utility-process parser
 * runner forks its worker with the TEST-ONLY poison capability threaded in
 * EXPLICITLY — and only when the main-process composition root cleared the
 * `!app.isPackaged` + E2E-sentinel gate. The worker never trusts the raw inherited
 * app-level sentinel (it cannot read `app.isPackaged`), so a packaged/production
 * worker can never wedge a real parse off a leaked flag. These tests pin that the
 * runner (a) sets the worker capability env when armed and (b) STRIPS any inherited
 * value from the worker env when disarmed.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  E2E_PARSE_QUARANTINE_ENABLED_VALUE,
  E2E_POISON_WORKER_CAPABILITY_ENV,
} from "../src/main/collectors/engine/e2e-parse-quarantine-seam.js";
import { createUtilityProcessHistoricalParseRunner } from "../src/main/collectors/engine/utility-process-historical-parse-runner.js";
import { Harness } from "../src/main/collectors/types.js";

type ForkOptions = { env?: NodeJS.ProcessEnv };

/** Captures both the value and the KEY-presence of the forked `env` option. */
type CapturedForkEnv = {
  env: NodeJS.ProcessEnv | undefined;
  /**
   * Whether the fork options object carried an `env` KEY at all. Electron's
   * `utilityProcess.fork` throws when the key is present but `undefined`, so the
   * production path must OMIT the key, not pass `env: undefined`.
   */
  hasEnvKey: boolean;
};

/** Minimal fake utility process that records the fork options it was given. */
class FakeUtilityProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  postMessage(): void {
    // no-op: these tests only inspect fork options, never a response
  }
  kill(): void {
    this.emit("exit", 0);
  }
}

async function captureForkEnv(
  enablePoisonWorkerCapability: boolean,
  inheritedEnv: NodeJS.ProcessEnv
): Promise<CapturedForkEnv> {
  const originalInherited = process.env[E2E_POISON_WORKER_CAPABILITY_ENV];
  if (inheritedEnv[E2E_POISON_WORKER_CAPABILITY_ENV] === undefined) {
    Reflect.deleteProperty(process.env, E2E_POISON_WORKER_CAPABILITY_ENV);
  } else {
    process.env[E2E_POISON_WORKER_CAPABILITY_ENV] =
      inheritedEnv[E2E_POISON_WORKER_CAPABILITY_ENV];
  }
  const captured: CapturedForkEnv = { env: undefined, hasEnvKey: false };
  try {
    const runner = createUtilityProcessHistoricalParseRunner({
      enablePoisonWorkerCapability,
      forkWorker: (_module, _args, options: ForkOptions) => {
        captured.env = options.env;
        captured.hasEnvKey = "env" in options;
        return new FakeUtilityProcess();
      },
    });
    const pending = runner.parseSource(Harness.Claude, "/tmp/source.jsonl");
    pending.catch(() => undefined);
    // Dispatch is serialized: the fork runs on the chained microtask.
    await Promise.resolve();
    await Promise.resolve();
    runner.stop();
    await pending.catch(() => undefined);
  } finally {
    if (originalInherited === undefined) {
      Reflect.deleteProperty(process.env, E2E_POISON_WORKER_CAPABILITY_ENV);
    } else {
      process.env[E2E_POISON_WORKER_CAPABILITY_ENV] = originalInherited;
    }
  }
  return captured;
}

test("ISS-4573: armed runner forks the worker WITH the explicit poison capability", async () => {
  const { env, hasEnvKey } = await captureForkEnv(true, {});
  assert.ok(hasEnvKey, "the fork options carry an explicit env key when armed");
  assert.ok(env, "an explicit worker env was passed when armed");
  assert.equal(
    env?.[E2E_POISON_WORKER_CAPABILITY_ENV],
    E2E_PARSE_QUARANTINE_ENABLED_VALUE
  );
});

test("ISS-4573: disarmed runner OMITS the env fork option when nothing to strip", async () => {
  const { env, hasEnvKey } = await captureForkEnv(false, {});
  // Nothing inherited and disarmed → no explicit env override needed. The fork
  // options must OMIT the `env` KEY entirely, not pass `env: undefined`: Electron's
  // `utilityProcess.fork` throws `TypeError("Invalid value for env")` on a
  // present-but-undefined `env`, which killed every historical parse and red-lined
  // the launched-app import specs (ISS-4573). Omission preserves Electron's default
  // inherited `process.env`.
  assert.equal(hasEnvKey, false, "the env fork option key is omitted");
  assert.equal(env, undefined);
});

test("ISS-4573: disarmed runner STRIPS an inherited worker-capability value", async () => {
  // PR #4085 review (wongk): a leaked/inherited capability on a production
  // (disarmed) worker must be removed so it can never wedge a real parse.
  const { env, hasEnvKey } = await captureForkEnv(false, {
    [E2E_POISON_WORKER_CAPABILITY_ENV]: E2E_PARSE_QUARANTINE_ENABLED_VALUE,
  });
  assert.ok(
    hasEnvKey,
    "a stripped env key is passed when disarmed but inherited"
  );
  assert.ok(
    env,
    "an explicit stripped env was passed when disarmed but inherited"
  );
  assert.equal(env?.[E2E_POISON_WORKER_CAPABILITY_ENV], undefined);
});
