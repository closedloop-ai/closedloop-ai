/**
 * ISS-12521 AC-004: the add-a-directory control's native folder picker.
 *
 * Node-free (no `path`/`os`/`fs`), unlike the main-only readability/TCC
 * checks it reports on, so the renderer can import this file directly for
 * its preload-contract typing (apps/desktop/AGENTS.md "Renderer Rules").
 */
export const DirectoryScopeIpcChannel = {
  PickDirectory: "desktop:pick-directory-scope-entry",
} as const;
export type DirectoryScopeIpcChannel =
  (typeof DirectoryScopeIpcChannel)[keyof typeof DirectoryScopeIpcChannel];

/**
 * What the main process returns for a picked directory: its own filesystem
 * verdicts, not yet the `packages/app` `PickedDirectory` shape the shared
 * `DirectoryScopeListWithAdd` component takes — that type lives in a
 * renderer-only package main cannot import, so the renderer-side adapter
 * does the one-field rename (`path` -> `id`).
 */
export type DirectoryScopePickPayload = {
  /** Absolute path, per ISS-12520's "id is the directory's absolute path". */
  path: string;
  /** Home-relative when under the user's home, else the absolute path. */
  label: string;
  /**
   * `PathReadability.Blocked` or `Unknown` from `file-access-probe.ts`'s
   * `checkPathReadableAsync`. Always `false` when `tccProtected`, which is
   * resolved first and skips the probe entirely.
   */
  unreadable: boolean;
  /** `isTccProtectedPath` (ISS-11914) from `sandbox-policy.ts`. */
  tccProtected: boolean;
};
