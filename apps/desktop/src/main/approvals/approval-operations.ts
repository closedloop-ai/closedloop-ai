/**
 * Electron-free operation catalog for the approval system.
 * Extracted from app.ts so it can be imported in plain Node tests.
 */

import {
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
} from "@repo/api/src/types/github-dirty-scope";
import {
  MEMBER_PACK_INSTALL_OPERATION_ID,
  MEMBER_PACK_INSTALL_PATH,
} from "@repo/api/src/types/member-pack-install";

export const SUPPORTED_OPERATION_IDS = [
  "git_action",
  "git_local_changes",
  "git_local_commit_push",
  "git_pr",
  "git_branch_worktree",
  "repos_config",
  "filesystem",
  "desktop_security_upgrade",
  "binary_paths_settings",
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  MEMBER_PACK_INSTALL_OPERATION_ID,
] as const;

export type OperationId = (typeof SUPPORTED_OPERATION_IDS)[number];

export function resolveOperationId(pathname: string): OperationId | null {
  if (!pathname.startsWith("/api/gateway/")) {
    return null;
  }

  if (pathname === "/api/gateway/git/branch-worktree") {
    return "git_branch_worktree";
  }
  if (pathname === GITHUB_RESYNC_NUDGE_PATH) {
    return GITHUB_RESYNC_NUDGE_OPERATION_ID;
  }
  if (pathname === MEMBER_PACK_INSTALL_PATH) {
    return MEMBER_PACK_INSTALL_OPERATION_ID;
  }
  if (
    pathname === "/api/gateway/git/local-changes" ||
    pathname === "/api/gateway/git/local-changes/diff"
  ) {
    return "git_local_changes";
  }
  if (pathname === "/api/gateway/git/local-changes/commit-push") {
    return "git_local_commit_push";
  }
  if (
    pathname.startsWith("/api/gateway/git/pr") ||
    pathname === "/api/gateway/git/user"
  ) {
    return "git_pr";
  }
  // ISS-8049: the separator is load-bearing — a bare `/api/gateway/git`
  // prefix also matches `/api/gateway/github/*` ("github" startsWith "git").
  if (
    pathname === "/api/gateway/git" ||
    pathname.startsWith("/api/gateway/git/")
  ) {
    return "git_action";
  }
  if (pathname === "/api/gateway/security/upgrade") {
    return "desktop_security_upgrade";
  }
  if (pathname.startsWith("/api/gateway/settings/binary-paths")) {
    return "binary_paths_settings";
  }
  if (pathname === "/api/gateway/repos") {
    return "repos_config";
  }
  if (
    pathname === "/api/gateway/directories" ||
    pathname === "/api/gateway/files/search"
  ) {
    return "filesystem";
  }

  return null;
}
