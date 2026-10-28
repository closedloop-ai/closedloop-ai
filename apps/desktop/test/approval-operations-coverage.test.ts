import { HEALTH_CHECK_REPAIR_PATH } from "@repo/api/src/types/compute-target";
import {
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
} from "@repo/api/src/types/github-dirty-scope";
import {
  MEMBER_PACK_INSTALL_OPERATION_ID,
  MEMBER_PACK_INSTALL_PATH,
} from "@repo/api/src/types/member-pack-install";
import { describe, expect, it, vi } from "vitest";
import {
  type OperationId,
  resolveOperationId,
  SUPPORTED_OPERATION_IDS,
} from "../src/main/approvals/approval-operations.js";
import {
  admitInboundCloudCommand,
  type CloudCommandAdmissionDeps,
} from "../src/main/cloud/cloud-command-admission.js";
import type { DesktopCommandEvent } from "../src/main/cloud/cloud-protocol.js";
import { PROTOCOL_VERSION } from "../src/main/cloud/cloud-protocol.js";
import { COMMAND_ACK_REJECTION_REASONS } from "../src/shared/ack-reasons.js";

/**
 * Route table for `resolveOperationId`. The function is an ordered chain of
 * exact and prefix matches, so each row names one path and the id it must
 * resolve to. The expected ids are literal strings on purpose: they are the
 * persisted keys of `autoApprovalRules` and always-allow rules, so a rename
 * in source must break this table.
 */
const ROUTES: ReadonlyArray<readonly [string, OperationId]> = [
  ["/api/gateway/git/pr/123", "git_pr"],
  ["/api/gateway/git/user", "git_pr"],
  [MEMBER_PACK_INSTALL_PATH, MEMBER_PACK_INSTALL_OPERATION_ID],
  [GITHUB_RESYNC_NUDGE_PATH, GITHUB_RESYNC_NUDGE_OPERATION_ID],
  ["/api/gateway/security/upgrade", "desktop_security_upgrade"],
  ["/api/gateway/settings/binary-paths", "binary_paths_settings"],
  ["/api/gateway/settings/binary-paths/claude", "binary_paths_settings"],
  ["/api/gateway/repos", "repos_config"],
  ["/api/gateway/directories", "filesystem"],
  ["/api/gateway/files/search", "filesystem"],
];

/**
 * ISS-12435: gateway routes removed with Loops. A version-skewed cloud can
 * still dispatch them; each must resolve to no operation so admission answers
 * the generic unroutable rejection.
 */
const RETIRED_LOOP_PATHS: readonly string[] = [
  "/api/gateway/symphony/loop",
  "/api/gateway/symphony/loop/kill",
  "/api/gateway/symphony/plan-loop/FEAT-1",
  "/api/gateway/symphony/launch",
  "/api/gateway/symphony/status",
  "/api/gateway/symphony/status/FEAT-1",
  "/api/gateway/symphony/kill",
  "/api/gateway/symphony/chat/FEAT-1",
  "/api/gateway/symphony/comment-chat/FEAT-1",
  "/api/gateway/symphony/commit-message/FEAT-1",
  "/api/gateway/symphony/sessions",
  "/api/gateway/symphony/sessions/abc",
  "/api/gateway/symphony/plan/FEAT-1",
  "/api/gateway/symphony/judges/FEAT-1",
  "/api/gateway/symphony/logs/FEAT-1",
  "/api/gateway/symphony/chat-history/FEAT-1",
  "/api/gateway/symphony/attachments/FEAT-1/file",
  "/api/gateway/symphony/upload/FEAT-1",
  "/api/gateway/run-viewer-chat",
  "/api/gateway/run-viewer-extract",
  "/api/gateway/codex/review/FEAT-1",
  "/api/gateway/codex/argue/FEAT-1",
  "/api/gateway/deploy",
  "/api/gateway/deploy/health",
  "/api/gateway/work-directory/FEAT-1",
];

/**
 * ISS-12735: the learnings gateway routes were deleted. A version-skewed cloud
 * can still dispatch them; each must resolve to no operation so admission
 * answers the generic unroutable rejection.
 */
const RETIRED_LEARNINGS_PATHS: readonly string[] = [
  "/api/gateway/learnings",
  "/api/gateway/learnings/extra",
  "/api/gateway/symphony/pending-learnings",
  "/api/gateway/symphony/process-learnings",
  "/api/gateway/symphony/process-all-learnings",
  "/api/gateway/symphony/extract-learnings",
  "/api/gateway/symphony/learnings-status/FEAT-1",
  "/api/gateway/symphony/record-learning-use",
];

/**
 * ISS-12749: the System Check health-check, Repair and version routes were
 * deleted. A version-skewed cloud can still dispatch them; each must resolve to
 * no operation so admission answers the generic unroutable rejection.
 */
const RETIRED_SYSTEM_CHECK_PATHS: readonly string[] = [
  "/api/gateway/health-check",
  HEALTH_CHECK_REPAIR_PATH,
  "/api/gateway/version",
];

/**
 * ISS-12784: the browser command-key routes were removed with browser command
 * signing. A version-skewed cloud can still dispatch them; each must resolve to
 * no operation so admission answers the generic unroutable rejection.
 */
const RETIRED_BROWSER_KEY_PATHS: readonly string[] = [
  "/api/gateway/internal/browser-key/revoke",
  "/api/gateway/internal/browser-key/approval-request",
];

/** Paths inside the gateway prefix that no branch claims. */
const UNROUTED_PATHS: readonly string[] = [
  "/api/gateway/",
  "/api/gateway/symphony/loop/extra",
  "/api/gateway/symphony/launch/extra",
  "/api/gateway/terminal-chat",
  "/api/gateway/ticket-chat",
  "/api/gateway/terminal-chat/extra",
  "/api/gateway/repos/extra",
  "/api/gateway/files",
  "/api/gateway/directories/child",
  "/api/gateway/work-directory",
  "/api/gateway/security/upgrade/extra",
];

function makeCommand(path: string, operationId: string): DesktopCommandEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: "message-1",
    timestamp: "2026-09-17T00:00:00.000Z",
    commandId: "command-1",
    operationId,
    method: "POST",
    path,
  };
}

function makeDeps(): CloudCommandAdmissionDeps {
  return {
    sendCommandAck: vi.fn(),
    handleGitHubResyncNudgeCommand: vi.fn(),
    isDesktopSetupComplete: vi.fn(() => true),
    areCloudCommandsPaused: vi.fn(() => false),
    enqueue: vi.fn(),
  };
}

describe("resolveOperationId route table", () => {
  it.each(ROUTES)("maps %s to %s", (pathname, expected) => {
    expect(resolveOperationId(pathname)).toBe(expected);
  });

  it("only ever resolves to an id listed in SUPPORTED_OPERATION_IDS", () => {
    const supported = new Set<string>(SUPPORTED_OPERATION_IDS);
    for (const [pathname] of ROUTES) {
      const resolved = resolveOperationId(pathname);
      expect(resolved === null ? null : supported.has(resolved)).toBe(true);
    }
  });

  it.each(UNROUTED_PATHS)("returns null for unclaimed path %s", (pathname) => {
    expect(resolveOperationId(pathname)).toBeNull();
  });

  it.each(RETIRED_LOOP_PATHS)(
    "returns null for retired loop path %s",
    (pathname) => {
      expect(resolveOperationId(pathname)).toBeNull();
    }
  );

  it.each(RETIRED_LEARNINGS_PATHS)(
    "returns null for retired learnings path %s",
    (pathname) => {
      expect(resolveOperationId(pathname)).toBeNull();
    }
  );

  it.each(RETIRED_SYSTEM_CHECK_PATHS)(
    "returns null for retired System Check path %s",
    (pathname) => {
      expect(resolveOperationId(pathname)).toBeNull();
    }
  );

  it.each(RETIRED_BROWSER_KEY_PATHS)(
    "returns null for retired browser-key path %s",
    (pathname) => {
      expect(resolveOperationId(pathname)).toBeNull();
    }
  );
});

describe("resolveOperationId specific-before-generic ordering", () => {
  it("routes git/branch-worktree before the git/ catch-all", () => {
    expect(resolveOperationId("/api/gateway/git/branch-worktree")).toBe(
      "git_branch_worktree"
    );
    expect(resolveOperationId("/api/gateway/git/branch-worktree/child")).toBe(
      "git_action"
    );
  });

  it("routes both local-changes paths and commit-push before the git/ catch-all", () => {
    expect(resolveOperationId("/api/gateway/git/local-changes")).toBe(
      "git_local_changes"
    );
    expect(resolveOperationId("/api/gateway/git/local-changes/diff")).toBe(
      "git_local_changes"
    );
    expect(
      resolveOperationId("/api/gateway/git/local-changes/commit-push")
    ).toBe("git_local_commit_push");
    expect(resolveOperationId("/api/gateway/git/local-changes/other")).toBe(
      "git_action"
    );
  });

  it("routes git/pr and git/user to git_pr before the git/ catch-all", () => {
    expect(resolveOperationId("/api/gateway/git/pr")).toBe("git_pr");
    expect(resolveOperationId("/api/gateway/git/user")).toBe("git_pr");
    expect(resolveOperationId("/api/gateway/git/user/extra")).toBe(
      "git_action"
    );
  });

  it("pins the ISS-10558 defect: git/pr matches by bare prefix, so git/prune resolves to git_pr", () => {
    // ISS-10558: a known defect, not a contract. `startsWith("/api/gateway/git/pr")`
    // has no separator (the shape ISS-8049 fixed for `git`), so an unrelated
    // `prune` route takes git_pr's tier. Flip this when ISS-10558 lands.
    expect(resolveOperationId("/api/gateway/git/prune")).toBe("git_pr");
  });

  it("does not let github/* fall into the git catch-all", () => {
    expect(resolveOperationId("/api/gateway/github")).toBeNull();
    expect(resolveOperationId("/api/gateway/github/other")).toBeNull();
    expect(resolveOperationId(GITHUB_RESYNC_NUDGE_PATH)).toBe(
      GITHUB_RESYNC_NUDGE_OPERATION_ID
    );
  });
});

describe("resolveOperationId through cloud command admission", () => {
  it("enqueues a command whose path resolves to an operation", () => {
    const deps = makeDeps();
    const command = makeCommand("/api/gateway/repos", "relay-proxy-uuid");

    admitInboundCloudCommand(command, deps);

    expect(deps.enqueue).toHaveBeenCalledWith(command);
    expect(deps.sendCommandAck).not.toHaveBeenCalled();
  });

  it("rejects an old loop dispatch as unroutable and enqueues nothing", () => {
    const deps = makeDeps();

    admitInboundCloudCommand(
      makeCommand("/api/gateway/symphony/loop", "symphony_loop"),
      deps
    );

    expect(deps.sendCommandAck).toHaveBeenCalledWith({
      commandId: "command-1",
      accepted: false,
      state: "failed",
      reason: COMMAND_ACK_REJECTION_REASONS.unroutableOperation,
    });
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it("rejects an unrouted gateway path as unroutable and enqueues nothing", () => {
    const deps = makeDeps();

    admitInboundCloudCommand(
      makeCommand("/api/gateway/github/other", "relay-proxy-uuid"),
      deps
    );

    expect(deps.sendCommandAck).toHaveBeenCalledWith({
      commandId: "command-1",
      accepted: false,
      state: "failed",
      reason: COMMAND_ACK_REJECTION_REASONS.unroutableOperation,
    });
    expect(deps.enqueue).not.toHaveBeenCalled();
  });
});
