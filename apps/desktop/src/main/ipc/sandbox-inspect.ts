import { statSync } from "node:fs";
import path from "node:path";
import { isGitRepository } from "../../shared/git-utils.js";
import { expandHomePath } from "../../shared/path-utils.js";
import {
  isPathAtOrUnder,
  isRiskyAllowedDirectory,
  isTccProtectedDirectory,
  tccProtectedDirectories,
} from "../../shared/sandbox-policy.js";

export type SandboxPathInspection = {
  path: string;
  isGitRepo: boolean;
  suggestedPath: string | undefined;
  /**
   * FEA-3641: true when the picked folder is itself a broad/risky root
   * (~, /Users/<name>, a system dir). The renderer surfaces this so the user
   * cannot select it; the authoritative reject happens in the onboarding /
   * settings IPC handlers when the sandbox is persisted.
   */
  isRisky: boolean;
  /**
   * ISS-4577: true when the path resolves to an existing directory on disk.
   * A directory picked via the native dialog always exists, but a value typed
   * into the settings field may not — the Settings sandbox editor surfaces this
   * so a stale/mistyped path is flagged inline instead of the UI lying about a
   * directory that is not there. Undefined when existence could not be probed
   * (a TCC-protected folder we intentionally do not stat).
   */
  exists: boolean | undefined;
};

/**
 * Probe whether a candidate sandbox path is an existing directory, skipping the
 * `statSync` for anything at or under a TCC-protected user folder (Music,
 * Pictures, Documents, …) — mirroring `isGitRepository` (FEA-3641) so we never
 * trigger a macOS permission prompt for a folder that is never a valid sandbox
 * anyway. `isTccProtectedDirectory` only matches the protected folder itself, so
 * we additionally short-circuit *descendants* of a protected root before any
 * filesystem probe (wongk review), otherwise `statSync` on `~/Documents/foo`
 * would still pop the permission prompt. `expandedPath` is the ~-expanded,
 * resolved absolute path (the value the persist layer stats), so a home-relative
 * path such as `~/projects` is probed at its real location rather than a literal
 * `~` entry under the Electron cwd. Returns `undefined` when the probe is skipped
 * so the renderer distinguishes "known missing" from "unknown".
 */
function directoryExists(expandedPath: string): boolean | undefined {
  if (
    isTccProtectedDirectory(expandedPath) ||
    tccProtectedDirectories().some((root) =>
      isPathAtOrUnder(expandedPath, root)
    )
  ) {
    return undefined;
  }
  try {
    return statSync(expandedPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Classify a candidate sandbox base directory: when the picked folder is itself
 * a git repo, suggest its parent (unless that parent is a risky root) so the
 * sandbox scopes a workspace of repos rather than a single repo. Also flags
 * when the picked folder itself is a risky root so the UI can warn, and whether
 * the path exists on disk (ISS-4577) so a typed value can be validated inline.
 *
 * This module is intentionally free of `electron` imports so the classifier is
 * unit-testable under `node:test`; the IPC handlers in `sandbox-ipc.ts` wrap it
 * with sender-trust gating and the native dialog.
 */
export function inspectSandboxPath(targetPath: string): SandboxPathInspection {
  // Probe the ~-expanded, resolved path — the same value the persist layer
  // (`normalizeScopePath`) stats — so a supported home-relative path like
  // `~/projects` is inspected at its real location instead of a literal `~`
  // entry under the Electron cwd (codex/wongk review). `path` stays the raw
  // input so the renderer can match it against the field's trimmed value.
  const expandedPath = path.resolve(expandHomePath(targetPath));
  const isGitRepo = isGitRepository(expandedPath);
  let suggestedPath: string | undefined;
  if (isGitRepo) {
    const candidate = path.dirname(targetPath);
    if (candidate !== targetPath && !isRiskyAllowedDirectory(candidate)) {
      suggestedPath = candidate;
    }
  }
  return {
    path: targetPath,
    isGitRepo,
    suggestedPath,
    isRisky: isRiskyAllowedDirectory(targetPath),
    exists: directoryExists(expandedPath),
  };
}
