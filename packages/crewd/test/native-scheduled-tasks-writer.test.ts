/**
 * @file native-scheduled-tasks-writer.test.ts
 * @description FEA-3958 (PLN-1492) Slice A — behavioral coverage for the native
 * `ScheduledTasksRegistrar` that materializes a crewd task into Claude Code's
 * local `scheduled_tasks.json`. Runs against a real temp file (no HOME touched);
 * asserts file contents behaviorally, never by scanning source.
 *
 * RELOCATED from `apps/desktop/test/scheduled-tasks-writer.test.ts` (ISS-5296) as
 * a pure move — 17 tests in, 17 out. The module under test
 * (`@repo/crewd/native-scheduled-tasks`) is owned by this package, so its tests
 * belong here; sitting in apps/desktop they exercised crewd code from a lane whose
 * coverage universe (`src/**` + `scripts/**`) could never count them. Converting
 * `node:assert/strict` to vitest, `assert.deepEqual` maps to `toStrictEqual` and
 * NEVER `toEqual`: `toEqual` ignores `undefined`-valued keys, which would silently
 * gut the FEA-4054 anti-leak guard below that pins the written entry to exactly the
 * six Claude core fields. Edge arms added since the move live in the sibling
 * `native-scheduled-tasks-writer-edges.test.ts` so this file stays a reviewable rename.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ScheduledTask,
  scheduledTaskSchema,
  TaskRoute,
} from "../src/model.js";
import {
  type ClaudeScheduledTaskEntry,
  createScheduledTasksWriter,
} from "../src/scheduler/native-scheduled-tasks.js";

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sched-writer-"));
  filePath = join(dir, ".claude", "scheduled_tasks.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return scheduledTaskSchema.parse({
    id: "task-1",
    name: "nightly sweep",
    cron: "0 9 * * *",
    prompt: "run the nightly sweep",
    recurring: true,
    durable: true,
    route: TaskRoute.ClaudeScheduledTasks,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  });
}

/**
 * Parse the raw on-disk JSON. Claude Code reads an OBJECT envelope
 * (`{ tasks: [...] }`), so the file must not be a bare array (FEA-4054).
 */
function readFileJson(): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/**
 * The `tasks` array from the on-disk envelope. THROWS (failing the calling test)
 * if the file is a bare array or missing its `tasks` array, so every caller
 * transitively enforces the correct `{ tasks: [...] }` envelope (FEA-4054).
 * Kept assertion-free so it stays a pure helper (Biome `noMisplacedAssertion`).
 */
function readFileEntries(): ClaudeScheduledTaskEntry[] {
  const parsed = readFileJson();
  if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) {
    throw new Error(
      "native file must be an object envelope, never a bare array"
    );
  }
  const tasks = (parsed as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) {
    throw new Error("envelope must carry a `tasks` array");
  }
  return tasks as ClaudeScheduledTaskEntry[];
}

/** The permission bits (mode masked to the low 9) of a file at `path`. */
function permBits(path: string): number {
  // biome-ignore lint/suspicious/noBitwiseOperators: masking the permission bits out of a stat mode requires bitwise AND
  return statSync(path).mode & 0o777;
}

describe("createScheduledTasksWriter (FEA-3958 / FEA-4054)", () => {
  it("register materializes the Claude-compatible core entry, creating the file", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    const task = makeTask();

    expect(existsSync(filePath)).toBe(false);
    const result = await writer.register(task);

    // `ScheduledTasksRegistrationResult` is a discriminated union on `ok`, so
    // reading `ownerId` off it directly does not typecheck. Asserting the shape
    // makes the same two claims without a cast or a narrowing dance.
    expect(result).toMatchObject({ ok: true, ownerId: task.id });
    expect(existsSync(filePath)).toBe(true);

    const entries = readFileEntries();
    expect(entries.length).toBe(1);
    // The native entry matches Claude Code's CronTask shape: id/cron/prompt,
    // a millisecond-epoch createdAt, recurring, and `permanent` — the crewd
    // runtime-only `durable` flag is projected onto Claude's native `permanent`
    // (survives-restarts) field rather than dropped, and NO crew/UX fields leak
    // (FEA-4054).
    expect(entries[0]).toStrictEqual({
      id: "task-1",
      cron: "0 9 * * *",
      prompt: "run the nightly sweep",
      createdAt: Date.parse("2026-07-24T00:00:00.000Z"),
      recurring: true,
      permanent: true,
    });
    const keys = Object.keys(entries[0] ?? {});
    expect(keys.includes("durable")).toBe(false);
    expect(keys.includes("name")).toBe(false);
  });

  it("register projects durability onto Claude's native `permanent` field", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });

    // A durable task must emit permanent:true so the native scheduler keeps it
    // across restarts (native ownership suppresses the local daemon, so a dropped
    // durability flag would silently lose the schedule).
    await writer.register(makeTask({ id: "keeps", durable: true }));
    // A non-durable (one-shot survival) task carries permanent:false.
    await writer.register(makeTask({ id: "ephemeral", durable: false }));

    const entries = readFileEntries();
    expect(entries.find((e) => e.id === "keeps")?.permanent).toBe(true);
    expect(entries.find((e) => e.id === "ephemeral")?.permanent).toBe(false);
  });

  it("register is idempotent by id (upsert), preserving other entries", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    // Seed a pre-existing, unrelated Claude entry the operator already had.
    await writer.register(makeTask({ id: "other", cron: "0 0 * * *" }));

    await writer.register(makeTask({ id: "task-1", cron: "0 9 * * *" }));
    // Re-register the same id with a changed cron: it replaces, not duplicates.
    await writer.register(makeTask({ id: "task-1", cron: "30 9 * * *" }));

    const entries = readFileEntries();
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toStrictEqual(["other", "task-1"]);
    expect(entries.find((e) => e.id === "task-1")?.cron).toBe("30 9 * * *");
  });

  it("deregister removes only the target entry (reverse-flip cleanup)", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    await writer.register(makeTask({ id: "keep", cron: "0 0 * * *" }));
    await writer.register(makeTask({ id: "task-1" }));

    const result = await writer.deregister(makeTask({ id: "task-1" }));

    expect(result.ok).toBe(true);
    const entries = readFileEntries();
    expect(entries.map((e) => e.id)).toStrictEqual(["keep"]);
  });

  it("deregister tolerates a missing file (clean no-op)", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    expect(existsSync(filePath)).toBe(false);

    const result = await writer.deregister(makeTask());

    expect(result.ok).toBe(true);
    // No entry to remove ⇒ the writer leaves the (still absent) file alone.
    expect(existsSync(filePath)).toBe(false);
  });

  it("register FAILS and preserves an existing corrupt file (no schedule loss)", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    // First register creates the .claude dir + file; then corrupt the file.
    await writer.register(makeTask({ id: "seed" }));
    writeFileSync(filePath, "{ not valid json", "utf8");

    const result = await writer.register(makeTask({ id: "task-1" }));

    // A corrupt EXISTING file is a failed registration, not a fresh start —
    // overwriting it would delete every unrelated Claude schedule it may hold.
    expect(result.ok).toBe(false);
    expect(typeof result.note).toBe("string");
    // The file is left byte-for-byte untouched.
    expect(readFileSync(filePath, "utf8")).toBe("{ not valid json");
  });

  it("register migrates a LEGACY bare-array file to the envelope, mapping the old `durable` field onto `permanent`", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    // The EXACT shape the pre-FEA-4054 writer emitted: a bare top-level array whose
    // entries carry `durable` (never `permanent`) and NO `createdAt`. `durable` is
    // the compatibility alias for Claude's native `permanent` flag.
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify([
        {
          id: "foreign",
          cron: "0 0 * * *",
          prompt: "foreign job",
          recurring: true,
          durable: true,
        },
      ]),
      "utf8"
    );

    const result = await writer.register(makeTask({ id: "task-1" }));

    expect(result.ok).toBe(true);
    // On the next write it is normalized into the `{ tasks: [...] }` envelope, and
    // the foreign entry is preserved (merge, not clobber) — but RESHAPED to a real
    // ClaudeScheduledTaskEntry, not passed through verbatim.
    const entries = readFileEntries();
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toStrictEqual(["foreign", "task-1"]);

    const foreign = entries.find((e) => e.id === "foreign");
    // The legacy `durable:true` is read as the compat alias, so native durability
    // survives the migration as `permanent:true`.
    expect(foreign?.permanent).toBe(true);
    // A missing `createdAt` is backfilled to a real millisecond epoch, so every
    // written entry satisfies the on-disk contract (`createdAt: number`).
    expect(typeof foreign?.createdAt).toBe("number");
    expect(Number.isNaN(foreign?.createdAt)).toBe(false);
    // The legacy `durable` key itself is dropped (it lives on as `permanent`) —
    // only the Claude-Code core fields are re-emitted.
    expect(Object.keys(foreign ?? {}).includes("durable")).toBe(false);
  });

  it("register preserves a neighbor's `lastFiredAt` recurrence cursor and native `createdAt` across the rewrite", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    // A native entry Claude already fired once: it carries both an original
    // `createdAt` and a `lastFiredAt` cursor Claude uses to compute the next fire.
    const nativeCreatedAt = Date.parse("2026-01-01T00:00:00.000Z");
    const nativeLastFired = Date.parse("2026-07-01T00:00:00.000Z");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        tasks: [
          {
            id: "foreign",
            cron: "0 0 * * *",
            prompt: "already fired",
            createdAt: nativeCreatedAt,
            recurring: true,
            permanent: true,
            lastFiredAt: nativeLastFired,
          },
        ],
      }),
      "utf8"
    );

    await writer.register(makeTask({ id: "task-1" }));

    const foreign = readFileEntries().find((e) => e.id === "foreign");
    // Both the cursor and the ORIGINAL native createdAt survive verbatim — dropping
    // either would let Claude immediately re-fire already-run recurring work.
    expect(foreign?.lastFiredAt).toBe(nativeLastFired);
    expect(foreign?.createdAt).toBe(nativeCreatedAt);
  });

  it("re-registering a task preserves Claude's native createdAt and lastFiredAt (no re-fire of completed work)", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    // First materialization writes the Closedloop-derived createdAt and no cursor.
    await writer.register(makeTask({ id: "task-1" }));
    const first = readFileEntries().find((e) => e.id === "task-1");
    expect(first?.createdAt).toBe(Date.parse("2026-07-24T00:00:00.000Z"));
    expect(first?.lastFiredAt).toBeUndefined();

    // Simulate Claude firing the entry once, stamping its own cursor and having set
    // its own (earlier) native createdAt — as Claude ≥2.1.206 would on disk.
    const nativeCreatedAt = Date.parse("2026-01-01T00:00:00.000Z");
    const nativeLastFired = Date.parse("2026-07-24T09:00:00.000Z");
    const raw = readFileJson() as { tasks: ClaudeScheduledTaskEntry[] };
    raw.tasks = raw.tasks.map((t) =>
      t.id === "task-1"
        ? { ...t, createdAt: nativeCreatedAt, lastFiredAt: nativeLastFired }
        : t
    );
    writeFileSync(filePath, JSON.stringify(raw), "utf8");

    // A same-id re-register (e.g. a cron edit, or the startup reconciliation pass)
    // must PRESERVE Claude's own createdAt and lastFiredAt rather than overwriting
    // them with the (later) Closedloop createdAt — else the next recurring fire,
    // computed as `lastFiredAt ?? createdAt`, would rewind and re-run completed work.
    await writer.register(makeTask({ id: "task-1", cron: "30 9 * * *" }));

    const merged = readFileEntries().find((e) => e.id === "task-1");
    expect(merged?.cron).toBe("30 9 * * *");
    expect(merged?.createdAt).toBe(nativeCreatedAt);
    expect(merged?.lastFiredAt).toBe(nativeLastFired);
  });

  it("register rejects an envelope whose `tasks` is present but not an array (Zod-validated shape)", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    await writer.register(makeTask({ id: "seed" }));
    // An object envelope whose `tasks` is a non-array — a malformed shape the Zod
    // schema does not recognize. Overwriting could delete unrelated data, so the
    // registration fails and the file is left untouched.
    const original = JSON.stringify({ tasks: { not: "an array" } });
    writeFileSync(filePath, original, "utf8");

    const result = await writer.register(makeTask({ id: "task-1" }));

    expect(result.ok).toBe(false);
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });

  it("register preserves an envelope's sibling top-level keys across a rewrite", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    // A `{ tasks: [...] }` envelope that also carries an unrelated top-level key a
    // foreign/future tool stored beside `tasks`. Rewriting must not clobber it.
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      JSON.stringify({
        tasks: [
          {
            id: "foreign",
            cron: "0 0 * * *",
            prompt: "foreign job",
            createdAt: 1_700_000_000_000,
            recurring: true,
          },
        ],
        schemaVersion: 7,
        foreignMetadata: { owner: "some-other-tool" },
      }),
      "utf8"
    );

    const result = await writer.register(makeTask({ id: "task-1" }));

    expect(result.ok).toBe(true);
    const parsed = readFileJson() as Record<string, unknown>;
    // The sibling keys survive the rewrite verbatim.
    expect(parsed.schemaVersion).toBe(7);
    expect(parsed.foreignMetadata).toStrictEqual({ owner: "some-other-tool" });
    // And both entries are still present in the normalized envelope.
    const ids = readFileEntries()
      .map((e) => e.id)
      .sort();
    expect(ids).toStrictEqual(["foreign", "task-1"]);
  });

  it("register FAILS and preserves an UNRECOGNIZED file shape (foreign data)", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    await writer.register(makeTask({ id: "seed" }));
    // Neither a bare array nor a `{ tasks: [...] }` envelope — a shape we do not
    // model (e.g. a foreign tool's `{ schedules: {...} }`). Overwriting could
    // delete that data, so registration fails and the file is left untouched.
    const original = JSON.stringify({ schedules: { keep: true } });
    writeFileSync(filePath, original, "utf8");

    const result = await writer.register(makeTask({ id: "task-1" }));

    expect(result.ok).toBe(false);
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });

  it("register rejects a task with a non-local timezone (unrepresentable)", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    const task = makeTask({ timezone: "America/New_York" });

    const result = await writer.register(task);

    // A Claude entry has no timezone field; projecting would fire at the wrong
    // wall-clock time, so the writer rejects it and writes nothing.
    expect(result.ok).toBe(false);
    expect(existsSync(filePath)).toBe(false);
  });

  it("register rejects a task with an empty prompt (not a runnable Claude job)", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    const task = makeTask({ prompt: "" });

    const result = await writer.register(task);

    expect(result.ok).toBe(false);
    expect(existsSync(filePath)).toBe(false);
  });

  it("register creates a private (0600) file and preserves an existing mode", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });

    await writer.register(makeTask({ id: "task-1" }));
    // A brand-new file is owner-only (0600), never widened by umask to 0644.
    expect(permBits(filePath)).toBe(0o600);

    // Loosen it, then re-register: the writer preserves the existing target mode
    // rather than resetting it (or silently re-widening via umask).
    chmodSync(filePath, 0o640);
    await writer.register(makeTask({ id: "task-1", cron: "30 9 * * *" }));
    expect(permBits(filePath)).toBe(0o640);
  });

  it("written file round-trips as the shape Claude Code's reader loads (tasks array of CronTasks)", async () => {
    const writer = createScheduledTasksWriter({ path: filePath });
    await writer.register(makeTask({ id: "task-1", cron: "0 9 * * *" }));

    // Model Claude Code's reader (`src/utils/cronTasks.ts`): it parses the file,
    // returns `file.tasks` when it is an array, else `[]` (zero jobs). Emulating
    // that here proves a real runtime would load our entry (the FEA-4054 bug was
    // that a bare array made this resolve to `undefined` ⇒ zero jobs).
    const parsed = readFileJson() as { tasks?: unknown };
    const loaded = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    expect(loaded.length).toBe(1);

    const job = loaded[0] as ClaudeScheduledTaskEntry;
    expect(job.id).toBe("task-1");
    expect(job.cron).toBe("0 9 * * *");
    expect(typeof job.createdAt).toBe("number");
    expect(Number.isNaN(job.createdAt)).toBe(false);
  });

  it("register honors the CLAUDE_HOME override for the default path", async () => {
    const prev = process.env.CLAUDE_HOME;
    const home = join(dir, "custom-home");
    process.env.CLAUDE_HOME = home;
    try {
      // No explicit path ⇒ resolves via CLAUDE_HOME, not the operator's real home.
      const writer = createScheduledTasksWriter();
      const result = await writer.register(makeTask({ id: "task-1" }));

      expect(result.ok).toBe(true);
      expect(existsSync(join(home, "scheduled_tasks.json"))).toBe(true);
    } finally {
      if (prev === undefined) {
        Reflect.deleteProperty(process.env, "CLAUDE_HOME");
      } else {
        process.env.CLAUDE_HOME = prev;
      }
    }
  });
});
