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
import type { FileHarnessCollector } from "../types.js";
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
};

export function createClaudeCollector(
  options: CreateClaudeCollectorOptions = {}
): FileHarnessCollector {
  const listSources = options.listSources ?? listAllTranscriptFiles;
  const watchRoots = options.watchRoots ?? defaultClaudeWatchRoots;
  return {
    key: "claude",
    cacheName: "claude",
    watchRoots,
    watchMatch: (filename: string) => filename.endsWith(".jsonl"),
    sourcePathsForWatchEvent: (root: string, filename: string): string[] => [
      sourcePathFromClaudeWatchEvent(root, filename),
    ],
    listSources,
    parse: async (filePath: string) => {
      const session = await parseSessionFile(filePath, options.log);
      return session ? [session] : [];
    },
    /**
     * FEA-1459 Fix 11: Return the max mtime across subagent files for this
     * session so the catchup cache detects subagent-only changes.
     */
    extraMtime: (source: string): number | null => maxSubagentMtime(source),
    sessionIdForSource: (source: string): string | null =>
      sessionIdFromTranscriptPath(source),
  };
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
