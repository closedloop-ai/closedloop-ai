/**
 * @file cursor-home.ts
 * @description Centralized Cursor session path management. Resolves paths for
 * Cursor's background agent JSONL transcripts stored under
 * `~/.cursor/projects/<project-id>/agent-transcripts/<session-id>/`.
 *
 * Cursor also stores standard chat sessions in a SQLite database
 * (`state.vscdb`) under VS Code workspace storage, but those are opaque
 * key-value blobs — this module focuses on the structured agent transcripts
 * that yield the same telemetry the dashboard expects.
 *
 * Ported from the vendor `scripts/agent-monitor-cursor/cursor-home.js`; logic
 * preserved exactly (env precedence, path resolution, depth-bounded walk).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function getCursorHome(): string {
  const raw = process.env.CURSOR_HOME;
  if (raw?.trim()) {
    return raw.trim().replace(/^~(?=\/)/, os.homedir());
  }
  return path.join(os.homedir(), ".cursor");
}

export function getCursorProjectsDir(): string {
  return path.join(getCursorHome(), "projects");
}

/**
 * Derive a stable session id from an agent transcript path.
 * Cursor stores transcripts at:
 *   ~/.cursor/projects/<project-id>/agent-transcripts/<session-id>/<session-id>.jsonl
 * The session-id directory name is the canonical id.
 */
export function sessionIdFromTranscriptPath(filePath: string): string {
  // The parent directory name is the session id
  return path.basename(path.dirname(filePath));
}

/**
 * Recursively collect every `*.jsonl` transcript file under the projects root.
 * Cursor nests by project → agent-transcripts → session-id, but we walk
 * generically. Depth-bounded and error-tolerant.
 */
export function collectTranscriptFiles(
  root: string,
  { maxDepth = 8 }: { maxDepth?: number } = {}
): string[] {
  const out: string[] = [];
  if (!(root && fs.existsSync(root))) {
    return out;
  }
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * All Cursor agent transcript files.
 */
export function listAllTranscriptFiles(): string[] {
  return collectTranscriptFiles(getCursorProjectsDir());
}
