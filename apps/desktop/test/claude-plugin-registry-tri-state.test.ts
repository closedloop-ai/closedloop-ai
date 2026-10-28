/**
 * @file claude-plugin-registry-tri-state.test.ts
 * @description ISS-6707 — the two inputs that must resolve to DIFFERENT halves
 * of `readClaudeInstalledPluginRegistry`'s tri-state, and that no existing suite
 * reaches.
 *
 * SCOPE, deliberately narrow. The corrupt-JSON → `unreadable` branch and the
 * absent-file → `ok` branch are already covered through their production
 * consumers (`component-scanner-installed-plugins.test.ts` asserts a corrupt
 * registry tombstones nothing; `marketplace-scan.test.ts` asserts the projection
 * no-ops), and so are the flat-entry shapes (`direct-plugin` with no `@`, a
 * scope with no `version`). Re-asserting those here would be a second copy of a
 * green test. What is NOT covered anywhere is the discriminator BETWEEN the two
 * states on its two remaining input classes:
 *
 *   - a read that fails with something other than ENOENT (a mid-rewrite, a
 *     permission error, a path that is not a file). `isFileNotFound` is the only
 *     thing standing between that and `{ status: "ok", entries: [] }`, which the
 *     module's own docstring says must never happen: a caller reconciling to an
 *     authoritative empty mass-tombstones every installed plugin on a transient
 *     failure.
 *   - a file that parses cleanly but carries no `plugins` object. That is a
 *     genuine empty and must stay `ok`; downgrading it to `unreadable` would
 *     mean a user who has uninstalled everything never reconciles back to zero.
 *
 * Both use a REAL temp CLAUDE home and a real `readFileSync`, so nothing here
 * can pass because a mock was mis-wired.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, assert, test, vi } from "vitest";
import { readClaudeInstalledPluginRegistry } from "../src/main/packs/claude-plugin-registry.js";

const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Point `resolveClaudeHome()` at a throwaway home and return its plugins dir. */
function claudeHomePluginsDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "iss6707-claude-home-"));
  tempRoots.push(root);
  vi.stubEnv("CLAUDE_HOME", root);
  const pluginsDir = path.join(root, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  return pluginsDir;
}

test("a registry read that fails for any reason other than ENOENT is unreadable, never an authoritative empty", () => {
  const pluginsDir = claudeHomePluginsDir();
  // A directory where the registry file belongs: `readFileSync` throws EISDIR,
  // which is the class of error a mid-rewrite or a permission problem produces.
  // The point is that it is NOT ENOENT.
  mkdirSync(path.join(pluginsDir, "installed_plugins.json"));

  const read = readClaudeInstalledPluginRegistry();

  assert.deepEqual(read, { status: "unreadable" });
});

test("an absent registry is still the authoritative empty, so the non-ENOENT case above is a real distinction", () => {
  claudeHomePluginsDir();

  const read = readClaudeInstalledPluginRegistry();

  assert.deepEqual(read, { status: "ok", entries: [] });
});

test("a well-formed registry carrying no plugins object is a genuine empty, not unreadable", () => {
  const pluginsDir = claudeHomePluginsDir();
  writeFileSync(
    path.join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({ version: 2 }),
    "utf8"
  );

  const read = readClaudeInstalledPluginRegistry();

  assert.deepEqual(read, { status: "ok", entries: [] });
});
