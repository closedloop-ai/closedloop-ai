/**
 * @file cli-start.test.ts
 * @description `crewd start` — the only command that wires the runnable daemon to
 * concrete fs collaborators (ISS-5296).
 *
 * ── Teardown contract (read before adding a case) ───────────────────────────
 * `cmdStart` builds the `Daemon` in a local and returns; no handle escapes, so
 * NOTHING can stop a started daemon for the rest of the file. Consequences this
 * suite is built around:
 *   - Every test uses a UNIQUE lock and store path (the fixture's per-test temp
 *     dir), so a second start never collides with a live daemon's lock by accident.
 *   - `cmdStart` registers SIGINT/SIGTERM handlers whose only action is
 *     `process.exit(0)`. Left installed they accumulate toward the max-10 warning
 *     and — far worse — a stray signal would kill the vitest worker. They are
 *     snapshotted and removed after each test.
 *   - The fixture runs with `cleanup: "afterAll"` and `restoreMocks: false`: a
 *     surviving daemon still holds its store and a `log` bound to the stdout spy,
 *     so restoring the spy or deleting the dir per-test would let a later tick
 *     write real output or reload a deleted path.
 *   - Each start passes a large explicit `--interval`, so the daemon ticks once
 *     and not again during the file. `Daemon.start()` already `unref`s its timer
 *     (an observation, not something this suite arranges), so it cannot hang the run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import {
  hasConfirmedNativeOwner,
  PassKind,
  RunStatus,
  type ScheduledTask,
  TaskRoute,
} from "../src/model.js";
import { TaskStore } from "../src/scheduler/store.js";
import { makeCliFixture } from "./helpers/cli-fixtures.js";

/** Ticks once, then not again for the lifetime of this file. */
const ONE_TICK_INTERVAL_MS = 3_600_000;

const ALREADY_RUNNING = /already running/;

const cli = makeCliFixture({
  prefix: "crewd-start-",
  cleanup: "afterAll",
  restoreMocks: false,
});

const SIGNALS = ["SIGINT", "SIGTERM"] as const;
let priorListeners = new Map<string, unknown[]>();

beforeEach(() => {
  // Snapshotted ONCE per test, not per `startArgs()` call: the double-start case
  // builds args twice, and re-snapshotting there would record the FIRST daemon's
  // handlers as pre-existing and leave them installed. A leaked handler runs
  // `daemon.stop().finally(() => process.exit(0))`, so a later signal would exit
  // the vitest worker 0 and report an interrupted run as success.
  priorListeners = new Map(
    SIGNALS.map((s) => [s, [...process.listeners(s)]] as const)
  );
});

afterEach(() => {
  // Remove ONLY the handlers this test's `cmdStart` added — a blanket
  // removeAllListeners would also drop vitest's own.
  for (const signal of SIGNALS) {
    const before = new Set(priorListeners.get(signal) ?? []);
    for (const listener of process.listeners(signal)) {
      if (!before.has(listener)) {
        process.off(signal, listener as never);
      }
    }
  }
});

function startArgs(extra: string[] = []): string[] {
  return [
    "start",
    "--store",
    cli.storePath(),
    "--lock",
    join(cli.dir(), "crewd.lock"),
    "--interval",
    String(ONE_TICK_INTERVAL_MS),
    ...extra,
  ];
}

/**
 * Seed a task whose previous cron slot is ALWAYS far in the past.
 *
 * This suite runs on the real clock (a started daemon's first tick is real), and
 * `computeDue` defers a fire by `jitterMs`, capped at `min(period*0.1, 15min)` and
 * keyed on a hash of the task's random uuid. A daily `0 3 * * *` would therefore be
 * `jitter-pending` for roughly half of ids during the 03:00-03:15 host-local
 * window — a test that fails for fifteen minutes a day. A yearly cron's previous
 * slot is months old, so it is unconditionally past any jitter.
 */
function seed(over: Partial<ScheduledTask> = {}): ScheduledTask {
  const store = new TaskStore(cli.storePath());
  return store.upsertTask({
    name: "nightly",
    cron: "0 3 1 1 *",
    prompt: "work",
    timezone: "",
    ...over,
  });
}

describe("crewd start", () => {
  it("acquires the single-instance lock with this process's pid", async () => {
    const lockPath = join(cli.dir(), "crewd.lock");

    await main(startArgs());

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid));
  });

  it("echoes the store it opened and the resolved cascade", async () => {
    await main(startArgs(["--cascade", "codex:o3,claude"]));

    const out = cli.stdout().join("");
    expect(out).toContain("crewd started");
    expect(out).toContain(cli.storePath());
    // A model-pinned step renders as `harness:model`; a bare one as the name.
    expect(out).toContain("codex:o3,claude");
  });

  it("echoes the DEFAULT cascade when none is given", async () => {
    await main(startArgs());

    expect(cli.stdout().join("")).toContain("codex,claude,opencode");
  });

  it("re-materializes an enabled native task BEFORE the first tick", async () => {
    // The startup reconcile is the double-fire guard: a store that already holds
    // `claude-scheduled-tasks` tasks (added in a prior invocation, possibly before
    // any registrar was wired) must hand them to Claude and stamp a confirmed owner
    // BEFORE the daemon's first tick reads them — otherwise a task due right at
    // boot fires locally AND natively.
    // `seed` uses a bare TaskStore with NO registrar — exactly the state this pass
    // exists for: the route is persisted as intent, but nothing was materialized
    // and no owner was ever confirmed, so the daemon would otherwise keep running
    // the task locally while Claude also holds it.
    const task = seed({ route: TaskRoute.ClaudeScheduledTasks });
    const nativePath = cli.nativeFile();
    expect(hasConfirmedNativeOwner(task)).toBe(false);
    expect(existsSync(nativePath)).toBe(false);

    await main(startArgs());

    const written = JSON.parse(readFileSync(nativePath, "utf8")) as {
      tasks: Array<{ id: string }>;
    };
    expect(written.tasks.map((t) => t.id)).toContain(task.id);
    const reread = new TaskStore(cli.storePath()).getTask(task.id);
    expect(hasConfirmedNativeOwner(reread as ScheduledTask)).toBe(true);
  });

  it("REJECTS a second start while a live process holds the lock", async () => {
    // `main`'s try/catch wraps only `parseOptions`, so the FileLock throw escapes
    // to the caller. That is the contract: `crewd start` must not quietly return
    // having started nothing, and it must not start a second daemon over one store.
    await main(startArgs());

    await expect(main(startArgs())).rejects.toThrow(ALREADY_RUNNING);
  });

  it("runs a due review task through the orchestrator and records the failure when its prompt file is missing", async () => {
    // Proves the review orchestrator is actually WIRED into the dispatch the daemon
    // drives — not merely constructed. A missing character prompt is the one branch
    // reachable without spawning a real harness, and asserting it also proves no
    // harness ran: the run fails before the cascade is ever reached.
    const task = seed({
      name: "docs-darwin",
      kind: PassKind.Review,
      pass: "docs-darwin",
      lastRunAt: null,
    });

    await main(
      startArgs(["--prompts-dir", join(cli.dir(), "no-prompts-here")])
    );

    // The launch is fire-and-forget, so wait for the recorded outcome with a
    // BOUNDED state wait rather than a fixed sleep.
    await vi.waitFor(
      () => {
        const runs = new TaskStore(cli.storePath()).listRuns(task.id, 5);
        expect(runs[0]?.status).toBe(RunStatus.Failed);
      },
      { timeout: 5000, interval: 20 }
    );

    const run = new TaskStore(cli.storePath()).listRuns(task.id, 5)[0];
    expect(run?.summary).toContain("prompt not found");
  });
});
