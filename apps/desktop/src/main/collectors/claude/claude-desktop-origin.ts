/**
 * @file claude-desktop-origin.ts
 * @description ISS-7198: the Claude Desktop session-origin sidecar reader.
 *
 * Claude Desktop launches real Claude Code sessions and writes their transcripts
 * to the same `~/.claude/projects` tree a terminal launch uses — so the collector
 * already ingests them, and a Desktop-launched session is INDISTINGUISHABLE from
 * a terminal one. The only local record that it came from the app is a sidecar
 * the app writes elsewhere:
 *
 *   ~/Library/Application Support/Claude/claude-code-sessions/<orgId>/<userId>/local_<uuid>.json
 *
 * `cliSessionId` inside it is the join key onto that transcript. No new harness
 * collector: the transcript is already a source, so a sixth would double-count it.
 *
 * ABSENT IS ABSENT. A missing directory, no matching sidecar, an unreadable file,
 * and an undecodable one all produce NO origin — the session imports unattributed.
 * A fabricated default would destroy the distinction this module exists to make.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_METADATA_STRING_CHARS } from "@repo/lib/agent-sessions/metadata-preview";
import type { ClaudeDesktopOrigin } from "@repo/lib/harness/types";
import { z } from "zod";
import { yieldToEventLoop } from "../engine/cooperative-yield.js";
import { HistoricalParseWorkerLimits } from "../engine/historical-parse-worker-limits-and-clamping.js";

/** Env override for the sidecar root — the seam tests and non-macOS layouts use. */
export const CLAUDE_DESKTOP_SESSIONS_HOME_ENV = "CLAUDE_DESKTOP_SESSIONS_HOME";

/**
 * Ceiling on sidecar files admitted into one index build — the index is keyed on
 * external filesystem content, so it needs a bound. Far above any plausible
 * Desktop history; stopping costs attribution on the overflow, never the import.
 */
const MAX_SIDECAR_FILES = 20_000;

/**
 * Floor on how often {@link ClaudeDesktopOriginIndex.refresh} rebuilds, so a
 * pass that calls the batch seam repeatedly does not re-walk the tree each time.
 *
 * ONLY `refresh` consults it, and a batch-driven index never rebuilds anywhere
 * else: `extraMtime` runs once per source inside the main-process scan loop, so
 * a TTL checked there would re-read the whole tree, synchronously, several times
 * per pass on a large history. An UNBATCHED reader does rebuild from its
 * accessors, but on evidence rather than on this timer — see
 * {@link staleForCliSession}, which is exact where a TTL would be both too eager
 * (rescanning a settled tree) and too late (serving a stale answer inside the
 * window, which is how the change became permanent).
 */
const REFRESH_TTL_MS = 5000;

/** Sidecar files decoded between cooperative yields during {@link refresh}. */
const REFRESH_YIELD_EVERY = 256;

/**
 * Ceiling on a sidecar file's SIZE, applied from its `stat` BEFORE the file is
 * ever read. The read is synchronous and runs on the Electron main process, so
 * an oversized `local_*.json` — hand-edited, corrupt, or a log accidentally
 * written to the path — would block or OOM the app before any parse-time bound
 * could apply.
 *
 * Far above the real shape (the verified sidecar is a few hundred bytes; the
 * largest member Desktop ships is a small MCP-server array), so rejecting above
 * it costs attribution only for a file that is already not a sidecar. Rejected
 * files are memoized like any other undecodable one, so an oversized file is
 * `stat`ed once per build and never read.
 */
export const MAX_SIDECAR_BYTES = 256 * 1024;

const SIDECAR_FILE_PREFIX = "local_";
const SIDECAR_FILE_SUFFIX = ".json";

/**
 * Ceiling on every id-shaped member, pinned to the worker boundary's own
 * short-text cap so nothing this decoder admits can be rejected downstream.
 *
 * The bound REJECTS rather than truncates, unlike {@link boundedTitle}: an id is
 * identity, and a truncated one is a different id that could collide with a real
 * session. So an over-long id makes the whole sidecar undecodable and the session
 * imports unattributed — which is the module's stated contract. Without it, an
 * over-long id decodes here and then fails the `.strict()` worker-response
 * schema, which rejects the ENTIRE response and drops every session in that
 * source, re-dropping on each retry.
 */
export const MAX_SIDECAR_ID_CHARS =
  HistoricalParseWorkerLimits.maxShortTextLength;

/**
 * Deliberately NOT `.strict()`: Claude Desktop owns this format and ships fields
 * we do not model, so rejecting an unknown key would turn the next Desktop
 * release into a total loss of attribution. The file's `permissionMode` is NOT
 * read — `NormalizedSession.permissionMode` already carries it.
 */
const claudeDesktopSidecarSchema = z.object({
  sessionId: z.string().min(1).max(MAX_SIDECAR_ID_CHARS),
  cliSessionId: z.string().min(1).max(MAX_SIDECAR_ID_CHARS),
  title: z.string().optional(),
  scheduledTaskId: z.string().max(MAX_SIDECAR_ID_CHARS).optional(),
  isArchived: z.boolean().optional(),
  lastActivityAt: z.number().optional(),
});

/** A decoded sidecar plus the provenance the index needs to pick between duplicates. */
type IndexedOrigin = {
  origin: ClaudeDesktopOrigin;
  /** Desktop's own activity clock — the primary tiebreak between two sidecars. */
  lastActivityAt: number;
  /** File mtime — the catchup-cache input, and the second tiebreak. */
  mtimeMs: number;
  /** Size, paired with the mtime as the file identity the memo keys on. */
  size: number;
  /** The file this entry came from — what an unbatched reader re-`stat`s. */
  filePath: string;
};

/**
 * `lookup` answers the enrichment; `mtimeFor` answers the catchup cache, so a
 * sidecar-only write still re-imports rather than leaving the linkage stale until
 * an unrelated edit — the ISS-4592 `.meta.json` staleness trap, in a second place.
 *
 * ONCE `refresh` HAS BEEN CALLED the accessors are pure snapshot reads and never
 * scan: the collector drives `refresh` from `prepareSourceBatch`, the seam the
 * collectors' AGENTS.md reserves for exactly this ("precompute source-set
 * metadata once per batch … instead of reading all source metadata from each
 * per-source hook"), and the one the Codex rollout-linkage graph already uses.
 *
 * UNTIL then the accessors self-invalidate, because the utility-process worker
 * (`engine/historical-parse-source.ts`) caches ONE collector for the life of the
 * process and calls `parse` directly — it has no batch seam to drive. Left as a
 * pure snapshot there, the worker would answer every parse from its boot-time
 * build: the main process WOULD notice a sidecar edit (its `extraMtime` moves)
 * and re-send the source, the worker would return the boot-time origin anyway,
 * and the catchup cache would then advance past the change — making a stale
 * title or archived flag PERMANENT rather than eventually-consistent. The
 * self-invalidation is deliberately cheap and exact rather than a timer: see
 * {@link staleForCliSession}.
 */
export type ClaudeDesktopOriginIndex = {
  /**
   * Whether a sidecar tree is being read at all. `false` for golden mode and for
   * a host with no verified layout — the collector needs the distinction because
   * "no sidecar for this session" and "not looking for sidecars" fold into the
   * catchup fingerprint differently.
   */
  readonly enabled: boolean;
  lookup(cliSessionId: string): ClaudeDesktopOrigin | null;
  mtimeFor(cliSessionId: string): number | null;
  refresh(): Promise<void>;
};

/**
 * The sidecar root for this host, or `null` when there is none to read. macOS-only
 * by default — Windows/Linux Claude Desktop has no verified layout, and an
 * explicit no-op there is truthful where a guessed path would not be. The env
 * override applies on every platform, so a verified layout needs no new branch.
 */
export function getClaudeDesktopSessionsDir(): string | null {
  const override = process.env[CLAUDE_DESKTOP_SESSIONS_HOME_ENV];
  if (override) {
    return override;
  }
  if (process.platform !== "darwin") {
    return null;
  }
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions"
  );
}

/**
 * Build a lazily-refreshed join index. `sessionsDir: null` disables the reader
 * outright — how a hermetic caller (golden mode) states that a host sidecar tree
 * must never influence a staged corpus, rather than relying on an empty one.
 */
export function createClaudeDesktopOriginIndex(
  options: {
    sessionsDir?: string | null;
    ttlMs?: number;
    now?: () => number;
    /**
     * Called once per SCAN of the sidecar tree. The per-pass cost of this reader
     * is a behavioral contract — one scan per batch, never one per source — and
     * the collectors' AGENTS.md requires that contract be asserted as a
     * dependency call count rather than as wall-clock timing. This is the seam
     * that count is taken from.
     */
    onScan?: () => void;
  } = {}
): ClaudeDesktopOriginIndex {
  const sessionsDir =
    options.sessionsDir === undefined
      ? getClaudeDesktopSessionsDir()
      : options.sessionsDir;
  const ttlMs = options.ttlMs ?? REFRESH_TTL_MS;
  const now = options.now ?? Date.now;
  const onScan = options.onScan;
  // Survives a rebuild so an unchanged sidecar is re-`stat`ed but never re-read
  // or re-decoded; a refresh over a settled tree is a stat sweep. Pruned to the
  // files this sweep actually saw, so a deleted sidecar cannot pin its entry.
  let decoded = new Map<string, MemoizedOrigin>();
  let entries: Map<string, IndexedOrigin> | null = null;
  let treeShape: TreeShape = EMPTY_TREE_SHAPE;
  let builtAtMs = 0;
  // Latched by the first `refresh`. While it is false nothing is driving this
  // index on a batch boundary, so the accessors must keep themselves honest.
  let batchDriven = false;
  const adopt = (built: OriginIndexBuild): Map<string, IndexedOrigin> => {
    entries = built.index;
    decoded = built.decoded;
    treeShape = built.treeShape;
    builtAtMs = now();
    return built.index;
  };
  const snapshot = (cliSessionId: string): Map<string, IndexedOrigin> => {
    if (sessionsDir === null) {
      return EMPTY_INDEX;
    }
    // Lazy FIRST build, then a rebuild only when this reader owns its own
    // freshness AND something the answer depends on actually moved.
    if (entries === null) {
      return adopt(buildOriginIndex(sessionsDir, decoded, onScan));
    }
    if (batchDriven || !staleForCliSession(entries, treeShape, cliSessionId)) {
      return entries;
    }
    return adopt(buildOriginIndex(sessionsDir, decoded, onScan));
  };
  return {
    enabled: sessionsDir !== null,
    lookup: (cliSessionId: string) =>
      snapshot(cliSessionId).get(cliSessionId)?.origin ?? null,
    mtimeFor: (cliSessionId: string) =>
      snapshot(cliSessionId).get(cliSessionId)?.mtimeMs ?? null,
    refresh: async (): Promise<void> => {
      batchDriven = true;
      if (sessionsDir === null || now() - builtAtMs < ttlMs) {
        return;
      }
      adopt(await buildOriginIndexCooperatively(sessionsDir, decoded, onScan));
    },
  };
}

/**
 * Whether an unbatched reader's answer for ONE cli session may have moved since
 * the build, decided with a handful of `stat`s rather than a rescan.
 *
 * Two signals, because neither alone is sufficient and a TTL is neither:
 *
 * - **The entry's own file**, when there is one. An IN-PLACE edit (the Desktop
 *   title rename, the archive toggle) changes the file's mtime/size and NOTHING
 *   else in the tree — no directory mtime moves — so only re-`stat`ing the file
 *   this answer came from can see it. A deleted file is caught here too.
 * - **The directories the build walked.** Creating or removing an entry bumps
 *   its immediate parent's mtime (POSIX), and a directory that itself appeared
 *   bumped ITS parent, so re-`stat`ing just the known dirs detects any addition
 *   or removal anywhere beneath the root. This is what sees a sidecar arriving
 *   for a session that has none — the case an entry check cannot cover, because
 *   there is no entry to check.
 *
 * Cost is O(1) plus one `stat` per sidecar directory (three on a real host),
 * against O(files) for a rescan — and a rescan happens only when one of these
 * says something changed, never on a timer.
 */
function staleForCliSession(
  entries: ReadonlyMap<string, IndexedOrigin>,
  treeShape: TreeShape,
  cliSessionId: string
): boolean {
  const entry = entries.get(cliSessionId);
  if (entry && fileIdentityMoved(entry)) {
    return true;
  }
  return fingerprintDirs(treeShape.dirs) !== treeShape.fingerprint;
}

/** True when the file behind an entry is gone, or is no longer the one decoded. */
function fileIdentityMoved(entry: IndexedOrigin): boolean {
  try {
    const stat = statSync(entry.filePath);
    return stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.size;
  } catch {
    return true;
  }
}

const EMPTY_INDEX: Map<string, IndexedOrigin> = new Map();

/** Read a directory's entries, returning `[]` on any IO/permission error. */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Enumerate the sidecar files under `<root>/<orgId>/<userId>/`, capped, and
 * report the directories walked so an unbatched reader can detect an addition
 * or removal without re-walking them.
 */
function scanSidecarTree(sessionsDir: string): SidecarScan {
  const files: string[] = [];
  const dirs: string[] = [sessionsDir];
  for (const orgId of safeReaddir(sessionsDir)) {
    const orgDir = path.join(sessionsDir, orgId);
    dirs.push(orgDir);
    for (const userId of safeReaddir(orgDir)) {
      const userDir = path.join(orgDir, userId);
      dirs.push(userDir);
      for (const fileName of safeReaddir(userDir)) {
        if (files.length >= MAX_SIDECAR_FILES) {
          return { files, treeShape: shapeOf(dirs) };
        }
        if (
          fileName.startsWith(SIDECAR_FILE_PREFIX) &&
          fileName.endsWith(SIDECAR_FILE_SUFFIX)
        ) {
          files.push(path.join(userDir, fileName));
        }
      }
    }
  }
  return { files, treeShape: shapeOf(dirs) };
}

/** Synchronous build — the lazy first one, and an unbatched reader's rebuild. */
function buildOriginIndex(
  sessionsDir: string,
  memo: ReadonlyMap<string, MemoizedOrigin>,
  onScan: (() => void) | undefined
): OriginIndexBuild {
  onScan?.();
  const scan = scanSidecarTree(sessionsDir);
  const build = startBuild(memo, scan.treeShape);
  for (const filePath of scan.files) {
    admitOriginFile(build, filePath);
  }
  return build;
}

/**
 * The same build, yielding to the event loop every {@link REFRESH_YIELD_EVERY}
 * files (FEA-2264's discipline, via the `prepareSourceBatch` seam). This is the
 * path a real pass takes, so a large sidecar tree cannot block the main thread.
 */
async function buildOriginIndexCooperatively(
  sessionsDir: string,
  memo: ReadonlyMap<string, MemoizedOrigin>,
  onScan: (() => void) | undefined
): Promise<OriginIndexBuild> {
  onScan?.();
  const scan = scanSidecarTree(sessionsDir);
  const build = startBuild(memo, scan.treeShape);
  let sinceYield = 0;
  for (const filePath of scan.files) {
    if (++sinceYield >= REFRESH_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
    admitOriginFile(build, filePath);
  }
  return build;
}

/** A decode memoized against the file identity that produced it. */
type MemoizedOrigin = {
  mtimeMs: number;
  size: number;
  /** `null` records a file that decoded to nothing, so it is not re-read either. */
  indexed: { cliSessionId: string; indexed: IndexedOrigin } | null;
};

/** One build's outputs: the join index, plus the memo to carry into the next. */
type OriginIndexBuild = {
  index: Map<string, IndexedOrigin>;
  decoded: Map<string, MemoizedOrigin>;
  previous: ReadonlyMap<string, MemoizedOrigin>;
  treeShape: TreeShape;
};

/** What one tree walk found: the sidecar files, and the shape to re-check. */
type SidecarScan = { files: string[]; treeShape: TreeShape };

/**
 * The directories a build walked plus their mtimes at that moment. Comparing a
 * freshly computed fingerprint against the stored one detects any sidecar
 * created or removed anywhere under the root, for the cost of one `stat` per
 * directory. It does NOT see an in-place edit — that is
 * {@link fileIdentityMoved}'s half of the job.
 */
type TreeShape = { dirs: readonly string[]; fingerprint: string };

const EMPTY_TREE_SHAPE: TreeShape = { dirs: [], fingerprint: "" };

const TREE_SHAPE_DELIM = String.fromCharCode(0);

function shapeOf(dirs: readonly string[]): TreeShape {
  return { dirs, fingerprint: fingerprintDirs(dirs) };
}

/** `-1` for a directory that is gone, so a removal reads as a change. */
function fingerprintDirs(dirs: readonly string[]): string {
  const parts: string[] = [];
  for (const dir of dirs) {
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(dir).mtimeMs;
    } catch {
      /* absent or unreadable — recorded as such, not skipped */
    }
    parts.push(`${dir}${TREE_SHAPE_DELIM}${mtimeMs}`);
  }
  return parts.join(TREE_SHAPE_DELIM);
}

function startBuild(
  memo: ReadonlyMap<string, MemoizedOrigin>,
  treeShape: TreeShape
): OriginIndexBuild {
  return { index: new Map(), decoded: new Map(), previous: memo, treeShape };
}

/**
 * Decode one sidecar, keeping the newest when two claim the same CLI session
 * (Desktop can relaunch one under a new local id). Ordered by Desktop's own
 * activity clock so the winner never depends on enumeration order.
 *
 * A file whose mtime and size both match the previous build is taken from the
 * memo rather than re-read, so a refresh over a settled tree costs one `stat`
 * per file. The memo is rebuilt from the files this sweep saw, which is what
 * bounds it and what lets a deleted sidecar drop out.
 */
function admitOriginFile(build: OriginIndexBuild, filePath: string): void {
  let mtimeMs: number;
  let size: number;
  try {
    const stat = statSync(filePath);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    return;
  }
  const memoized = build.previous.get(filePath);
  const decoded =
    memoized && memoized.mtimeMs === mtimeMs && memoized.size === size
      ? memoized.indexed
      : decodeAdmissibleFile(filePath, mtimeMs, size);
  build.decoded.set(filePath, { mtimeMs, size, indexed: decoded });
  if (decoded === null) {
    return;
  }
  build.index.set(
    decoded.cliSessionId,
    pickNewer(build.index.get(decoded.cliSessionId), decoded.indexed)
  );
}

/**
 * TOTAL comparison, so a rebuild converges on the same winner no matter what
 * order the filesystem enumerated the two files in.
 *
 * Both clocks can tie — two sidecars written in the same millisecond, or two
 * that never recorded a `lastActivityAt` at all, both of which collapse to
 * `0` — and returning the incumbent on a tie would hand the answer to directory
 * enumeration order. The last step is therefore derived from the decoded CONTENT,
 * which is defined for every pair. Which side of that comparison wins is
 * arbitrary; that it is the same side on every rebuild is the point.
 */
function pickNewer(
  incumbent: IndexedOrigin | undefined,
  candidate: IndexedOrigin
): IndexedOrigin {
  if (!incumbent) {
    return candidate;
  }
  if (candidate.lastActivityAt !== incumbent.lastActivityAt) {
    return candidate.lastActivityAt > incumbent.lastActivityAt
      ? candidate
      : incumbent;
  }
  if (candidate.mtimeMs !== incumbent.mtimeMs) {
    return candidate.mtimeMs > incumbent.mtimeMs ? candidate : incumbent;
  }
  return originOrderKey(candidate.origin) > originOrderKey(incumbent.origin)
    ? candidate
    : incumbent;
}

/** A total ordering over the decoded origin — every member, so no pair ties. */
function originOrderKey(origin: ClaudeDesktopOrigin): string {
  return [
    origin.sessionId,
    origin.title ?? "",
    origin.scheduledTaskId ?? "",
    origin.archived ? "1" : "0",
  ].join(TREE_SHAPE_DELIM);
}

/**
 * Reject a file too large to be a sidecar from its `stat` alone, BEFORE reading
 * it. See {@link MAX_SIDECAR_BYTES}: the read below is synchronous and can run
 * on the Electron main process.
 */
function decodeAdmissibleFile(
  filePath: string,
  mtimeMs: number,
  size: number
): { cliSessionId: string; indexed: IndexedOrigin } | null {
  if (size > MAX_SIDECAR_BYTES) {
    return null;
  }
  return readOriginFile(filePath, mtimeMs, size);
}

/**
 * `null` when the file is unreadable, not JSON, or missing the two ids the join
 * needs. Bad external data yields NO origin rather than a partially-populated
 * one, so nothing half-decoded can ever be persisted.
 */
function readOriginFile(
  filePath: string,
  mtimeMs: number,
  size: number
): { cliSessionId: string; indexed: IndexedOrigin } | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = claudeDesktopSidecarSchema.safeParse(json);
  if (!parsed.success) {
    return null;
  }
  const sidecar = parsed.data;
  return {
    cliSessionId: sidecar.cliSessionId,
    indexed: {
      origin: {
        sessionId: sidecar.sessionId,
        title: boundedTitle(sidecar.title),
        scheduledTaskId: sidecar.scheduledTaskId?.trim() || null,
        archived: sidecar.isArchived === true,
      },
      lastActivityAt: sidecar.lastActivityAt ?? 0,
      mtimeMs,
      size,
      filePath,
    },
  };
}

/**
 * The one FREE-TEXT member — user content, not an id or a closed enum. Capped at
 * the same ceiling the sync/persist boundary applies to a generic metadata
 * string, so no later layer silently re-truncates it. Blank reads as `null`, not
 * `""`, which would render as a title the user never wrote.
 */
function boundedTitle(title: string | undefined): string | null {
  const trimmed = title?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, MAX_METADATA_STRING_CHARS);
}
