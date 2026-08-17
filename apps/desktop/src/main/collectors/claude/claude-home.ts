/**
 * @file claude-home.ts
 * @description Claude Code home/transcript path resolution (FEA-1503; first-party
 * port of the vendor `server/lib/claude-home.js`). Claude stores per-session
 * transcripts as JSONL under `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
 * (subagent transcripts live deeper under `<sessionId>/subagents/`). Honors the
 * `CLAUDE_HOME` override (same resolution as agent-monitor-hooks.ts).
 */
import { type Dirent, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function getClaudeHome(): string {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

export function getProjectsDir(): string {
  return path.join(getClaudeHome(), "projects");
}

/** The sessionId is the transcript filename without its `.jsonl` extension. */
export function sessionIdFromTranscriptPath(filePath: string): string {
  return path.basename(filePath, ".jsonl");
}

/**
 * Enumerate the top-level session transcript files (one per session) across all
 * project directories. Deliberately one level deep per project dir so subagent
 * transcripts under `<sessionId>/subagents/` are NOT returned as sessions.
 */
export function listAllTranscriptFiles(): string[] {
  const projectsDir = getProjectsDir();
  const out: string[] = [];
  for (const d of safeReaddir(projectsDir)) {
    if (!d.isDirectory()) {
      continue;
    }
    const projPath = path.join(projectsDir, d.name);
    for (const f of safeReaddir(projPath)) {
      if (f.isFile() && f.name.endsWith(".jsonl")) {
        out.push(path.join(projPath, f.name));
      }
    }
  }
  return out;
}

/** A discovered Claude subagent sidechain transcript file (FEA-2715). */
export type ClaudeSubagentTranscriptFile = {
  /** The owning parent session id (the `<sessionId>` directory name). */
  parentSessionId: string;
  /** Opaque, path-safe subagent file id — the basename without `.jsonl`. */
  fileId: string;
  /** Absolute path to the subagent `.jsonl`. */
  filePath: string;
};

/** Read a directory's entries, returning `[]` on any IO/permission error. */
function safeReaddir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Bound on how deep the recursive subagent walk descends below a session's
 * `subagents/` directory. Direct sidecars sit at depth 0; Claude workflow agents
 * live one level down under `workflows/<workflow-id>/agent-*.jsonl` (depth 1).
 * A generous cap tolerates future nested layouts while keeping an accidental
 * symlink cycle or pathological tree from spinning discovery forever.
 */
const SUBAGENT_WALK_MAX_DEPTH = 8;

/** A discovered subagent `agent-*.jsonl` file with its path-relative identity. */
export type SubagentWalkEntry = {
  /** Absolute path to the subagent transcript file. */
  filePath: string;
  /**
   * Stable, path-safe identity relative to the session's `subagents/` dir. For a
   * DIRECT sidecar this is the bare basename (`agent-<uuid>`), preserving the
   * historical id so it still reconciles with an in-line sidechain subagent
   * keyed on that uuid. For a NESTED workflow agent it is the relative path with
   * separators folded to `__` (`workflows__<workflow-id>__agent-<uuid>`) so two
   * workflows owning an identically named `agent-*.jsonl` cannot collide.
   */
  relId: string;
};

/** Splits a relative path into segments on either separator (see FEA-3420 note below). */
const SUBAGENT_PATH_SEPARATOR_RE = /[\\/]+/;
const SUBAGENT_PERCENT_RE = /%/g;
const SUBAGENT_UNDERSCORE_RE = /_/g;

/**
 * FEA-3420 review (Thadeus): `__` is only an injective join delimiter if no path
 * segment contains `__` itself — otherwise two distinct nested paths (e.g.
 * `wf__1/agent-x` vs `wf/1/agent-x`) fold to the SAME relId and one agent's
 * transcript silently overwrites the other's row (the exact token-loss the
 * recursive walk fixes). Escape `%`→`%25` then `_`→`%5F` in each segment so no
 * raw underscore survives inside a segment; a `__` run in the joined id is then
 * unambiguously a delimiter. `agent-<uuid>` basenames contain neither char, so
 * bare sidecar ids are byte-identical (no key churn on the common, non-nested
 * case).
 */
function encodeSubagentSegment(segment: string): string {
  return segment
    .replace(SUBAGENT_PERCENT_RE, "%25")
    .replace(SUBAGENT_UNDERSCORE_RE, "%5F");
}

/**
 * The SINGLE predicate for "is this path a subagent transcript the archive lane
 * may mint a key for" (ISS-4390). {@link walkSubagentTranscripts} enumerates
 * ONLY `agent-*.jsonl` files within {@link SUBAGENT_WALK_MAX_DEPTH}, so the live
 * resolver has to admit exactly that set too — a live key minted for anything
 * wider (a workflow journal/index `.jsonl`, or a file nested deeper than the
 * walk descends) creates an archived object the discovery sweep will never
 * enumerate, re-observe, or reconcile against a local file.
 *
 * `filePath` is absolute and already known to sit under `subagentsDir`.
 */
export function isSubagentTranscriptPath(
  subagentsDir: string,
  filePath: string
): boolean {
  const fileName = path.basename(filePath);
  if (!(fileName.startsWith("agent-") && fileName.endsWith(".jsonl"))) {
    return false;
  }
  const depth =
    path
      .relative(subagentsDir, filePath)
      .split(SUBAGENT_PATH_SEPARATOR_RE)
      .filter(Boolean).length - 1;
  return depth >= 0 && depth <= SUBAGENT_WALK_MAX_DEPTH;
}

/**
 * The SINGLE derivation of a subagent transcript's `subagents/`-relative
 * identity (ISS-4390). {@link walkSubagentTranscripts} uses it while enumerating,
 * and the transcript lane's live ref resolver uses it to compute the SAME
 * `subagent:{relId}` file key from a watcher-supplied path alone — with no
 * directory walk. Re-deriving this encoding at either call site would let the
 * live-enqueued key silently diverge from the discovery-swept key and archive
 * one file twice, so both paths MUST come through here.
 *
 * `filePath` is the absolute path to an `agent-*.jsonl` under `subagentsDir`.
 */
export function relIdFromSubagentPath(
  subagentsDir: string,
  filePath: string
): string {
  const parts = path
    .relative(subagentsDir, filePath)
    .split(SUBAGENT_PATH_SEPARATOR_RE)
    .filter(Boolean);
  const fileName = parts.at(-1) ?? "";
  const base = path.basename(fileName, ".jsonl");
  const dirs = parts.slice(0, -1);
  if (dirs.length === 0) {
    return encodeSubagentSegment(base);
  }
  return [...dirs, base].map(encodeSubagentSegment).join("__");
}

/**
 * FEA-3420: recursively enumerate every `agent-*.jsonl` transcript under a
 * session's `subagents/` directory, including Claude WORKFLOW agents nested at
 * `subagents/workflows/<workflow-id>/agent-*.jsonl` (and any future deeper
 * layout). The previous one-level `readdir` skipped these, so workflow-agent
 * tokens, tools, models, and artifacts were absent from the parent session.
 *
 * Results are sorted by `relId` for hermetic (machine-independent) ordering, and
 * each level is IO-error-tolerant — one unreadable nested branch must not abort
 * discovery of the rest. Only `agent-*.jsonl` files are returned; workflow
 * journal / index files that do not match are ignored.
 */
export function walkSubagentTranscripts(
  subagentsDir: string
): SubagentWalkEntry[] {
  const out: SubagentWalkEntry[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > SUBAGENT_WALK_MAX_DEPTH) {
      return;
    }
    for (const entry of safeReaddir(dir)) {
      const childPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(childPath, depth + 1);
        continue;
      }
      if (
        entry.isFile() &&
        entry.name.startsWith("agent-") &&
        entry.name.endsWith(".jsonl")
      ) {
        out.push({
          filePath: childPath,
          relId: relIdFromSubagentPath(subagentsDir, childPath),
        });
      }
    }
  };
  visit(subagentsDir, 0);
  // Hermetic (machine-independent) order: relIds are unique path-qualified
  // strings, so a plain code-point comparison is a total, stable order.
  return out.sort((a, b) => {
    if (a.relId < b.relId) {
      return -1;
    }
    if (a.relId > b.relId) {
      return 1;
    }
    return 0;
  });
}

/**
 * Subagent transcript files under one session's `subagents/` directory,
 * recursively (FEA-3420 — includes workflow-owned nested agents).
 *
 * Feeds BOTH the local parse-fold and the cloud transcript-sync archive lane
 * (via {@link listClaudeSubagentTranscriptFiles}). It now matches only
 * `agent-*.jsonl` — the prior flat scan admitted any `*.jsonl`, but Claude only
 * ever writes `agent-<uuid>.jsonl` sidecars (workflow journal/index files are
 * not sidechain transcripts), so this deliberately aligns the sync path with
 * the parse-fold's long-standing `agent-*` filter rather than narrowing real
 * data. `fileId` is the `subagents/`-relative `relId`, so a nested workflow
 * agent archives under a collision-free `subagent:workflows__<id>__agent-*` key.
 */
function subagentFilesForSession(
  projPath: string,
  sessionName: string
): ClaudeSubagentTranscriptFile[] {
  const subagentsPath = path.join(projPath, sessionName, "subagents");
  return walkSubagentTranscripts(subagentsPath).map((entry) => ({
    parentSessionId: sessionName,
    fileId: entry.relId,
    filePath: entry.filePath,
  }));
}

/**
 * Enumerate Claude subagent sidechain transcripts, which
 * {@link listAllTranscriptFiles} deliberately excludes. Layout (see
 * subagent-scanner.ts): `<projectDir>/<sessionId>/subagents/agent-*.jsonl`.
 * Each file is associated with its owning parent session so the archive lane
 * (FEA-2715) can sync it under the same `externalSessionId` with a
 * `subagent:{fileId}` file key. Error-tolerant per directory — the projects dir
 * is the user's own local data and one unreadable branch must not abort
 * discovery.
 */
export function listClaudeSubagentTranscriptFiles(): ClaudeSubagentTranscriptFile[] {
  const projectsDir = getProjectsDir();
  const out: ClaudeSubagentTranscriptFile[] = [];
  for (const project of safeReaddir(projectsDir)) {
    if (!project.isDirectory()) {
      continue;
    }
    const projPath = path.join(projectsDir, project.name);
    for (const sessionDir of safeReaddir(projPath)) {
      if (sessionDir.isDirectory()) {
        out.push(...subagentFilesForSession(projPath, sessionDir.name));
      }
    }
  }
  return out;
}
