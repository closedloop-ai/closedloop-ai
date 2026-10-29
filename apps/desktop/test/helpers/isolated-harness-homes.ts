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
 * Every collector-home environment variable, mapped to the directory name it
 * gets under an isolation root.
 *
 * THE list — `isolatedHarnessHomes`, `HARNESS_HOME_ENV_KEYS` and
 * `ambientHarnessHomes` all derive from it, so adding a ninth collector home is
 * one edit and cannot leave a consumer half-updated. Each of these variables is
 * the HIGHEST-precedence input to its resolver (the per-harness `-home.ts`
 * modules under `src/main/collectors`), so a set value is sufficient to redirect
 * that collector and an unset one falls all the way back to `os.homedir()`.
 */
const HARNESS_HOME_DIR_NAMES = {
  CLAUDE_HOME: "claude-home",
  // Review (#5717, tamsinb): the Claude DESKTOP sidecar root is a separate
  // home from `CLAUDE_HOME`, and `getClaudeDesktopSessionsDir()` falls back to
  // `~/Library/Application Support/Claude/claude-code-sessions` on macOS — the
  // platform the suite actually runs on. `createClaudeCollector` builds that
  // index with no `sessionsDir` on the boot path, so an unpinned launch scans
  // and DECODES the operator's real Claude Desktop history. Smaller blast
  // radius than the others (it enriches titles and account metadata rather than
  // importing whole sessions), same class of leak, so it is pinned here rather
  // than left as the one exception to a list that claims to be complete.
  CLAUDE_DESKTOP_SESSIONS_HOME: "claude-desktop-sessions",
  CODEX_HOME: "codex-home",
  CURSOR_HOME: "cursor-home",
  COPILOT_HOME: "copilot-home",
  COPILOT_VSCODE_STORAGE_DIR: "copilot-vscode",
  OPENCODE_DATA_DIR: "opencode-data",
  OPENCODE_CONFIG_DIR: "opencode-config",
} as const;

/** The collector-home variables a launch must not leave ambient. */
export const HARNESS_HOME_ENV_KEYS = Object.keys(
  HARNESS_HOME_DIR_NAMES
) as ReadonlyArray<keyof typeof HARNESS_HOME_DIR_NAMES>;

/**
 * Create a throwaway home per harness under `root` and return the environment
 * that points the collectors at them.
 *
 * Every harness the collectors read MUST appear here. A missing entry silently
 * falls back to the operator's real directory, which reads as a slow or flaky
 * test rather than as the contamination it is.
 */
export function isolatedHarnessHomes(root: string): Record<string, string> {
  const homes: Record<string, string> = {};
  for (const key of HARNESS_HOME_ENV_KEYS) {
    const dir = path.join(root, HARNESS_HOME_DIR_NAMES[key]);
    fs.mkdirSync(dir, { recursive: true });
    homes[key] = dir;
  }
  return homes;
}

/**
 * The collector homes `env` leaves AMBIENT — set to nothing, so the resolver
 * falls back under `os.homedir()` and reads the operator's real history.
 *
 * The backstop's question, kept here beside the list it is asked about rather
 * than at the launcher. Returns the keys, not a verdict, so a caller can name
 * them in a failure or fill them in.
 */
export function ambientHarnessHomes(
  env: Record<string, string | undefined> | undefined
): string[] {
  return HARNESS_HOME_ENV_KEYS.filter((key) => !env?.[key]?.trim());
}
