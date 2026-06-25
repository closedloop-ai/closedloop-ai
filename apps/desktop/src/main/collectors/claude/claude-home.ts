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
  let dirs: Dirent[];
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) {
      continue;
    }
    const projPath = path.join(projectsDir, d.name);
    let files: Dirent[];
    try {
      files = readdirSync(projPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith(".jsonl")) {
        out.push(path.join(projPath, f.name));
      }
    }
  }
  return out;
}
