/**
 * @file native-scheduled-tasks-writer-edges.test.ts
 * @description Edge arms of the native scheduled-tasks writer (ISS-5296).
 *
 * Sibling of `native-scheduled-tasks-writer.test.ts` rather than an extension of
 * it: that file is the verbatim relocation of the 466-line desktop suite, and
 * keeping it a pure rename is what makes the move reviewable. These are the cases
 * it never had.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PassKind, type ScheduledTask } from "../src/model.js";
import {
  createScheduledTasksWriter,
  defaultScheduledTasksPath,
} from "../src/scheduler/native-scheduled-tasks.js";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crewd-writer-edges-"));
  filePath = join(dir, ".claude", "scheduled_tasks.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "task-1",
    name: "nightly",
    cron: "0 3 * * *",
    kind: PassKind.Custom,
    prompt: "run the sweep",
    harnessCascade: [],
    enabled: true,
    recurring: true,
    durable: true,
    catchUp: true,
    timezone: "",
    meta: {},
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...over,
  } as ScheduledTask;
}

function seedNativeFile(contents: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(contents, null, 2), "utf8");
}

function writtenEntries(): Record<string, unknown>[] {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
    tasks: Record<string, unknown>[];
  };
  return parsed.tasks;
}

describe("createScheduledTasksWriter neighbor normalization", () => {
  it("skips a neighbor entry too malformed to keep, without blocking our own write", () => {
    // A neighbor with no string id cannot be deduped against, so it is dropped —
    // but dropping it must not abort the registration we were actually asked to do.
    seedNativeFile({
      tasks: [{ cron: "0 1 * * *", prompt: "no id here" }, { id: "keeper" }],
    });
    const writer = createScheduledTasksWriter({ path: filePath });

    return writer.register(task()).then((result) => {
      expect(result.ok).toBe(true);
      const ids = writtenEntries().map((e) => e.id);
      expect(ids).toContain("keeper");
      expect(ids).toContain("task-1");
      expect(ids).toHaveLength(2);
    });
  });

  it("backfills a neighbor whose createdAt is missing or non-numeric", async () => {
    // Claude computes the next recurring fire from `lastFiredAt ?? createdAt`, so
    // re-emitting a NaN there would corrupt a schedule we merely passed through.
    seedNativeFile({
      tasks: [
        { id: "neighbor", cron: "0 1 * * *", prompt: "p", createdAt: "nope" },
      ],
    });
    const writer = createScheduledTasksWriter({ path: filePath });

    await writer.register(task());

    const neighbor = writtenEntries().find((e) => e.id === "neighbor");
    expect(typeof neighbor?.createdAt).toBe("number");
    expect(Number.isNaN(neighbor?.createdAt)).toBe(false);
  });
});

describe("createScheduledTasksWriter deregister failures", () => {
  it("reports ok:false with a note when the existing file cannot be parsed", async () => {
    // Same anti-clobber rule as register: an unreadable file is left ALONE rather
    // than replaced, because it may hold unrelated Claude schedules.
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{ not json at all", "utf8");
    const logs: string[] = [];
    const writer = createScheduledTasksWriter({
      path: filePath,
      log: (m) => logs.push(m),
    });

    const result = await writer.deregister(task());

    expect(result.ok).toBe(false);
    expect(typeof result.note).toBe("string");
    expect(readFileSync(filePath, "utf8")).toBe("{ not json at all");
    expect(logs.some((l) => l.includes("deregister"))).toBe(true);
  });

  it("logs a register failure through the injected sink", async () => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "{ not json at all", "utf8");
    const logs: string[] = [];
    const writer = createScheduledTasksWriter({
      path: filePath,
      log: (m) => logs.push(m),
    });

    const result = await writer.register(task());

    expect(result.ok).toBe(false);
    expect(logs.some((l) => l.includes("register"))).toBe(true);
  });
});

describe("defaultScheduledTasksPath", () => {
  let priorClaudeHome: string | undefined;

  beforeEach(() => {
    priorClaudeHome = process.env.CLAUDE_HOME;
  });

  afterEach(() => {
    if (priorClaudeHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = priorClaudeHome;
    }
  });

  it("falls back to ~/.claude when CLAUDE_HOME is unset", () => {
    // Deleting the property matters: assigning `undefined` stores the literal
    // string "undefined" and we would materialize into a directory named that.
    Reflect.deleteProperty(process.env, "CLAUDE_HOME");

    expect(defaultScheduledTasksPath()).toBe(
      join(homedir(), ".claude", "scheduled_tasks.json")
    );
  });
});
