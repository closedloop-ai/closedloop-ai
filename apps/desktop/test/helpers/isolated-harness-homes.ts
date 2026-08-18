/**
 * @file isolated-harness-homes.ts
 * @description The full set of collector-home environment overrides that point
 * a launched desktop build away from the operator's real agent history.
 *
 * Extracted from `test/soak/soak-app.ts` (ISS-6241) so Electron E2E specs can
 * reuse the ONE declaration rather than re-listing the variables: a spec that
 * isolates only `CLAUDE_HOME`/`CODEX_HOME` still imports the operator's real
 * Copilot store and their whole `opencode.db`, which is a batch source — one
 * file holding an unbounded number of sessions. That contamination is not just
 * slow; it puts foreign rows into any population a spec establishes.
 *
 * Kept dependency-free on purpose (`node:fs` + `node:path` only). `soak-app.ts`
 * pulls in the mock cloud server and Playwright's Electron launcher, and a spec
 * that imported this from there would drag both into Playwright's Node loader at
 * spec-collection time — the same spec-load hazard `test/AGENTS.md` documents.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Create a throwaway home per harness under `root` and return the environment
 * that points the collectors at them.
 *
 * Every harness the collectors read MUST appear here. A missing entry silently
 * falls back to the operator's real directory, which reads as a slow or flaky
 * test rather than as the contamination it is.
 */
export function isolatedHarnessHomes(root: string): Record<string, string> {
  const mk = (name: string): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  return {
    CLAUDE_HOME: mk("claude-home"),
    CODEX_HOME: mk("codex-home"),
    CURSOR_HOME: mk("cursor-home"),
    COPILOT_HOME: mk("copilot-home"),
    COPILOT_VSCODE_STORAGE_DIR: mk("copilot-vscode"),
    OPENCODE_DATA_DIR: mk("opencode-data"),
    OPENCODE_CONFIG_DIR: mk("opencode-config"),
  };
}
