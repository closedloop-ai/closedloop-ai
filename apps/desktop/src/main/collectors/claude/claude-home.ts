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

/** Subagent transcript files under one session's `subagents/` directory. */
function subagentFilesForSession(
  projPath: string,
  sessionName: string
): ClaudeSubagentTranscriptFile[] {
  const subagentsPath = path.join(projPath, sessionName, "subagents");
  const out: ClaudeSubagentTranscriptFile[] = [];
  for (const file of safeReaddir(subagentsPath)) {
    if (file.isFile() && file.name.endsWith(".jsonl")) {
      out.push({
        parentSessionId: sessionName,
        fileId: path.basename(file.name, ".jsonl"),
        filePath: path.join(subagentsPath, file.name),
      });
    }
  }
  return out;
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
