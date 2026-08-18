import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { storeFileSchema, TaskRoute } from "../src/model.js";
import { TaskStore } from "../src/scheduler/store.js";

const INVALID_CRON = /invalid cron/;
const CORRUPT_STORE = /Corrupt store/;

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crewd-store-"));
  path = join(dir, "scheduled_tasks.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("TaskStore", () => {
  it("upserts a task with schema defaults and a computed nextRunAt", () => {
    const store = new TaskStore(path);
    const t = store.upsertTask({
      name: "cutter-carl",
      cron: "0 20 * * *",
      kind: "review",
      pass: "cutter-carl",
      timezone: "UTC",
    });
    expect(t.id).toBeTruthy();
    expect(t.enabled).toBe(true);
    expect(t.recurring).toBe(true);
    expect(t.nextRunAt).toBeTruthy();
    expect(store.listTasks()).toHaveLength(1);
  });

  it("persists to disk in a Claude-compatible, schema-valid shape", () => {
    const store = new TaskStore(path);
    store.upsertTask({ name: "apply", cron: "0 */2 * * *", kind: "apply" });
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(() => storeFileSchema.parse(raw)).not.toThrow();
    const reloaded = new TaskStore(path);
    expect(reloaded.listTasks()[0]?.name).toBe("apply");
  });

  it("disabling a task clears its nextRunAt", () => {
    const store = new TaskStore(path);
    const t = store.upsertTask({ name: "x", cron: "0 * * * *" });
    const off = store.setEnabled(t.id, false);
    expect(off?.enabled).toBe(false);
    expect(off?.nextRunAt).toBe(null);
  });

  it("records run start/finish and keeps newest-first history", () => {
    const store = new TaskStore(path);
    const t = store.upsertTask({ name: "x", cron: "0 * * * *" });
    const run = store.startRun(t);
    expect(run.status).toBe("running");
    expect(store.getTask(t.id)?.lastRunId).toBe(run.id);

    store.finishRun(run.id, {
      status: "success",
      harnessUsed: "codex",
      summary: "ok",
    });
    expect(store.getTask(t.id)?.lastStatus).toBe("success");

    const run2 = store.startRun(t);
    const history = store.listRuns(t.id);
    expect(history[0]?.id).toBe(run2.id); // newest first
    expect(history).toHaveLength(2);
  });

  it("rejects an invalid cron at write time (PR #3460 thread 2)", () => {
    const store = new TaskStore(path);
    expect(() => store.upsertTask({ name: "bad", cron: "not a cron" })).toThrow(
      INVALID_CRON
    );
    // Nothing partial persisted.
    expect(store.listTasks()).toHaveLength(0);
  });

  it("does not clobber a concurrent writer's task (PR #3460 thread 5)", () => {
    // Two TaskStore handles over the same file — the long-running daemon and an
    // ad-hoc CLI command. The CLI adds task B while the daemon holds a stale
    // snapshot; the daemon's next write must not drop B.
    const daemon = new TaskStore(path);
    const a = daemon.upsertTask({ name: "a", cron: "0 * * * *" });

    const cli = new TaskStore(path);
    const b = cli.upsertTask({ name: "b", cron: "0 * * * *" });

    // Daemon still has only A in memory; a mutation must reload and preserve B.
    daemon.startRun(a);
    const onDisk = new TaskStore(path).listTasks().map((t) => t.name);
    expect(onDisk).toContain("a");
    expect(onDisk).toContain("b");
    expect(b.id).not.toBe(a.id);
  });

  it("starts fresh when the store file does not exist", () => {
    const fresh = join(dir, "nonexistent.json");
    const store = new TaskStore(fresh);
    expect(store.listTasks()).toHaveLength(0);
    expect(store.listRuns()).toHaveLength(0);
  });

  it("throws a clear error on corrupt JSON", () => {
    writeFileSync(path, "{ broken json", "utf8");
    expect(() => new TaskStore(path)).toThrow(CORRUPT_STORE);
    expect(() => new TaskStore(path)).toThrow(path);
  });

  it("throws a clear error on valid JSON with invalid schema fields", () => {
    writeFileSync(
      path,
      JSON.stringify({
        // `version: 1` satisfies the store envelope so the ONLY schema violation
        // is the invalid task `kind` — isolating the behavior under test (a bad
        // enum value is rejected), not a missing top-level `version` literal.
        version: 1,
        tasks: [
          {
            id: "x",
            cron: "0 * * * *",
            name: "bad",
            kind: "INVALID_KIND",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        runs: [],
      }),
      "utf8"
    );
    expect(() => new TaskStore(path)).toThrow(CORRUPT_STORE);
  });

  it("normalizes an UNKNOWN route to local-cascade instead of throwing (version-skew)", () => {
    // A row written by a NEWER build carrying a future route (or a hand-edited
    // junk value) must NOT make the whole store parse as corrupt — an older
    // build degrades that task to the daemon route and runs it locally.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: "x",
            cron: "0 * * * *",
            name: "future",
            route: "some-future-native-route",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        runs: [],
      }),
      "utf8"
    );
    const store = new TaskStore(path);
    expect(store.listTasks()).toHaveLength(1);
    expect(store.listTasks()[0]?.route).toBe(TaskRoute.LocalCascade);
  });

  it("preserves a known non-default route on hydration", () => {
    // The skew normalization must not clobber a legitimately-persisted native
    // route — only UNKNOWN literals fall back.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: "y",
            cron: "0 * * * *",
            name: "native",
            route: TaskRoute.ClaudeScheduledTasks,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        runs: [],
      }),
      "utf8"
    );
    const store = new TaskStore(path);
    expect(store.listTasks()[0]?.route).toBe(TaskRoute.ClaudeScheduledTasks);
  });

  it("advanceLastRun never moves the cursor backward", () => {
    const store = new TaskStore(path);
    const t = store.upsertTask({ name: "x", cron: "0 * * * *" });
    const early = "2026-01-01T00:00:00.000Z";
    const late = "2026-06-01T00:00:00.000Z";
    store.advanceLastRun(t.id, late);
    expect(store.getTask(t.id)?.lastRunAt).toBe(late);
    store.advanceLastRun(t.id, early);
    expect(store.getTask(t.id)?.lastRunAt).toBe(late);
  });

  it("removes a task and persists the removal", () => {
    const store = new TaskStore(path);
    const t = store.upsertTask({ name: "x", cron: "0 * * * *" });
    expect(store.removeTask(t.id)).toBe(true);
    expect(store.listTasks()).toHaveLength(0);
    const reloaded = new TaskStore(path);
    expect(reloaded.listTasks()).toHaveLength(0);
  });

  it("returns false when removing a nonexistent task", () => {
    const store = new TaskStore(path);
    expect(store.removeTask("nonexistent-id")).toBe(false);
  });
});
