/**
 * @file codex-home.ts
 * @description Centralized OpenAI Codex CLI home directory path management —
 * the Codex analogue of claude-home. Resolves the sessions root, the rollout
 * JSONL files (Codex writes one append-only `rollout-*.jsonl` per session under
 * `sessions/YYYY/MM/DD/`), the aggregated history file, and the archived-sessions
 * directory. Supports a custom root via the CODEX_HOME environment variable so
 * non-default Codex installs are still discovered.
 *
 * Ported from `scripts/agent-monitor-codex/codex-home.js` (logic preserved).
 */
import fs from "node:fs";
import path from "node:path";

import {
  getCodexArchivedDir as resolveCodexArchivedDir,
  getCodexConfigPath as resolveCodexConfigPath,
  getCodexHome as resolveCodexHome,
  getCodexSessionsDir as resolveCodexSessionsDir,
} from "../../codex-home-paths.js";

export function getCodexHome(): string {
  return resolveCodexHome();
}

export function getCodexConfigPath(): string {
  return resolveCodexConfigPath();
}

export function getCodexSessionsDir(): string {
  return resolveCodexSessionsDir();
}

export function getCodexArchivedDir(): string {
  return resolveCodexArchivedDir();
}

/**
 * Derive a stable session id from a rollout file path. Codex names rollout
 * files `rollout-<ISO8601>-<uuid>.jsonl`; we want the uuid. If the name
 * doesn't match, fall back to the basename sans extension so every file still
 * maps to a deterministic id.
 */
export function sessionIdFromRolloutPath(filePath: string): string {
  const base = path.basename(filePath, ".jsonl");
  const uuid = base.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  if (uuid) {
    return uuid[0];
  }
  return base.replace(/^rollout-/, "");
}

/**
 * Recursively collect every `*.jsonl` rollout file under a root directory.
 * Codex nests by date (`sessions/YYYY/MM/DD/`), but we walk generically so a
 * flat layout or `archived_sessions/` also works. Depth-bounded and
 * error-tolerant — a Codex dir is the user's own local data and a permission
 * or IO error on one branch must not abort discovery.
 */
export function collectRolloutFiles(
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
 * All Codex rollout files (active sessions + archived).
 */
export function listAllRolloutFiles(): string[] {
  return [
    ...collectRolloutFiles(getCodexSessionsDir()),
    ...collectRolloutFiles(getCodexArchivedDir()),
  ];
}
