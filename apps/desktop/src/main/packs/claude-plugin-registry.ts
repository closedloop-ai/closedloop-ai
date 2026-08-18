/**
 * @file claude-plugin-registry.ts — the single low-level reader/parser for
 * Claude Code's on-disk plugin registry (`~/.claude/plugins/installed_plugins.json`).
 *
 * Both the pack projection (`scanClaudeMarketplaces` in pack-scanner.ts) and the
 * harness-native installed-plugin discovery (`discoverInstalledPlugins` in
 * component-scanner.ts, FEA-4094) read the SAME registry, so the read + JSON
 * parse + flat-entry extraction lives here once and both apply their own
 * grouping/collapse on top (per PR #3693 review — dedup the duplicated parse).
 *
 * The read is a TRI-STATE so callers can tell a genuinely-empty registry apart
 * from a transient read/parse failure. `discoverInstalledPlugins` reconciles to
 * zero (tombstones missing plugins) only for `ok`; `unreadable` (a corrupt or
 * partially-rewritten file, or an IO error) must be a no-op so a transient
 * failure never mass-tombstones every installed plugin.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveClaudeHome } from "./claude-home.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One flat install-scope entry resolved from the registry: a single
 * (plugin, install scope) row. `marketplace` is `null` for a plugin installed
 * directly into the harness (registry key has no `@`).
 */
export type ClaudePluginRegistryEntry = {
  pluginName: string;
  marketplace: string | null;
  installPath: string;
  version: string | null;
};

/**
 * Tri-state result of reading the registry.
 * - `ok` — the file was read and parsed; `entries` is authoritative (possibly
 *   empty, e.g. the file is absent or `{ "plugins": {} }`), so a caller may
 *   reconcile inventory to it (including tombstoning what is missing).
 * - `unreadable` — the file exists but could not be read or parsed (corrupt
 *   JSON, a partial rewrite, or an IO error). NOT authoritative; callers must
 *   NOT reconcile to zero, or a transient failure mass-tombstones everything.
 */
export type ClaudePluginRegistryRead =
  | { status: "ok"; entries: ClaudePluginRegistryEntry[] }
  | { status: "unreadable" };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Pack ids that already have dedicated first-party scanners
 * (`detectGStack`/`detectBmad`). Both the pack projection and installed-plugin
 * discovery skip registry entries owned by these so those plugins stay solely
 * owned by their dedicated scanner and are never double-counted.
 */
export const RESERVED_PLUGIN_PACK_IDS: ReadonlySet<string> = new Set([
  "gstack",
  "bmad-method",
]);

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Read and parse `~/.claude/plugins/installed_plugins.json` into flat
 * install-scope entries. Returns `{ status: "ok", entries }` when the file is
 * absent (genuine empty) or successfully parsed, and `{ status: "unreadable" }`
 * when the file exists but a read/parse failure means the contents are unknown.
 */
export function readClaudeInstalledPluginRegistry(): ClaudePluginRegistryRead {
  const registryPath = path.join(
    resolveClaudeHome(),
    "plugins",
    "installed_plugins.json"
  );

  let raw: string;
  try {
    raw = readFileSync(registryPath, "utf8");
  } catch (e: unknown) {
    // A genuinely-absent registry is an authoritative empty inventory; any
    // other read error (permission, IO, mid-rewrite) is unreadable so callers
    // do not reconcile to zero on a transient failure.
    if (isFileNotFound(e)) {
      return { status: "ok", entries: [] };
    }
    return { status: "unreadable" };
  }

  let registry: { plugins?: unknown };
  try {
    registry = JSON.parse(raw);
  } catch {
    // Present but corrupt/partial JSON — treat as unreadable, not empty.
    return { status: "unreadable" };
  }

  if (!registry || typeof registry.plugins !== "object" || !registry.plugins) {
    // A well-formed registry with no `plugins` object is a genuine empty.
    return { status: "ok", entries: [] };
  }

  const entries: ClaudePluginRegistryEntry[] = [];
  for (const [pluginRef, scopes] of Object.entries(
    registry.plugins as Record<string, unknown>
  )) {
    if (Array.isArray(scopes)) {
      appendScopeEntries(pluginRef, scopes, entries);
    }
  }
  return { status: "ok", entries };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function isFileNotFound(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Resolve every install-scope entry for one `installed_plugins.json` key.
 * `pluginRef` is `<pluginName>@<marketplace>`; a plugin installed directly into
 * the harness (no marketplace) carries no `@` and maps to a null marketplace so
 * it is still discovered. Malformed entries (missing/empty `installPath`) are
 * skipped.
 */
function appendScopeEntries(
  pluginRef: string,
  scopes: unknown[],
  out: ClaudePluginRegistryEntry[]
): void {
  const at = pluginRef.lastIndexOf("@");
  const pluginName = at >= 1 ? pluginRef.slice(0, at) : pluginRef;
  const marketplace = at >= 1 ? pluginRef.slice(at + 1) : null;
  for (const entry of scopes) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const e = entry as { installPath?: unknown; version?: unknown };
    if (typeof e.installPath !== "string" || !e.installPath) {
      continue;
    }
    out.push({
      pluginName,
      marketplace,
      installPath: e.installPath,
      version: typeof e.version === "string" ? e.version : null,
    });
  }
}
