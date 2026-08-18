/**
 * @file cli-commands.test.ts
 * @description The `crewd` command surface other than `add`/`route`/`list`
 * (ISS-5296): `remove`, `enable`, `disable`, `runs`, `help`, and the unknown
 * command. A sibling of `cli.test.ts` rather than an extension of it — that file
 * is already at the 500-line smell line and owns `parseOptions`, `add`, `route`,
 * `list`, and `toReviewOutcome`; nothing here re-tests those.
 *
 * The distinction these cases pin down is exit-code semantics: a MISUSE (no id) is
 * a usage error the operator must see (`exitCode = 2`), while a well-formed command
 * naming a task that does not exist is a normal, reportable outcome and must NOT
 * fail the process — a script looping `crewd remove` over a cleanup list would
 * otherwise abort on the first already-removed id.
 */
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { RunStatus, TaskRoute } from "../src/model.js";
import { TaskStore } from "../src/scheduler/store.js";
import { makeCliFixture } from "./helpers/cli-fixtures.js";

const cli = makeCliFixture({ prefix: "crewd-commands-" });

function seed(over: Record<string, unknown> = {}) {
  const store = new TaskStore(cli.storePath());
  return store.upsertTask({
    name: "nightly",
    cron: "0 3 * * *",
    prompt: "work",
    timezone: "",
    ...over,
  });
}

describe("crewd remove", () => {
  it("prints usage and exits 2 when no id is given", async () => {
    await main(["remove", "--store", cli.storePath()]);

    expect(cli.stderr().join("")).toContain("usage: crewd remove");
    expect(process.exitCode).toBe(2);
  });

  it("removes an existing task and confirms by id", async () => {
    const task = seed();

    await main(["remove", task.id, "--store", cli.storePath()]);

    expect(cli.stdout().join("")).toContain(`removed ${task.id}`);
    expect(new TaskStore(cli.storePath()).getTask(task.id)).toBeUndefined();
  });

  it("reports an unknown id WITHOUT setting a failure exit code", async () => {
    await main(["remove", "ghost-id", "--store", cli.storePath()]);

    expect(cli.stdout().join("")).toContain("no such task ghost-id");
    expect(process.exitCode).toBe(0);
  });
});

describe("crewd enable / disable", () => {
  it("prints the enable usage and exits 2 when no id is given", async () => {
    await main(["enable", "--store", cli.storePath()]);

    expect(cli.stderr().join("")).toContain("usage: crewd enable");
    expect(process.exitCode).toBe(2);
  });

  it("prints the DISABLE usage for the disable command", async () => {
    // The two share one implementation; a usage line naming the wrong verb would
    // send the operator to the wrong command.
    await main(["disable", "--store", cli.storePath()]);

    expect(cli.stderr().join("")).toContain("usage: crewd disable");
    expect(process.exitCode).toBe(2);
  });

  it("disables a task and reports it", async () => {
    const task = seed();

    await main(["disable", task.id, "--store", cli.storePath()]);

    expect(cli.stdout().join("")).toContain(`${task.id} disabled`);
    expect(new TaskStore(cli.storePath()).getTask(task.id)?.enabled).toBe(
      false
    );
  });

  it("re-enables a disabled task and reports it", async () => {
    const task = seed({ enabled: false });

    await main(["enable", task.id, "--store", cli.storePath()]);

    expect(cli.stdout().join("")).toContain(`${task.id} enabled`);
    expect(new TaskStore(cli.storePath()).getTask(task.id)?.enabled).toBe(true);
  });

  it("reports an unknown id WITHOUT setting a failure exit code", async () => {
    await main(["enable", "ghost-id", "--store", cli.storePath()]);

    expect(cli.stdout().join("")).toContain("no such task ghost-id");
    expect(process.exitCode).toBe(0);
  });
});

describe("crewd list", () => {
  it("says so plainly when there are no tasks", async () => {
    await main(["list", "--store", cli.storePath()]);

    expect(cli.stdout().join("")).toContain("no tasks");
  });

  it("renders enabled/disabled state and placeholders for absent schedule data", async () => {
    // A task that has never run has no `lastStatus`; rendering an empty gap would
    // read as missing data rather than "not yet run".
    const task = seed({ enabled: false });

    await main(["list", "--store", cli.storePath()]);

    const line = cli.stdout().join("");
    expect(line).toContain(task.id);
    expect(line).toContain("disabled");
    expect(line).toContain("last=-");
  });

  it("renders an enabled task as enabled", async () => {
    seed();

    await main(["list", "--store", cli.storePath()]);

    expect(cli.stdout().join("")).toContain("enabled");
  });
});

describe("crewd runs", () => {
  it("prints nothing when a task has no run history", async () => {
    seed();

    await main(["runs", "--store", cli.storePath()]);

    expect(cli.stdout().join("")).toBe("");
  });

  it("renders a run's status and summary", async () => {
    const store = new TaskStore(cli.storePath());
    const task = seed();
    const rec = store.startRun(task);
    store.finishRun(rec.id, {
      status: RunStatus.Success,
      summary: "all clear",
    });

    await main(["runs", "--store", cli.storePath()]);

    const out = cli.stdout().join("");
    expect(out).toContain(task.name);
    expect(out).toContain("all clear");
  });

  it("appends the harness and findings path ONLY when the run carries them", async () => {
    const store = new TaskStore(cli.storePath());
    const task = seed();
    const withExtras = store.startRun(task);
    store.finishRun(withExtras.id, {
      status: RunStatus.Success,
      summary: "with extras",
      harnessUsed: "codex",
      logPath: "/tmp/findings.jsonl",
    });

    await main(["runs", "--store", cli.storePath()]);

    const out = cli.stdout().join("");
    expect(out).toContain("via codex");
    expect(out).toContain("[findings: /tmp/findings.jsonl]");
  });

  it("omits the harness and findings suffixes when the run has neither", async () => {
    const store = new TaskStore(cli.storePath());
    const task = seed();
    const bare = store.startRun(task);
    store.finishRun(bare.id, { status: RunStatus.Failed, summary: "bare" });

    await main(["runs", "--store", cli.storePath()]);

    const out = cli.stdout().join("");
    expect(out).toContain("bare");
    expect(out).not.toContain("via ");
    expect(out).not.toContain("[findings:");
  });

  it("filters history to one task when an id is given", async () => {
    const store = new TaskStore(cli.storePath());
    const kept = seed({ name: "kept" });
    const other = seed({ name: "other" });
    store.finishRun(store.startRun(kept).id, { summary: "kept-run" });
    store.finishRun(store.startRun(other).id, { summary: "other-run" });

    await main(["runs", kept.id, "--store", cli.storePath()]);

    const out = cli.stdout().join("");
    expect(out).toContain("kept-run");
    expect(out).not.toContain("other-run");
  });
});

describe("crewd help", () => {
  it("prints the command list without constructing a store", async () => {
    // `help` must work with no store configured at all — building one would make
    // the most basic command depend on a writable config directory.
    await main(["help"]);

    const out = cli.stdout().join("");
    expect(out).toContain("crewd — portable night-crew scheduler");
    expect(out).toContain("start");
    expect(process.exitCode).toBe(0);
  });

  it("falls back to help for an unknown command", async () => {
    await main(["not-a-command"]);

    expect(cli.stdout().join("")).toContain("usage: crewd <command>");
  });

  it("documents both settable routes", async () => {
    await main(["help"]);

    const out = cli.stdout().join("");
    expect(out).toContain(TaskRoute.LocalCascade);
    expect(out).toContain(TaskRoute.ClaudeScheduledTasks);
  });
});

describe("crewd argument errors", () => {
  it("exits 2 when --route is given no value", async () => {
    // A dangling flag must surface as an error, never be dropped and then flipped
    // to the OPPOSITE (capability-aware native) default.
    await main([
      "add",
      "x",
      "0 3 * * *",
      "--store",
      cli.storePath(),
      "--route",
    ]);

    expect(process.exitCode).toBe(2);
    expect(cli.stderr().join("")).toContain("unknown --route");
  });

  it("exits 2 when the route command is missing its route argument", async () => {
    const task = seed();

    await main(["route", task.id, "--store", cli.storePath()]);

    expect(process.exitCode).toBe(2);
    expect(cli.stderr().join("")).toContain("usage: crewd route");
  });

  it("exits 2 for an unknown harness in --cascade", async () => {
    await main([
      "add",
      "x",
      "0 3 * * *",
      "--store",
      cli.storePath(),
      "--cascade",
      "codex,not-a-harness",
    ]);

    expect(process.exitCode).toBe(2);
    expect(cli.stderr().join("")).toContain("unknown harness");
  });
});

describe("crewd store resolution", () => {
  it("resolves the default store through CREW_HOME when --store is omitted", async () => {
    // Pointed at the fixture's temp dir so the test can never read or write the
    // operator's real `~/.config/crew`.
    const priorCrewHome = process.env.CREW_HOME;
    process.env.CREW_HOME = cli.dir();
    try {
      await main(["list"]);
      expect(cli.stdout().join("")).toContain("no tasks");
    } finally {
      if (priorCrewHome === undefined) {
        Reflect.deleteProperty(process.env, "CREW_HOME");
      } else {
        process.env.CREW_HOME = priorCrewHome;
      }
    }
  });
});
