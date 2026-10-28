/**
 * @file claude-collector.ts
 * @description Claude Code harness collector descriptor (FEA-1503). Claude is the
 * only harness with a live hook path, so its live file watcher is gated OFF by the
 * CollectorManager whenever hooks are installed — the routing decision is owned by
 * `getActiveCollectionMode` (FEA-1839) (hooks own live capture; a concurrent
 * watcher would double-count turns). Historical import remains idempotent
 * against any hook-written events.
 */
import { statSync } from "node:fs";
import path from "node:path";
import type { NormalizedParseQuality } from "@repo/lib/harness/parse-quality";
import type { FileHarnessCollector, NormalizedSession } from "../types.js";
import {
  type ClaudeDesktopOriginIndex,
  createClaudeDesktopOriginIndex,
} from "./claude-desktop-origin.js";
import {
  getProjectsDir,
  listAllTranscriptFiles,
  sessionIdFromTranscriptPath,
  walkSubagentTranscripts,
} from "./claude-home.js";
import { parseSessionFile } from "./claude-parser.js";
import { subagentMetaPathFor } from "./claude-subagent-meta.js";

const PATH_SEGMENT_SEPARATOR_RE = /[\\/]+/;

/**
 * FEA-2648: source/root overrides mirroring `CreateCodexCollectorOptions`, used
 * by golden mode to point the real collector at a staged corpus tree. Both
 * default to the live `~/.claude` layout, so an argless call is unchanged. The
 * remaining path-derived members (`sourcePathsForWatchEvent`, `sessionIdForSource`,
 * `extraMtime`) operate on the path they are handed and need no override.
 */
export type CreateClaudeCollectorOptions = {
  listSources?: () => string[];
  watchRoots?: () => string[];
  /**
   * Where the parser reports what it could not decode (unknown record types and
   * undecoded attributes), once per parse.
   *
   * DESKTOP-ONLY on purpose. The drift report is an operator/monitoring signal
   * for the machine doing the importing; the cloud renderer parses one archived
   * transcript for display and has nowhere to put it — and `packages/app` bans
   * logging outright, since it bundles to the browser. Omitted, the parser's
   * reporters short-circuit and cost nothing.
   */
  log?: (message: string) => void;
  /**
   * ISS-7198: where the Desktop origin sidecars live; defaults to the host layout
   * (macOS-only). `null` disables the join outright, so a caller staging its own
   * corpus cannot pick up the developer's real Desktop history.
   */
  desktopSessionsDir?: string | null;
  /**
   * ISS-7198: how long a sidecar-index build is reused before `prepareSourceBatch`
   * rebuilds it. Test seam — a scan-seam test must drive the refresh by calling
   * it, not by waiting out a wall-clock window.
   */
  desktopOriginRefreshTtlMs?: number;
  /**
   * ISS-7198: called once per SCAN of the Desktop sidecar tree. The per-pass cost
   * of this reader is a behavioral contract — one scan per batch, never one per
   * source — and the collectors' AGENTS.md requires it be asserted as a
   * dependency call count rather than as wall-clock timing.
   */
  onDesktopOriginScan?: () => void;
};

export function createClaudeCollector(
  options: CreateClaudeCollectorOptions = {}
): FileHarnessCollector {
  const listSources = options.listSources ?? listAllTranscriptFiles;
  const watchRoots = options.watchRoots ?? defaultClaudeWatchRoots;
  // One index per collector instance: the worker reuses a collector across every
  // parse in a pass (`historical-parse-source.ts`), so a per-source scan of the
  // sidecar tree would make the import O(sources × sidecars).
  // ISS-7625: the last parse's unreadable-transcript quality, awaiting a drain by
  // `takeUnreadableParseQuality`. Per collector INSTANCE (the worker reuses one
  // across a pass) and written only on the parser's no-timestamp path.
  let unreadableParseQuality: NormalizedParseQuality | undefined;
  const desktopOrigins = createClaudeDesktopOriginIndex({
    ...(options.desktopSessionsDir === undefined
      ? {}
      : { sessionsDir: options.desktopSessionsDir }),
    ...(options.desktopOriginRefreshTtlMs === undefined
      ? {}
      : { ttlMs: options.desktopOriginRefreshTtlMs }),
    ...(options.onDesktopOriginScan === undefined
      ? {}
      : { onScan: options.onDesktopOriginScan }),
  });
  return {
    key: "claude",
    cacheName: "claude",
    watchRoots,
    watchMatch: (filename: string) => filename.endsWith(".jsonl"),
    sourcePathsForWatchEvent: (root: string, filename: string): string[] => [
      sourcePathFromClaudeWatchEvent(root, filename),
    ],
    listSources,
    /**
     * ISS-7198: rebuild the Desktop sidecar index ONCE per scan, here, awaited —
     * the seam the collectors' AGENTS.md reserves for per-batch precompute, and
     * the one the Codex rollout-linkage graph already uses. `extraMtime` below
     * runs once per source inside the main-process scan loop, so a rebuild
     * triggered from there would re-read the whole sidecar tree, synchronously,
     * several times over a large history.
     */
    prepareSourceBatch: () => desktopOrigins.refresh(),
    parse: async (filePath: string) => {
      // ISS-7625: cleared BEFORE the parse, never after, so a report left by an
      // earlier source can never be drained as this one's (the same ordering
      // `parseHistoricalSource` uses for the OpenCode side-report slot).
      unreadableParseQuality = undefined;
      const session = await parseSessionFile(
        filePath,
        options.log,
        (quality) => {
          unreadableParseQuality = quality;
        }
      );
      if (!session) {
        return [];
      }
      return [withDesktopOrigin(session, desktopOrigins)];
    },
    takeUnreadableParseQuality: (): NormalizedParseQuality | undefined => {
      const quality = unreadableParseQuality;
      unreadableParseQuality = undefined;
      return quality;
    },
    /**
     * FEA-1459 Fix 11: Return the max mtime across subagent files for this
     * session so the catchup cache detects subagent-only changes.
     *
     * ISS-7198: the Desktop origin sidecar counts too. Desktop writes on its own
     * clock, so a sidecar-only write after the transcript's last change would
     * otherwise leave the session unattributed until an unrelated edit — the same
     * staleness ISS-4592 fixed for `agent-*.meta.json`.
     */
    extraMtime: (source: string): number | null =>
      combineExtraMtimes(
        maxSubagentMtime(source),
        desktopOrigins.mtimeFor(sessionIdFromTranscriptPath(source)),
        desktopOrigins.enabled
      ),
    sessionIdForSource: (source: string): string | null =>
      sessionIdFromTranscriptPath(source),
  };
}

/**
 * ISS-7198: attach the Claude Desktop launch origin, when this transcript has one.
 *
 * The join sits HERE and not in `parseSessionFile` because the parser is the
 * raw-transcript shell (shared with the backfills and the cloud renderer) while
 * the sidecar is a separate host tree this descriptor owns — and because both the
 * in-process and utility-process import paths call this `parse`.
 *
 * A session with no sidecar is returned UNTOUCHED, not with an empty origin: that
 * is what keeps a terminal launch distinguishable, and what keeps the persisted
 * metadata blob byte-identical for every session predating this capture.
 */
function withDesktopOrigin(
  session: NormalizedSession,
  desktopOrigins: ClaudeDesktopOriginIndex
): NormalizedSession {
  const claudeDesktopOrigin = desktopOrigins.lookup(session.sessionId);
  if (!claudeDesktopOrigin) {
    return session;
  }
  return { ...session, claudeDesktopOrigin };
}

/**
 * Fold the subagent clock and the Desktop-sidecar clock into the ONE number the
 * catchup cache stores. Not a timestamp — never read it as one.
 *
 * `Math.max` is wrong here, and silently: the cache invalidates only on
 * `extra > cachedExtra`, so for a session whose newest subagent file is already
 * newer than its sidecar, a later sidecar write leaves the max unchanged and the
 * session is skipped — never gaining its origin unless the transcript itself
 * changes. The two clocks are independent (the CLI writes one, the app the
 * other), so the fold has to move when EITHER moves. A sum does, since mtimes
 * advance; it also makes the one-time migration free, because a session that
 * already has a sidecar sums above its pre-ISS-7198 cached value and re-imports
 * itself once, with no DATA_REVISION bump.
 *
 * `null` means "this session contributes no extra fingerprint at all", and while
 * the sidecar reader is ACTIVE that is not true of a Claude session with no
 * sidecar — it contributes the fact that it has none. Returning `null` there
 * would make a sidecar's DISAPPEARANCE invisible: the catchup cache skips the
 * extra check entirely on a `null`, so a session whose sidecar was deleted (a
 * Desktop session removed, an app reinstall) would keep serving its persisted
 * `claudeDesktopOrigin` until the transcript itself changed. `0` is a real
 * fingerprint value and differs from whatever the sidecar summed to, so the
 * session re-imports once and drops the origin. With the reader DISABLED
 * (golden mode, a host with no verified layout) `null` is still the truth.
 */
function combineExtraMtimes(
  subagentMtime: number | null,
  sidecarMtime: number | null,
  sidecarsEnabled: boolean
): number | null {
  if (subagentMtime === null && sidecarMtime === null) {
    return sidecarsEnabled ? 0 : null;
  }
  return (subagentMtime ?? 0) + (sidecarMtime ?? 0);
}

/** Live-layout default watch root — resolved lazily so `CLAUDE_HOME` is honored. */
function defaultClaudeWatchRoots(): string[] {
  return [getProjectsDir()];
}

/**
 * FEA-1459 Fix 11: Compute the max mtimeMs across all subagent files for a
 * given main transcript path. Returns null when no subagent dir exists.
 *
 * FEA-3420: walks the subagents/ tree recursively so a change to a nested
 * workflow agent (subagents/workflows/<id>/agent-*.jsonl) also invalidates the
 * catchup cache and re-imports the parent — the old direct-children-only scan
 * left nested-workflow edits invisible to catchup.
 *
 * ISS-4592: each sidecar's sibling `agent-<hex>.meta.json` counts too. That
 * file became a load-bearing input to the delegation-kickoff join
 * (`readSubagentMeta`), so a meta-only write after the transcript's last
 * change would otherwise leave the parent session's enrichment stale until an
 * unrelated edit or a DATA_REVISION bump forced a re-import.
 */
function maxSubagentMtime(mainTranscriptPath: string): number | null {
  const sessionId = path.basename(mainTranscriptPath, ".jsonl");
  const sessionDir = path.dirname(mainTranscriptPath);
  const subagentsDir = path.join(sessionDir, sessionId, "subagents");
  let maxMtime: number | null = null;
  for (const { filePath } of walkSubagentTranscripts(subagentsDir)) {
    for (const candidate of [filePath, subagentMetaPathFor(filePath)]) {
      try {
        const st = statSync(candidate);
        if (maxMtime === null || st.mtimeMs > maxMtime) {
          maxMtime = st.mtimeMs;
        }
      } catch {
        // skip unreadable / absent files (the meta sibling is optional)
      }
    }
  }
  return maxMtime;
}

function sourcePathFromClaudeWatchEvent(
  root: string,
  filename: string
): string {
  const relativePath = path.isAbsolute(filename)
    ? path.relative(root, filename)
    : filename;
  const parts = relativePath.split(PATH_SEGMENT_SEPARATOR_RE).filter(Boolean);
  const subagentsIndex = parts.indexOf("subagents");
  if (subagentsIndex >= 2) {
    const sessionId = parts[subagentsIndex - 1];
    const parentParts = parts.slice(0, subagentsIndex - 1);
    return path.join(root, ...parentParts, `${sessionId}.jsonl`);
  }
  return path.isAbsolute(filename) ? filename : path.join(root, filename);
}
