/**
 * @file native-scheduled-tasks.ts
 * @description FEA-3958 / FEA-4069 — the portable, package-owned concrete
 * {@link ScheduledTasksRegistrar} that materializes a crewd task into Claude
 * Code's local `~/.claude/scheduled_tasks.json` (the NATIVE
 * `claude-scheduled-tasks` route), and removes it on deregister.
 *
 * ── Why this lives in `@repo/crewd`, not apps/desktop ───────────────────────
 * The native writer is the concrete owner of a `ScheduledTasksRegistrar`, the
 * scheduler seam crewd itself defines (`routine-registrar.ts`). BOTH surfaces
 * that host the scheduler need it: the desktop DB host (which used to own the
 * only copy) AND the `crewd` CLI daemon (FEA-4069) — the CLI's JSON `TaskStore`
 * had no native writer, so a CLI task flipped to `claude-scheduled-tasks`
 * persisted the intent but was never materialized into Claude's file and never
 * had its native owner confirmed, leaving the daemon to run it locally (the
 * native route was inert end-to-end). Extracting the canonical writer here (the
 * nearest shared module that owns the seam) lets both hosts share ONE
 * implementation of the on-disk shape instead of each carrying a copy; the
 * desktop DB host now imports it DIRECTLY from the
 * `@repo/crewd/native-scheduled-tasks` subpath (`sqlite.ts`) and the former
 * desktop-side writer module was removed. This file is Node-only (`node:fs`), so it
 * lives at the `@repo/crewd/native-scheduled-tasks` subpath and is NEVER
 * value-exported from the renderer-safe root barrel.
 *
 * ── The native on-disk shape (FEA-4054) ─────────────────────────────────────
 * Claude Code's scheduler (`src/utils/cronTasks.ts`) reads this file as an
 * OBJECT envelope, NOT a bare array:
 *
 *     type CronFile = { tasks: CronTask[] }
 *     type CronTask = { id; cron; prompt; createdAt; recurring?; permanent? }
 *
 * Its reader returns `[]` when `file.tasks` is not an array. The crewd task's
 * runtime-only `durable` flag is projected onto Claude Code's own `permanent`
 * field (the native flag that governs whether an entry survives across restarts,
 * per `apps/web/content/docs/mechanisms/scheduled-tasks.mdx`) — NOT dropped: a
 * default `durable:true` task must emit `permanent:true` so the native scheduler
 * keeps it, since native ownership suppresses the local daemon. An earlier
 * revision of this writer emitted a bare top-level array with a `durable` field
 * and no `createdAt` — Claude read `file.tasks` as `undefined` and loaded ZERO
 * jobs, silently no-op'ing every native registration. We now emit the documented
 * `{ "tasks": [ { id, cron, prompt, createdAt, recurring, permanent } ] }` shape,
 * with `createdAt` as a millisecond epoch and `permanent` carrying durability.
 *
 * ── Why a writer, not a client ──────────────────────────────────────────────
 * Claude Code owns its own local scheduler file; there is no API. So this seam
 * simply edits that file directly. The crewd `ScheduledTask` shape is a
 * documented SUPERSET of a Claude Code entry (`model.ts:11-14`): we project down
 * to the Claude-Code-compatible core (`id`, `cron`, `prompt`, `createdAt`,
 * `recurring`, `permanent`) and leave the rest of the crew/Desktop-UX fields out
 * of the native file, rejecting shapes Claude Code cannot faithfully represent
 * (a non-local timezone, an empty prompt) rather than writing a divergent job.
 * Writes are atomic (tmp + rename, mirroring `@repo/crewd/store`'s `write()`) and
 * preserve the target's file mode (private-by-default for a new file). The path
 * honors the `CLAUDE_HOME` override so a relocated Claude install materializes
 * into the file Claude actually reads.
 *
 * A MISSING file is treated as "no entries yet" (an operator who never used
 * Claude Code's scheduler starts fresh), and a LEGACY bare-array file (the
 * malformed output of the pre-FEA-4054 writer, and Claude's own older shape) is
 * normalized to the correct `{ tasks: [...] }` envelope on the next write while
 * its recoverable entries are preserved. Every preserved neighbor entry is itself
 * reshaped to a genuine {@link ClaudeScheduledTaskEntry} (core fields only,
 * `createdAt` backfilled to a millisecond epoch when absent; the old writer's
 * `durable` field read as the compatibility alias for `permanent`; Claude's
 * `lastFiredAt` recurrence cursor preserved verbatim), and any sibling top-level
 * keys a `{ tasks: [...] }` envelope carried beside `tasks` are re-emitted so a
 * foreign tool's extra keys survive the rewrite. But an EXISTING file that cannot
 * be parsed as JSON at all — or whose shape is unrecognized (a primitive, or an
 * envelope whose `tasks` is absent/non-array) — is a failed registration
 * (`ok:false`) that leaves the file UNTOUCHED — silently starting fresh there
 * would delete every unrelated Claude schedule the file still holds.
 *
 * On a re-register of an already-materialized entry, Claude's own `lastFiredAt`
 * cursor and the ORIGINAL native `createdAt` are preserved (Claude computes the
 * next recurring fire from `lastFiredAt ?? createdAt`); `now`/the Closedloop
 * `createdAt` is used only for a FIRST materialization.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { ScheduledTask } from "../model.js";
import type {
  ScheduledTasksRegistrar,
  ScheduledTasksRegistrationResult,
} from "./routine-registrar.js";

/**
 * Restrictive mode for a freshly-created scheduled-tasks file: owner read/write
 * only (`0600`). The temp file is created under the caller's umask (typically
 * `0644` after a `022` umask) and then renamed over the target, so we chmod it
 * explicitly — a schedule file (prompts, cadence) is private operator data and
 * must not widen to group/other-readable just because it did not exist yet.
 */
const PRIVATE_FILE_MODE = 0o600;

/**
 * The Claude-Code-compatible core of a scheduled-tasks entry (the subset we own),
 * matching Claude Code's `CronTask` on-disk shape (`src/utils/cronTasks.ts`):
 * `createdAt` is a millisecond epoch. The crewd runtime-only `durable` flag is
 * projected onto Claude Code's own `permanent` field — the native flag that
 * governs whether the scheduler keeps the entry across restarts — rather than
 * dropped, so a `durable` task survives as the docs promise. `permanent` is
 * optional here because a foreign/legacy entry we merge-preserve may omit it.
 *
 * `lastFiredAt` (FEA-4054) is Claude Code's own recurrence cursor: Claude
 * ≥2.1.206 computes the next recurring fire from `lastFiredAt ?? createdAt`, so
 * this field — and the ORIGINAL native `createdAt` — must be PRESERVED verbatim
 * across our rewrites. Dropping `lastFiredAt`, or replacing a native `createdAt`
 * with the (later) Closedloop `createdAt`, would rewind the cursor and make
 * Claude immediately re-fire recurring work that already ran. Both are optional
 * because a first materialization (or a legacy entry) has never fired yet.
 */
export type ClaudeScheduledTaskEntry = {
  id: string;
  cron: string;
  prompt: string;
  createdAt: number;
  recurring: boolean;
  permanent?: boolean;
  lastFiredAt?: number;
};

/**
 * Claude Code's on-disk envelope for `scheduled_tasks.json`
 * (`type CronFile = { tasks: CronTask[] }`). The scheduler reads `file.tasks`
 * and loads ZERO jobs unless it is an array — a bare top-level array is ignored.
 */
export type ClaudeScheduledTasksFile = {
  tasks: ClaudeScheduledTaskEntry[];
};

export type ScheduledTasksWriterDeps = {
  /**
   * Absolute path to the Claude Code scheduled-tasks file. Defaults to
   * `~/.claude/scheduled_tasks.json`. Injectable so tests point at a temp file
   * (and never touch the operator's real Claude config).
   */
  path?: string;
  /** Key-free diagnostic log sink. */
  log?: (message: string) => void;
};

/**
 * Default location of Claude Code's local scheduled-tasks file. Honors the
 * `CLAUDE_HOME` override (the same resolution the rest of the desktop uses for
 * Claude's config dir, e.g. `claude-home.ts`) so that on an install with a
 * relocated Claude home we materialize into the file Claude Code actually reads —
 * writing to a hardcoded `~/.claude` there would stamp ownership for a file
 * Claude never sees.
 */
export function defaultScheduledTasksPath(): string {
  const claudeHome = process.env.CLAUDE_HOME || join(homedir(), ".claude");
  return join(claudeHome, "scheduled_tasks.json");
}

/** Raised when a task cannot be faithfully represented as a Claude Code entry. */
class UnrepresentableTaskError extends Error {}

/**
 * Project a crewd task down to the Claude-Code-compatible core entry, rejecting
 * shapes Claude Code's `scheduled_tasks.json` cannot faithfully represent so we
 * never write a job with silently different execution/scheduling semantics:
 *
 *   - A Claude entry has NO timezone field — its cron is evaluated in host-local
 *     time. A task pinned to a specific IANA timezone would fire at the wrong
 *     wall-clock time if projected, so we reject a non-empty `timezone` (empty ⇒
 *     host-local, which matches Claude).
 *   - An empty `prompt` is not a runnable Claude job (the editor persists an empty
 *     prompt for non-custom crew passes, whose real work lives in crew fields we
 *     deliberately do not leak); reject it rather than register a no-op.
 *
 * A rejected task stays daemon-owned (the registrar returns `ok:false`, so no
 * owner marker is stamped and the local daemon keeps running it).
 */
function toClaudeEntry(task: ScheduledTask): ClaudeScheduledTaskEntry {
  if (task.timezone.length > 0) {
    throw new UnrepresentableTaskError(
      `task '${task.id}' has a non-local timezone (${task.timezone}); Claude Code scheduled_tasks entries have no timezone field`
    );
  }
  if (task.prompt.length === 0) {
    throw new UnrepresentableTaskError(
      `task '${task.id}' has an empty prompt; Claude Code cannot run an empty scheduled task`
    );
  }
  return {
    id: task.id,
    cron: task.cron,
    prompt: task.prompt,
    // Claude Code stores `createdAt` as a millisecond epoch. The crewd task
    // carries an ISO `createdAt`; convert it, falling back to "now" if the
    // stored value is somehow unparseable so we never write a NaN timestamp.
    createdAt: toEpochMs(task.createdAt),
    recurring: task.recurring,
    // Claude Code's native durability flag is `permanent` — it governs whether
    // the scheduler keeps the entry across restarts. The crewd task's runtime
    // `durable` flag carries that intent (default `true`), so project it onto
    // `permanent` rather than dropping it; a durable task must survive as the
    // docs promise, since native ownership suppresses the local daemon.
    permanent: task.durable,
  };
}

/**
 * Coerce a crewd ISO `createdAt` to the millisecond epoch Claude Code persists.
 * An unparseable value degrades to the current time rather than emitting `NaN`
 * (which would serialize to `null` and confuse Claude's reader).
 */
function toEpochMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.now() : ms;
}

/** Raised when an EXISTING native file cannot be read/parsed safely. */
class UnreadableFileError extends Error {}

/**
 * The result of reading the native file: the normalized entry list to merge
 * against, plus any sibling top-level keys the parsed envelope carried beside
 * `tasks` (a foreign/future tool may store its own keys there). We carry those
 * siblings through so a write RE-EMITS them rather than silently dropping them —
 * a rewrite must preserve, never clobber, unrelated data the file already holds.
 * For a missing file, or a legacy bare-array file (no envelope object), there are
 * no siblings.
 */
type NativeFileRead = {
  entries: ClaudeScheduledTaskEntry[];
  /** Top-level keys other than `tasks` from a recognized envelope object. */
  envelopeSiblings: Record<string, unknown>;
};

/**
 * Read the native file's existing entries so a write can merge (never clobber)
 * the operator's other Claude schedules. A MISSING file returns an empty list —
 * an operator who never used Claude Code's scheduler starts fresh.
 *
 * The current native shape is the `{ "tasks": [...] }` envelope
 * (`src/utils/cronTasks.ts`), and we also RECOGNIZE and normalize the legacy bare
 * top-level array (the pre-FEA-4054 writer's output, and Claude's own older
 * shape) — its entries are preserved and re-emitted inside the envelope on write.
 * Any sibling top-level keys a `{ tasks: [...] }` envelope carries beside `tasks`
 * are captured and re-emitted on write so a foreign tool's extra keys survive.
 *
 * Every preserved neighbor entry is NORMALIZED to a genuine
 * {@link ClaudeScheduledTaskEntry} (core fields only, `createdAt` backfilled to a
 * millisecond epoch when absent/non-numeric), so what {@link writeEntries} writes
 * always satisfies the on-disk contract — not just entries freshly produced by
 * {@link toClaudeEntry}.
 *
 * Two kinds of EXISTING file are a genuine read failure we refuse to touch (we
 * THROW {@link UnreadableFileError}, the caller leaves the file untouched and
 * reports the registration failed): a file that does not PARSE as JSON at all,
 * and a parsed shape we do NOT recognize (a primitive, or an object whose `tasks`
 * is absent or not an array). Overwriting an unrecognized shape could delete
 * unrelated data a future/foreign tool stored there, so we preserve it rather
 * than guess. Individual malformed neighbor entries inside a recognized list are
 * tolerated (skipped) — only a whole-file read/parse/unrecognized-shape failure
 * is fatal.
 */
function readEntries(path: string): NativeFileRead {
  if (!existsSync(path)) {
    return { entries: [], envelopeSiblings: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new UnreadableFileError(
      `existing ${path} is not readable/parseable (${error instanceof Error ? error.message : String(error)})`
    );
  }
  const { rawEntries, envelopeSiblings } = extractRawEntries(path, parsed);
  // Normalize every preserved neighbor to a genuine ClaudeScheduledTaskEntry:
  // require a string id (the minimum to dedupe on; a malformed neighbor never
  // blocks writing our own entry), then pick only the core fields and backfill a
  // missing/non-numeric createdAt — so the written file satisfies the contract.
  const entries: ClaudeScheduledTaskEntry[] = [];
  for (const raw of rawEntries) {
    const normalized = normalizePreservedEntry(raw);
    if (normalized) {
      entries.push(normalized);
    }
  }
  return { entries, envelopeSiblings };
}

/**
 * Reshape a preserved neighbor into a genuine {@link ClaudeScheduledTaskEntry},
 * or return `null` for a shape too malformed to keep (no string id). Parsing goes
 * through {@link preservedEntrySchema} (a Zod schema, per the root AGENTS.md rule
 * to validate unknown object shapes with Zod, not hand-rolled `typeof` + cast).
 * Only the core Claude-Code fields survive; `createdAt` is coerced to a
 * millisecond epoch (backfilled to "now" when absent or non-numeric), Claude's
 * recurrence cursor `lastFiredAt` is preserved verbatim when present, and any
 * extra (non-core) keys the neighbor carried are dropped rather than re-emitted.
 * The pre-FEA-4054 writer emitted `durable` with no `permanent`, so `durable` is
 * read as the compatibility alias for `permanent` when `permanent` is absent
 * (additive/version-skew rule) — a legacy `durable:true` entry survives as
 * `permanent:true`.
 */
function normalizePreservedEntry(
  raw: unknown
): ClaudeScheduledTaskEntry | null {
  const result = preservedEntrySchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  const parsed = result.data;
  const entry: ClaudeScheduledTaskEntry = {
    id: parsed.id,
    cron: parsed.cron,
    prompt: parsed.prompt,
    createdAt: Number.isFinite(parsed.createdAt)
      ? parsed.createdAt
      : Date.now(),
    recurring: parsed.recurring,
  };
  // `permanent` is optional on disk; carry it through only when the neighbor
  // set it, OR fall back to the legacy `durable` alias the pre-FEA-4054 writer
  // emitted. Preserve omission — a durability flag we never observed must not be
  // invented as `false`.
  const permanent = parsed.permanent ?? parsed.durable;
  if (permanent !== undefined) {
    entry.permanent = permanent;
  }
  // Preserve Claude's own recurrence cursor verbatim when the neighbor carries a
  // finite one — dropping it would rewind the next-fire computation.
  if (parsed.lastFiredAt !== undefined && Number.isFinite(parsed.lastFiredAt)) {
    entry.lastFiredAt = parsed.lastFiredAt;
  }
  return entry;
}

/**
 * Pull the entry list (and any sibling top-level keys) out of a RECOGNIZED native
 * shape on disk: the canonical `{ tasks: [...] }` envelope, or a legacy bare
 * array. Parsing goes through {@link nativeFileShapeSchema} (Zod, not a hand-rolled
 * `typeof` + cast). Any other shape (a primitive, or an envelope with an
 * absent/non-array `tasks`) is unrecognized — we THROW rather than silently start
 * fresh, so a write cannot delete unrelated data a foreign tool may have stored
 * under a shape we do not model.
 */
function extractRawEntries(
  path: string,
  parsed: unknown
): { rawEntries: unknown[]; envelopeSiblings: Record<string, unknown> } {
  const result = nativeFileShapeSchema.safeParse(parsed);
  if (!result.success) {
    throw new UnreadableFileError(
      `existing ${path} is neither a { tasks: [...] } envelope nor a legacy array; refusing to overwrite it`
    );
  }
  const shape = result.data;
  if (shape.kind === "array") {
    return { rawEntries: shape.tasks, envelopeSiblings: {} };
  }
  return { rawEntries: shape.tasks, envelopeSiblings: shape.envelopeSiblings };
}

/**
 * Atomically write the entries array (tmp + rename), creating the dir if absent.
 * The temp file inherits the caller's umask, so we chmod it to the PRESERVED mode
 * of the existing target (a private schedule file must stay private) or, for a
 * brand-new file, to {@link PRIVATE_FILE_MODE} — never leaving it group/other
 * readable just because a `022` umask would.
 *
 * Any `envelopeSiblings` read from the existing file are carried through so a
 * foreign tool's extra top-level keys survive the rewrite; the canonical `tasks`
 * key is written LAST so it always wins over a stale sibling of the same name.
 */
function writeEntries(
  path: string,
  entries: ClaudeScheduledTaskEntry[],
  envelopeSiblings: Record<string, unknown> = {}
): void {
  mkdirSync(dirname(path), { recursive: true });
  const targetMode = existingFileMode(path);
  const tmp = `${path}.tmp-${process.pid}`;
  // Always serialize the canonical `{ tasks: [...] }` envelope Claude Code reads,
  // normalizing any legacy bare-array/short-envelope file on write and preserving
  // any sibling top-level keys the prior envelope carried.
  const file: ClaudeScheduledTasksFile & Record<string, unknown> = {
    ...envelopeSiblings,
    tasks: entries,
  };
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  chmodSync(tmp, targetMode);
  renameSync(tmp, path);
}

/**
 * The permission bits to stamp onto a written file: the existing target's mode
 * (preserving whatever the operator/Claude set) or {@link PRIVATE_FILE_MODE} for
 * a file that does not exist yet. Falls back to the private default if the target
 * cannot be stat'd.
 */
function existingFileMode(path: string): number {
  if (!existsSync(path)) {
    return PRIVATE_FILE_MODE;
  }
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: masking the permission bits out of a stat mode requires bitwise AND
    return statSync(path).mode & 0o777;
  } catch {
    return PRIVATE_FILE_MODE;
  }
}

/**
 * Create a concrete {@link ScheduledTasksRegistrar} backed by Claude Code's local
 * `~/.claude/scheduled_tasks.json`. `register` upserts the task's core entry (by
 * id) and returns `ok:true` with the written entry id so the store stamps the
 * confirmed-owner marker; `deregister` removes the entry by id. Both are
 * best-effort — a filesystem failure resolves `ok:false` rather than rejecting.
 */
export function createScheduledTasksWriter(
  deps: ScheduledTasksWriterDeps = {}
): ScheduledTasksRegistrar {
  const path = deps.path ?? defaultScheduledTasksPath();
  const log = deps.log ?? (() => {});

  const register = (
    task: ScheduledTask
  ): Promise<ScheduledTasksRegistrationResult> => {
    try {
      // Project first so an unrepresentable task is rejected BEFORE we read/touch
      // the file, and a genuine existing-file read failure leaves it untouched
      // (both throw ⇒ ok:false; no owner marker ⇒ the daemon keeps the task).
      const entry = toClaudeEntry(task);
      const { entries, envelopeSiblings } = readEntries(path);
      const existing = entries.find((e) => e.id === entry.id);
      const others = entries.filter((e) => e.id !== entry.id);
      // On a re-register of an already-materialized entry, PRESERVE Claude's own
      // recurrence cursor (`lastFiredAt`) and the ORIGINAL native `createdAt`
      // rather than overwriting them with the (later) Closedloop `createdAt`.
      // Claude ≥2.1.206 computes the next recurring fire from
      // `lastFiredAt ?? createdAt`, so replacing either would rewind the cursor
      // and immediately re-fire work that already ran. `now` is only used for the
      // FIRST materialization (no existing native entry) via `toClaudeEntry`.
      const merged = mergeNativeCursor(entry, existing);
      writeEntries(path, [...others, merged], envelopeSiblings);
      return Promise.resolve({ ok: true, ownerId: merged.id });
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      log(`scheduled-tasks-writer: register '${task.id}' failed: ${note}`);
      return Promise.resolve({ ok: false, note });
    }
  };

  const deregister = (
    task: ScheduledTask
  ): Promise<ScheduledTasksRegistrationResult> => {
    try {
      const { entries, envelopeSiblings } = readEntries(path);
      const remaining = entries.filter((e) => e.id !== task.id);
      // Only rewrite when the entry was actually present, so a deregister of a
      // task that was never materialized (or a missing file) is a clean no-op.
      if (remaining.length !== entries.length) {
        writeEntries(path, remaining, envelopeSiblings);
      }
      return Promise.resolve({ ok: true });
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      log(`scheduled-tasks-writer: deregister '${task.id}' failed: ${note}`);
      return Promise.resolve({ ok: false, note });
    }
  };

  return { register, deregister };
}

/**
 * Merge a freshly-projected entry with the EXISTING native entry of the same id
 * (if one is already materialized), preserving Claude Code's own recurrence
 * bookkeeping: its original `createdAt` and its `lastFiredAt` cursor. Claude
 * ≥2.1.206 computes the next recurring fire from `lastFiredAt ?? createdAt`, so a
 * re-register (a cron/prompt edit, or the startup reconciliation pass) must NOT
 * overwrite those with the (later) Closedloop `createdAt` — doing so would rewind
 * the cursor and immediately re-fire work that already ran. When there is no
 * existing native entry this is a first materialization: `entry`'s own
 * `createdAt` (the Closedloop-derived "now") stands, and there is no cursor yet.
 */
function mergeNativeCursor(
  entry: ClaudeScheduledTaskEntry,
  existing: ClaudeScheduledTaskEntry | undefined
): ClaudeScheduledTaskEntry {
  if (!existing) {
    return entry;
  }
  const merged: ClaudeScheduledTaskEntry = {
    ...entry,
    // Keep the ORIGINAL native creation timestamp — it is the recurrence-cursor
    // fallback, not a display value we may freely refresh.
    createdAt: existing.createdAt,
  };
  if (existing.lastFiredAt !== undefined) {
    merged.lastFiredAt = existing.lastFiredAt;
  }
  return merged;
}

/**
 * Zod schema for a preserved neighbor entry read off disk. Validates the unknown
 * on-disk object shape (root AGENTS.md mandates Zod over hand-rolled `typeof` +
 * cast). Only `id` is required (the minimum to dedupe on); every other field is
 * optional/defaulted so a legacy or foreign entry that predates a field still
 * parses. `durable` is accepted as the pre-FEA-4054 compatibility alias for
 * `permanent`. Unknown keys are stripped (Zod's default), so non-core fields are
 * dropped rather than re-emitted.
 */
const preservedEntrySchema = z.object({
  id: z.string(),
  cron: z.string().catch(""),
  prompt: z.string().catch(""),
  // A missing/non-numeric createdAt yields NaN, which the caller backfills to
  // "now"; a valid epoch is preserved verbatim.
  createdAt: z.number().catch(Number.NaN),
  recurring: z.boolean().catch(false),
  permanent: z.boolean().optional().catch(undefined),
  /** Pre-FEA-4054 compatibility alias for `permanent` (old writer emitted this). */
  durable: z.boolean().optional().catch(undefined),
  /** Claude's own recurrence cursor; preserved verbatim when present. */
  lastFiredAt: z.number().optional().catch(undefined),
});

/**
 * Zod schema for the RECOGNIZED native file shapes: the canonical
 * `{ tasks: [...] }` envelope (with any sibling top-level keys captured) or a
 * legacy bare top-level array. Any other shape fails to parse and the caller
 * treats it as an unreadable file (leaves it untouched). Replaces the prior
 * hand-rolled `Array.isArray` + `typeof` + cast checks with a validated union.
 */
const nativeFileShapeSchema = z.union([
  z
    .array(z.unknown())
    .transform((tasks) => ({ kind: "array" as const, tasks })),
  z
    .object({ tasks: z.array(z.unknown()) })
    .catchall(z.unknown())
    .transform(({ tasks, ...envelopeSiblings }) => ({
      kind: "envelope" as const,
      tasks,
      envelopeSiblings,
    })),
]);
