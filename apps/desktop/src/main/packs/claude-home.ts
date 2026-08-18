/**
 * @file claude-home.ts — resolve the on-disk Claude Code / Codex home
 * directories, honoring the `CLAUDE_HOME` / `CODEX_HOME` overrides used by
 * tests and non-default installs.
 *
 * Extracted from pack-scanner.ts so the low-level registry reader
 * (`claude-plugin-registry.ts`) can resolve the home without importing the
 * heavy pack scanner (which would create an import cycle once the scanner
 * consumes the shared reader).
 */

import os from "node:os";
import path from "node:path";

export function resolveClaudeHome(): string {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

export function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}
