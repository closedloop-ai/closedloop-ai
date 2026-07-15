/**
 * Electron-free operation catalog for the approval system.
 * Extracted from app.ts so it can be imported in plain Node tests.
 */

import {
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
} from "@repo/api/src/types/github-dirty-scope";
import {
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_OPERATION_ID,
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_PATH,
  BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID,
  BROWSER_COMMAND_KEY_REVOKE_PATH,
} from "../shared/contracts.js";

export const SUPPORTED_OPERATION_IDS = [
  "symphony_launch",
  "symphony_loop",
  "symphony_loop_kill",
  "symphony_plan_loop",
  "symphony_status",
  "symphony_kill",
  "symphony_chat",
  "symphony_comment_chat",
  "symphony_commit_message",
  "symphony_sessions",
  "symphony_plan",
  "symphony_judges",
  "symphony_logs",
  "symphony_chat_history",
  "terminal_chat",
  "ticket_chat",
  "run_viewer_chat",
  "codex_review",
  "codex_argue",
  "git_action",
  "git_local_changes",
  "git_local_commit_push",
  "git_pr",
  "git_branch_worktree",
  "health_check",
  "repos_config",
  "deploy",
  "learnings",
  "filesystem",
  "desktop_security_upgrade",
  "binary_paths_settings",
  "update_and_restart",
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID,
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_OPERATION_ID,
] as const;

export type OperationId = (typeof SUPPORTED_OPERATION_IDS)[number];

export function resolveOperationId(pathname: string): OperationId | null {
  if (!pathname.startsWith("/api/gateway/")) {
    return null;
  }

  if (pathname === "/api/gateway/symphony/launch") {
    return "symphony_launch";
  }
  if (pathname === "/api/gateway/symphony/loop") {
    return "symphony_loop";
  }
  if (pathname === "/api/gateway/symphony/loop/kill") {
    return "symphony_loop_kill";
  }
  if (pathname.startsWith("/api/gateway/symphony/plan-loop/")) {
    return "symphony_plan_loop";
  }
  if (
    pathname === "/api/gateway/symphony/status" ||
    pathname.startsWith("/api/gateway/symphony/status/")
  ) {
    return "symphony_status";
  }
  if (pathname === "/api/gateway/symphony/kill") {
    return "symphony_kill";
  }
  if (pathname.startsWith("/api/gateway/symphony/chat/")) {
    return "symphony_chat";
  }
  if (pathname.startsWith("/api/gateway/symphony/comment-chat/")) {
    return "symphony_comment_chat";
  }
  if (pathname.startsWith("/api/gateway/symphony/commit-message/")) {
    return "symphony_commit_message";
  }
  if (pathname === "/api/gateway/symphony/sessions") {
    return "symphony_sessions";
  }
  if (pathname.startsWith("/api/gateway/symphony/plan/")) {
    return "symphony_plan";
  }
  if (pathname.startsWith("/api/gateway/symphony/judges/")) {
    return "symphony_judges";
  }
  if (pathname.startsWith("/api/gateway/symphony/logs/")) {
    return "symphony_logs";
  }
  if (pathname.startsWith("/api/gateway/symphony/chat-history/")) {
    return "symphony_chat_history";
  }
  if (pathname.startsWith("/api/gateway/symphony/pending-learnings")) {
    return "learnings";
  }
  if (pathname.startsWith("/api/gateway/symphony/process-learnings")) {
    return "learnings";
  }
  if (pathname.startsWith("/api/gateway/symphony/process-all-learnings")) {
    return "learnings";
  }
  if (pathname.startsWith("/api/gateway/symphony/extract-learnings")) {
    return "learnings";
  }
  if (pathname.startsWith("/api/gateway/symphony/learnings-status/")) {
    return "learnings";
  }
  if (pathname === "/api/gateway/symphony/record-learning-use") {
    return "learnings";
  }
  if (pathname === "/api/gateway/terminal-chat") {
    return "terminal_chat";
  }
  if (pathname === "/api/gateway/ticket-chat") {
    return "ticket_chat";
  }
  if (pathname === "/api/gateway/run-viewer-chat") {
    return "run_viewer_chat";
  }
  if (pathname.startsWith("/api/gateway/codex/argue/")) {
    return "codex_argue";
  }
  if (pathname.startsWith("/api/gateway/codex/")) {
    return "codex_review";
  }
  if (pathname === "/api/gateway/git/branch-worktree") {
    return "git_branch_worktree";
  }
  if (pathname === GITHUB_RESYNC_NUDGE_PATH) {
    return GITHUB_RESYNC_NUDGE_OPERATION_ID;
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
  if (pathname.startsWith("/api/gateway/git")) {
    return "git_action";
  }
  if (pathname === "/api/gateway/health-check") {
    return "health_check";
  }
  if (pathname === "/api/gateway/security/upgrade") {
    return "desktop_security_upgrade";
  }
  if (pathname.startsWith("/api/gateway/settings/binary-paths")) {
    return "binary_paths_settings";
  }
  if (pathname === BROWSER_COMMAND_KEY_REVOKE_PATH) {
    return BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID;
  }
  if (pathname === BROWSER_COMMAND_KEY_APPROVAL_REQUEST_PATH) {
    return BROWSER_COMMAND_KEY_APPROVAL_REQUEST_OPERATION_ID;
  }
  if (pathname === "/api/gateway/repos") {
    return "repos_config";
  }
  if (pathname.startsWith("/api/gateway/deploy")) {
    return "deploy";
  }
  if (pathname === "/api/gateway/update-and-restart") {
    return "update_and_restart";
  }
  if (pathname === "/api/gateway/learnings") {
    return "learnings";
  }
  if (pathname.startsWith("/api/gateway/work-directory/")) {
    return "filesystem";
  }
  if (pathname.startsWith("/api/gateway/symphony/sessions/")) {
    return "symphony_sessions";
  }
  if (pathname.startsWith("/api/gateway/symphony/attachments/")) {
    return "filesystem";
  }
  if (pathname.startsWith("/api/gateway/symphony/upload/")) {
    return "filesystem";
  }
  if (pathname === "/api/gateway/version") {
    return "health_check";
  }
  if (
    pathname === "/api/gateway/directories" ||
    pathname === "/api/gateway/files/search" ||
    pathname.startsWith("/api/gateway/run-viewer-extract")
  ) {
    return "filesystem";
  }

  return null;
}
