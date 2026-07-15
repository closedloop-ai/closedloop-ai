/**
 * @file claude-collector.ts
 * @description Claude Code harness collector descriptor (FEA-1503). Claude is the
 * only harness with a live hook path, so its live file watcher is gated OFF by the
 * CollectorManager whenever hooks are installed — the routing decision is owned by
 * `getActiveCollectionMode` (FEA-1839) (hooks own live capture; a concurrent
 * watcher would double-count turns). Historical import remains idempotent
 * against any hook-written events.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { FileHarnessCollector } from "../types.js";
import {
  getProjectsDir,
  listAllTranscriptFiles,
  sessionIdFromTranscriptPath,
} from "./claude-home.js";
import { parseSessionFile } from "./claude-parser.js";

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
      const session = await parseSessionFile(filePath);
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
 */
function maxSubagentMtime(mainTranscriptPath: string): number | null {
  const sessionId = path.basename(mainTranscriptPath, ".jsonl");
  const sessionDir = path.dirname(mainTranscriptPath);
  const subagentsDir = path.join(sessionDir, sessionId, "subagents");
  let maxMtime: number | null = null;
  try {
    const entries = readdirSync(subagentsDir);
    for (const entry of entries) {
      if (!(entry.startsWith("agent-") && entry.endsWith(".jsonl"))) {
        continue;
      }
      try {
        const st = statSync(path.join(subagentsDir, entry));
        if (maxMtime === null || st.mtimeMs > maxMtime) {
          maxMtime = st.mtimeMs;
        }
      } catch {
        // skip unreadable files
      }
    }
  } catch {
    // no subagents dir — normal
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
