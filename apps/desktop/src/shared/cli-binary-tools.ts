/**
 * Canonical list of current CLI tools the desktop app can detect and store
 * override paths for.
 *
 * Single source of truth shared by the Settings "CLI Tools" panel (the
 * renderer rows in `settings/binary-paths-tab.tsx`) and the main-process
 * detection handler
 * (`desktop:detect-cli-tools` in `app.ts`). Keeping the list here — a
 * framework-free module with no heavy imports — means the displayed tools and
 * the detected tools cannot drift: a tool that isn't detectable can't be shown,
 * and a detectable tool can't be hidden.
 *
 * `gh` is intentionally absent from this current catalog. The persisted
 * settings shape still accepts it only to read or clear older saved overrides.
 */
export const CLI_BINARY_TOOLS = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "python3",
  "git",
] as const;

export type CliBinaryTool = (typeof CLI_BINARY_TOOLS)[number];

export const LEGACY_CLI_BINARY_TOOLS = ["gh"] as const;

export type LegacyCliBinaryTool = (typeof LEGACY_CLI_BINARY_TOOLS)[number];

export type PersistedCliBinaryTool = CliBinaryTool | LegacyCliBinaryTool;

export type CurrentBinaryPaths = Partial<Record<CliBinaryTool, string>>;

export type BinaryPaths = Partial<Record<PersistedCliBinaryTool, string>>;

export const CliBinaryToolKeyStatus = {
  Current: "current",
  Legacy: "legacy",
  Unknown: "unknown",
} as const;

export type CliBinaryToolKeyStatus =
  (typeof CliBinaryToolKeyStatus)[keyof typeof CliBinaryToolKeyStatus];

export function classifyCliBinaryToolKey(key: string): CliBinaryToolKeyStatus {
  if ((CLI_BINARY_TOOLS as readonly string[]).includes(key)) {
    return CliBinaryToolKeyStatus.Current;
  }
  if ((LEGACY_CLI_BINARY_TOOLS as readonly string[]).includes(key)) {
    return CliBinaryToolKeyStatus.Legacy;
  }
  return CliBinaryToolKeyStatus.Unknown;
}

export function isCurrentCliBinaryTool(key: string): key is CliBinaryTool {
  return classifyCliBinaryToolKey(key) === CliBinaryToolKeyStatus.Current;
}

export function stripLegacyCliBinaryPaths(
  paths: BinaryPaths | undefined
): CurrentBinaryPaths {
  const current: CurrentBinaryPaths = {};
  for (const [key, value] of Object.entries(paths ?? {})) {
    if (isCurrentCliBinaryTool(key) && typeof value === "string") {
      current[key] = value;
    }
  }
  return current;
}

/**
 * How the binary resolver arrived at its result — the single source of truth
 * for this union. Lives in this framework-free shared module (no Node imports)
 * so both the main-process resolver (`server/shell-path.ts`'s
 * `BinaryResolveResult`) and the renderer Settings panel can reference it
 * without the renderer's browser typecheck pulling in Node-only server code.
 *
 * - `override`: a valid, executable manual override path was used.
 * - `override_invalid`: an override was set but is missing / not executable.
 * - `path`: found on the login-shell PATH.
 * - `known_location`: not on PATH, but found at a probed known install location.
 * - `fallback`: not found anywhere; the bare logical name is returned.
 */
export type BinaryResolveSource =
  | "override"
  | "override_invalid"
  | "path"
  | "known_location"
  | "fallback";
