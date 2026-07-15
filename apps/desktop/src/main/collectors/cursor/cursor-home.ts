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
import os from "node:os";
import path from "node:path";

import { collectJsonlFiles } from "../parsing/parser-utils.js";

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
 * generically. Depth-bounded and error-tolerant. Thin pass-through over the
 * shared {@link collectJsonlFiles} walker.
 */
export function collectTranscriptFiles(
  root: string,
  opts: { maxDepth?: number } = {}
): string[] {
  return collectJsonlFiles(root, opts);
}

/**
 * All Cursor agent transcript files.
 */
export function listAllTranscriptFiles(): string[] {
  return collectTranscriptFiles(getCursorProjectsDir());
}
