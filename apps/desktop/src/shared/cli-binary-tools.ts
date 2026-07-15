/**
 * Canonical list of CLI tools the desktop app can detect and store override
 * paths for.
 *
 * Single source of truth shared by the Settings "CLI Tools" panel (the
 * renderer rows in `SettingsPanel.tsx`) and the main-process detection handler
 * (`desktop:detect-cli-tools` in `app.ts`). Keeping the list here — a
 * framework-free module with no heavy imports — means the displayed tools and
 * the detected tools cannot drift: a tool that isn't detectable can't be shown,
 * and a detectable tool can't be hidden.
 *
 * These keys match the persistable override keys in `settings-store.ts`
 * (`BinaryPaths`) and the gateway route validator (`KNOWN_BINARY_KEYS` in
 * `server/operations/binary-paths.ts`).
 */
export const CLI_BINARY_TOOLS = [
  "claude",
  "gh",
  "codex",
  "cursor",
  "opencode",
  "python3",
  "git",
] as const;
