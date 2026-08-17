import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { main, parseOptions, toReviewOutcome } from "../src/cli.js";
import {
  hasConfirmedNativeOwner,
  NATIVE_OWNER_META_KEY,
  RunStatus,
  type ScheduledTask,
  TaskRoute,
} from "../src/model.js";
import type { AuditRunResult } from "../src/passes/audit.js";
import type { Finding } from "../src/passes/findings.js";
import { TaskStore } from "../src/scheduler/store.js";
import { makeCliFixture } from "./helpers/cli-fixtures.js";

function auditResult(over: Partial<AuditRunResult>): AuditRunResult {
  return {
    ok: true,
    character: "docs-darwin",
    harnessUsed: "codex",
    attempts: [],
    findings: [],
    error: null,
    ...over,
  };
}

const sampleFinding: Finding = {
  title: "a finding",
  description: "d",
};

const UNKNOWN_HARNESS = /unknown harness/;
const UNKNOWN_ROUTE = /unknown --route/;

describe("parseOptions", () => {
  it("parses a bare command", () => {
    const { command, rest, opts } = parseOptions(["list"]);
    expect(command).toBe("list");
    expect(rest).toEqual([]);
    expect(opts).toEqual({});
  });

  it("defaults to help when no command is given", () => {
    const { command } = parseOptions([]);
    expect(command).toBe("help");
  });

  it("collects positional args into rest", () => {
    const { command, rest } = parseOptions(["add", "my-task", "0 20 * * *"]);
    expect(command).toBe("add");
    expect(rest).toEqual(["my-task", "0 20 * * *"]);
  });

  it("parses --store", () => {
    const { opts } = parseOptions(["list", "--store", "/tmp/s.json"]);
    expect(opts.storePath).toBe("/tmp/s.json");
  });

  it("parses --lock", () => {
    const { opts } = parseOptions(["start", "--lock", "/tmp/l.lock"]);
    expect(opts.lockPath).toBe("/tmp/l.lock");
  });

  it("parses --repo", () => {
    const { opts } = parseOptions(["start", "--repo", "/code/my-app"]);
    expect(opts.repoDir).toBe("/code/my-app");
  });

  it("parses --prompts-dir", () => {
    const { opts } = parseOptions(["start", "--prompts-dir", "/prompts"]);
    expect(opts.promptsDir).toBe("/prompts");
  });

  it("parses --kind and --pass", () => {
    const { opts } = parseOptions([
      "add",
      "x",
      "0 * * * *",
      "--kind",
      "review",
      "--pass",
      "docs-darwin",
    ]);
    expect(opts.kind).toBe("review");
    expect(opts.pass).toBe("docs-darwin");
  });

  it("parses a valid --route (FEA-4048)", () => {
    const { opts } = parseOptions([
      "add",
      "x",
      "0 * * * *",
      "--route",
      TaskRoute.ClaudeScheduledTasks,
    ]);
    expect(opts.route).toBe(TaskRoute.ClaudeScheduledTasks);
  });

  it("throws on an unknown --route so a typo can't flip to native (FEA-4048)", () => {
    // A typo must NOT be silently dropped (which would then flip to the native
    // capability default) — it throws so `main`'s catch sets exitCode=2.
    expect(() =>
      parseOptions(["add", "x", "0 * * * *", "--route", "not-a-route"])
    ).toThrow(UNKNOWN_ROUTE);
  });

  it("rejects the opt-in-only claude-routine via --route (FEA-4048)", () => {
    // Cloud is opt-in and undocumented on the CLI, so the accepted set matches
    // the documented set: `claude-routine` is not settable here.
    expect(() =>
      parseOptions([
        "add",
        "x",
        "0 * * * *",
        "--route",
        TaskRoute.ClaudeRoutine,
      ])
    ).toThrow(UNKNOWN_ROUTE);
  });

  it("parses --interval with a positive finite number", () => {
    const { opts } = parseOptions(["start", "--interval", "5000"]);
    expect(opts.intervalMs).toBe(5000);
  });

  it("ignores --interval with zero or negative value", () => {
    const { opts } = parseOptions(["start", "--interval", "0"]);
    expect(opts.intervalMs).toBeUndefined();
  });

  it("ignores --interval with non-numeric value", () => {
    const { opts } = parseOptions(["start", "--interval", "abc"]);
    expect(opts.intervalMs).toBeUndefined();
  });

  it("parses --per-attempt-timeout", () => {
    const { opts } = parseOptions(["start", "--per-attempt-timeout", "120000"]);
    expect(opts.perAttemptTimeoutMs).toBe(120_000);
  });

  it("ignores --per-attempt-timeout with non-positive value", () => {
    const { opts } = parseOptions(["start", "--per-attempt-timeout", "-1"]);
    expect(opts.perAttemptTimeoutMs).toBeUndefined();
  });

  it("parses --cascade with valid harness names", () => {
    const { opts } = parseOptions([
      "start",
      "--cascade",
      "codex,claude,opencode",
    ]);
    expect(opts.cascade).toEqual([
      { harness: "codex" },
      { harness: "claude" },
      { harness: "opencode" },
    ]);
  });

  it("parses --cascade with model shorthand", () => {
    const { opts } = parseOptions([
      "start",
      "--cascade",
      "codex:o3,claude:opus",
    ]);
    expect(opts.cascade).toEqual([
      { harness: "codex", model: "o3" },
      { harness: "claude", model: "opus" },
    ]);
  });

  it("throws on unknown harness in --cascade", () => {
    expect(() =>
      parseOptions(["start", "--cascade", "codex,unknown-harness"])
    ).toThrow(UNKNOWN_HARNESS);
  });

  it("intersperses flags and positional args", () => {
    const { command, rest, opts } = parseOptions([
      "add",
      "--kind",
      "review",
      "my-task",
      "0 * * * *",
      "--pass",
      "docs-darwin",
    ]);
    expect(command).toBe("add");
    expect(rest).toEqual(["my-task", "0 * * * *"]);
    expect(opts.kind).toBe("review");
    expect(opts.pass).toBe("docs-darwin");
  });
});

describe("crewd add — capability-aware default route (FEA-4048)", () => {
  // FEA-4069: the CLI wires a native writer whose default path is the operator's
  // real `~/.claude`, so the fixture points CLAUDE_HOME at a temp dir — a
  // claude-primary default-native task must never touch the real Claude config.
  const cli = makeCliFixture({ prefix: "crewd-add-route-" });

  async function addedTasks(argv: string[]) {
    await main(argv);
    return new TaskStore(cli.storePath()).listTasks();
  }

  it("defaults a claude-primary task to the native scheduled-tasks route", async () => {
    const tasks = await addedTasks([
      "add",
      "nightly-produce",
      "0 20 * * *",
      "--store",
      cli.storePath(),
      "--cascade",
      "claude",
      // FEA-4069: a native task needs a runnable prompt or the add is rejected.
      "--prompt",
      "run the nightly produce loop",
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.route).toBe(TaskRoute.ClaudeScheduledTasks);
  });

  it("defaults a codex-primary task to the daemon local-cascade route", async () => {
    const tasks = await addedTasks([
      "add",
      "codex-task",
      "0 20 * * *",
      "--store",
      cli.storePath(),
      "--cascade",
      "codex,claude",
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.route).toBe(TaskRoute.LocalCascade);
  });

  it("defaults a task with no per-task cascade to local-cascade (codex-first default head)", async () => {
    const tasks = await addedTasks([
      "add",
      "no-cascade",
      "0 20 * * *",
      "--store",
      cli.storePath(),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.route).toBe(TaskRoute.LocalCascade);
  });

  it("honors an explicit --route over the capability-aware default", async () => {
    // A claude-primary task would default native; an explicit local-cascade
    // must win (the operator's opt-out).
    const tasks = await addedTasks([
      "add",
      "forced-local",
      "0 20 * * *",
      "--store",
      cli.storePath(),
      "--cascade",
      "claude",
      "--route",
      TaskRoute.LocalCascade,
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.route).toBe(TaskRoute.LocalCascade);
  });

  it("honors an explicit native --route on a codex-primary task", async () => {
    const tasks = await addedTasks([
      "add",
      "forced-native",
      "0 20 * * *",
      "--store",
      cli.storePath(),
      "--cascade",
      "codex",
      "--route",
      TaskRoute.ClaudeScheduledTasks,
      // FEA-4069: a native task needs a runnable prompt or the add is rejected.
      "--prompt",
      "audit the codex output",
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.route).toBe(TaskRoute.ClaudeScheduledTasks);
  });

  it("rejects a native task added without a --prompt (FEA-4069)", async () => {
    // A claude-primary task defaults to the native route; without a runnable
    // prompt the native writer can't materialize it, so the add must fail fast
    // (exitCode 2) rather than persist an inert task that only ever reports
    // owner=daemon.
    const tasks = await addedTasks([
      "add",
      "promptless-native",
      "0 20 * * *",
      "--store",
      cli.storePath(),
      "--cascade",
      "claude",
    ]);
    expect(process.exitCode).toBe(2);
    expect(tasks).toHaveLength(0);
  });
});

describe("crewd route + list owner (FEA-4069)", () => {
  const cli = makeCliFixture({ prefix: "crewd-route-" });

  it("flips an existing task to native, materializes it, and reports owner=claude", async () => {
    // Seed a local-cascade task with a real prompt (the CLI has no --prompt
    // flag, and a crew task's prompt defaults empty, so seed it directly).
    const store = new TaskStore(cli.storePath());
    const seeded = store.upsertTask({
      name: "produce",
      cron: "0 3 * * *",
      prompt: "run produce",
      route: TaskRoute.LocalCascade,
      timezone: "",
    });
    const id = seeded.id;

    await main([
      "route",
      id,
      TaskRoute.ClaudeScheduledTasks,
      "--store",
      cli.storePath(),
    ]);

    // The route echo reports the confirmed native owner…
    const routeLine = cli.stdout().find((l) => l.startsWith(`${id} route=`));
    expect(routeLine).toContain(`route=${TaskRoute.ClaudeScheduledTasks}`);
    expect(routeLine).toContain("owner=claude");

    // …the task is materialized into Claude's file and its owner is confirmed.
    expect(existsSync(cli.nativeFile())).toBe(true);
    const written = JSON.parse(readFileSync(cli.nativeFile(), "utf8")) as {
      tasks: Array<{ id: string }>;
    };
    expect(written.tasks.map((t) => t.id)).toContain(id);
    const reread = new TaskStore(cli.storePath()).getTask(id) as ScheduledTask;
    expect(hasConfirmedNativeOwner(reread)).toBe(true);
  });

  it("flipping back to local-cascade deregisters and reports owner=daemon", async () => {
    const store = new TaskStore(cli.storePath());
    const task = store.upsertTask({
      name: "flip",
      cron: "0 3 * * *",
      prompt: "work",
      route: TaskRoute.ClaudeScheduledTasks,
      timezone: "",
    });
    await store.whenReconciled();

    await main([
      "route",
      task.id,
      TaskRoute.LocalCascade,
      "--store",
      cli.storePath(),
    ]);

    const routeLine = cli
      .stdout()
      .find((l) => l.startsWith(`${task.id} route=`));
    expect(routeLine).toContain(`route=${TaskRoute.LocalCascade}`);
    expect(routeLine).toContain("owner=daemon");
    const reread = new TaskStore(cli.storePath()).getTask(
      task.id
    ) as ScheduledTask;
    expect(hasConfirmedNativeOwner(reread)).toBe(false);
  });

  it("rejects an unknown route value (exit code 2)", async () => {
    const store = new TaskStore(cli.storePath());
    const task = store.upsertTask({
      name: "x",
      cron: "0 3 * * *",
      prompt: "work",
    });
    process.exitCode = 0;
    await main(["route", task.id, "not-a-route", "--store", cli.storePath()]);
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it("list shows route + owner for each task", async () => {
    const store = new TaskStore(cli.storePath());
    store.upsertTask({
      name: "native",
      cron: "0 3 * * *",
      prompt: "work",
      route: TaskRoute.ClaudeScheduledTasks,
      meta: { [NATIVE_OWNER_META_KEY]: "owner-1" },
      timezone: "",
    });

    await main(["list", "--store", cli.storePath()]);
    const line = cli.stdout().join("");
    expect(line).toContain(`route=${TaskRoute.ClaudeScheduledTasks}`);
    expect(line).toContain("owner=claude");
  });
});

describe("module import safety", () => {
  it("does not run a command against process.argv on import", () => {
    // The module is imported at the top of this file. If it self-invoked
    // `main(process.argv.slice(2))`, importing it would have executed a command
    // against Vitest's argv. `main` must be an explicitly-callable export, not a
    // module-scope side effect.
    expect(typeof main).toBe("function");
  });
});

describe("toReviewOutcome", () => {
  it("maps a clean success to a findings-count summary with no error", () => {
    const outcome = toReviewOutcome(
      "docs-darwin",
      auditResult({
        ok: true,
        findings: [sampleFinding],
        harnessUsed: "codex",
      }),
      "/tmp/x.jsonl"
    );
    expect(outcome.status).toBe(RunStatus.Success);
    expect(outcome.error).toBeNull();
    expect(outcome.summary).toContain("1 finding");
    expect(outcome.summary).toContain("via codex");
    expect(outcome.logPath).toBe("/tmp/x.jsonl");
  });

  it("maps a partial failure (findings captured, ok=false) with a non-null error", () => {
    const outcome = toReviewOutcome(
      "docs-darwin",
      auditResult({
        ok: false,
        error: null,
        findings: [sampleFinding, sampleFinding],
        harnessUsed: "codex",
      }),
      "/tmp/x.jsonl"
    );
    expect(outcome.status).toBe(RunStatus.Failed);
    // The bug wongk flagged: a partial failure recorded a null error and a
    // bare task-name summary. It must now carry an explicit error + count.
    expect(outcome.error).not.toBeNull();
    expect(outcome.summary).toContain("partial");
    expect(outcome.summary).toContain("2 findings");
    expect(outcome.logPath).toBe("/tmp/x.jsonl");
  });

  it("maps a clean failure (no findings) to the error summary", () => {
    const outcome = toReviewOutcome(
      "docs-darwin",
      auditResult({
        ok: false,
        error: "cascade exhausted",
        findings: [],
        harnessUsed: null,
      }),
      null
    );
    expect(outcome.status).toBe(RunStatus.Failed);
    expect(outcome.error).toBe("cascade exhausted");
    expect(outcome.summary).toContain("cascade exhausted");
    expect(outcome.summary).not.toContain("partial");
    expect(outcome.logPath).toBeNull();
  });
});
