import assert from "node:assert/strict";
import {
  GITHUB_RESYNC_NUDGE_OPERATION_ID,
  GITHUB_RESYNC_NUDGE_PATH,
} from "@repo/api/src/types/github-dirty-scope";
import {
  MEMBER_PACK_INSTALL_OPERATION_ID,
  MEMBER_PACK_INSTALL_PATH,
} from "@repo/api/src/types/member-pack-install";
import { test } from "vitest";
import {
  resolveOperationId,
  SUPPORTED_OPERATION_IDS,
} from "../src/main/approvals/approval-operations.js";
import {
  FORCE_INTERACTIVE_OPERATIONS,
  OPERATION_RISK_TIERS,
  riskTierOrder,
  shouldAutoApprove,
} from "../src/main/approvals/approval-policy.js";

// --- riskTierOrder ---

test("riskTierOrder returns correct numeric ordering", () => {
  assert.ok(riskTierOrder("none") < riskTierOrder("low"));
  assert.ok(riskTierOrder("low") < riskTierOrder("medium"));
  assert.ok(riskTierOrder("medium") < riskTierOrder("high"));
});

// --- shouldAutoApprove threshold boundary cases ---

test("policy low: auto-approves low-risk, blocks medium and high", () => {
  assert.equal(shouldAutoApprove("git_local_changes", "low", false), true);
  assert.equal(shouldAutoApprove("git_action", "low", false), false);
  assert.equal(shouldAutoApprove("git_local_commit_push", "low", false), false);
});

test("policy medium: auto-approves low and medium, blocks high", () => {
  assert.equal(shouldAutoApprove("git_local_changes", "medium", false), true);
  assert.equal(shouldAutoApprove("git_action", "medium", false), true);
  assert.equal(
    shouldAutoApprove("git_local_commit_push", "medium", false),
    false
  );
});

test("policy high: auto-approves all mapped operations", () => {
  assert.equal(shouldAutoApprove("git_local_changes", "high", false), true);
  assert.equal(shouldAutoApprove("git_action", "high", false), true);
  assert.equal(shouldAutoApprove("git_local_commit_push", "high", false), true);
});

test("policy none: blocks all operations including low-risk", () => {
  assert.equal(shouldAutoApprove("git_local_changes", "none", false), false);
  assert.equal(shouldAutoApprove("git_action", "none", false), false);
  assert.equal(
    shouldAutoApprove("git_local_commit_push", "none", false),
    false
  );
  assert.equal(shouldAutoApprove("unknown_op", "none", false), false);
});

test("forceApproval overrides threshold", () => {
  assert.equal(shouldAutoApprove("git_local_changes", "low", true), false);
});

test("git_local_commit_push is force-interactive even at high auto-approval", () => {
  assert.equal(shouldAutoApprove("git_local_commit_push", "high", false), true);
  assert.ok(FORCE_INTERACTIVE_OPERATIONS.has("git_local_commit_push"));
});

test("Branch View local operations are registered in approval catalogs and renderer labels", () => {
  assert.ok(SUPPORTED_OPERATION_IDS.includes("git_local_changes"));
  assert.ok(SUPPORTED_OPERATION_IDS.includes("git_local_commit_push"));
  assert.equal(OPERATION_RISK_TIERS.git_local_changes, "low");
  assert.equal(OPERATION_RISK_TIERS.git_local_commit_push, "high");

  // FEA-1497 (Phase 0): the Branch View path->operationId mapping is owned by
  // the first-party gateway (resolveOperationId), so assert it there directly
  // instead of string-matching the monolithic index.html that PR #264 replaced
  // with the React renderer. The human-readable renderer labels ("Branch View
  // Local Changes" / "Commit and Push Local Changes") now live in React
  // components and are re-guarded in Phase 1.
  assert.equal(
    resolveOperationId("/api/gateway/git/local-changes"),
    "git_local_changes"
  );
  assert.equal(
    resolveOperationId("/api/gateway/git/local-changes/diff"),
    "git_local_changes"
  );
  assert.equal(
    resolveOperationId("/api/gateway/git/local-changes/commit-push"),
    "git_local_commit_push"
  );
});

test("github paths never resolve to git_action — 'github' startsWith 'git' (ISS-8049)", () => {
  assert.equal(
    resolveOperationId(GITHUB_RESYNC_NUDGE_PATH),
    GITHUB_RESYNC_NUDGE_OPERATION_ID
  );
  // An unknown github path must stay unresolved, not fall into git_action's
  // risk tier through the bare-git prefix.
  assert.equal(resolveOperationId("/api/gateway/github/future-endpoint"), null);
  // The bare git route and its subpaths keep their operation.
  assert.equal(resolveOperationId("/api/gateway/git"), "git_action");
  assert.equal(resolveOperationId("/api/gateway/git/worktree"), "git_action");
});

// --- Unknown operation defaults to high ---

test("unknown operation defaults to high risk", () => {
  assert.equal(shouldAutoApprove("unknown_op", "low", false), false);
  assert.equal(shouldAutoApprove("unknown_op", "medium", false), false);
  assert.equal(shouldAutoApprove("unknown_op", "high", false), true);
});

// --- Map sync ---

test("OPERATION_RISK_TIERS keys exactly match SUPPORTED_OPERATION_IDS", () => {
  assert.deepEqual(
    Object.keys(OPERATION_RISK_TIERS).sort(),
    SUPPORTED_OPERATION_IDS.slice().sort()
  );
});

// --- resolveOperationId routing ---

test("resolveOperationId maps known paths correctly", () => {
  assert.equal(resolveOperationId("/api/gateway/repos"), "repos_config");
  assert.equal(
    resolveOperationId(MEMBER_PACK_INSTALL_PATH),
    MEMBER_PACK_INSTALL_OPERATION_ID
  );
  assert.ok(
    (SUPPORTED_OPERATION_IDS as readonly string[]).includes(
      MEMBER_PACK_INSTALL_OPERATION_ID
    ),
    "member_pack_install must be advertised so the node accepts the cloud command and getEnabledOperations lists it"
  );
  assert.equal(
    resolveOperationId("/api/gateway/git/local-changes"),
    "git_local_changes"
  );
  assert.equal(
    resolveOperationId("/api/gateway/git/local-changes/diff"),
    "git_local_changes"
  );
  assert.equal(
    resolveOperationId("/api/gateway/git/local-changes/commit-push"),
    "git_local_commit_push"
  );
  assert.equal(resolveOperationId("/api/gateway/git"), "git_action");
});

test("resolveOperationId returns null for truly unknown gateway paths", () => {
  assert.equal(resolveOperationId("/api/gateway/does-not-exist"), null);
});

test("resolveOperationId returns null for paths outside /api/gateway/", () => {
  assert.equal(resolveOperationId("/health"), null);
});
