import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HEALTH_CHECK_REPAIR_OPERATION_ID,
  HEALTH_CHECK_REPAIR_PATH,
} from "@repo/api/src/types/compute-target";
import {
  MEMBER_PACK_INSTALL_OPERATION_ID,
  MEMBER_PACK_INSTALL_PATH,
} from "@repo/api/src/types/member-pack-install";
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
import {
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_OPERATION_ID,
  BROWSER_COMMAND_KEY_APPROVAL_REQUEST_PATH,
  BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID,
  BROWSER_COMMAND_KEY_REVOKE_PATH,
} from "../src/shared/contracts.js";

// --- riskTierOrder ---

test("riskTierOrder returns correct numeric ordering", () => {
  assert.ok(riskTierOrder("none") < riskTierOrder("low"));
  assert.ok(riskTierOrder("low") < riskTierOrder("medium"));
  assert.ok(riskTierOrder("medium") < riskTierOrder("high"));
});

// --- shouldAutoApprove threshold boundary cases ---

test("policy low: auto-approves low-risk, blocks medium and high", () => {
  assert.equal(shouldAutoApprove("health_check", "low", false), true);
  assert.equal(shouldAutoApprove("symphony_loop", "low", false), false);
  assert.equal(shouldAutoApprove("deploy", "low", false), false);
});

test("policy medium: auto-approves low and medium, blocks high", () => {
  assert.equal(shouldAutoApprove("health_check", "medium", false), true);
  assert.equal(shouldAutoApprove("symphony_loop", "medium", false), true);
  assert.equal(shouldAutoApprove("deploy", "medium", false), false);
});

test("policy high: auto-approves all mapped operations", () => {
  assert.equal(shouldAutoApprove("health_check", "high", false), true);
  assert.equal(shouldAutoApprove("symphony_loop", "high", false), true);
  assert.equal(shouldAutoApprove("deploy", "high", false), true);
});

test("policy none: blocks all operations including low-risk", () => {
  assert.equal(shouldAutoApprove("health_check", "none", false), false);
  assert.equal(shouldAutoApprove("symphony_loop", "none", false), false);
  assert.equal(shouldAutoApprove("deploy", "none", false), false);
  assert.equal(shouldAutoApprove("unknown_op", "none", false), false);
});

test("forceApproval overrides threshold", () => {
  assert.equal(shouldAutoApprove("health_check", "low", true), false);
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
  assert.equal(resolveOperationId("/api/gateway/health-check"), "health_check");
  assert.equal(
    resolveOperationId("/api/gateway/symphony/launch"),
    "symphony_launch"
  );
  assert.equal(resolveOperationId("/api/gateway/deploy/anything"), "deploy");
  assert.equal(BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID, "browser_key_revoke");
  assert.equal(
    BROWSER_COMMAND_KEY_REVOKE_PATH,
    "/api/gateway/internal/browser-key/revoke"
  );
  assert.equal(
    BROWSER_COMMAND_KEY_APPROVAL_REQUEST_OPERATION_ID,
    "browser_key_approval_request"
  );
  assert.equal(
    BROWSER_COMMAND_KEY_APPROVAL_REQUEST_PATH,
    "/api/gateway/internal/browser-key/approval-request"
  );
  assert.equal(
    resolveOperationId(BROWSER_COMMAND_KEY_REVOKE_PATH),
    BROWSER_COMMAND_KEY_REVOKE_OPERATION_ID
  );
  assert.equal(
    resolveOperationId(BROWSER_COMMAND_KEY_APPROVAL_REQUEST_PATH),
    BROWSER_COMMAND_KEY_APPROVAL_REQUEST_OPERATION_ID
  );
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

test("resolveOperationId maps previously unmapped routes", () => {
  assert.equal(resolveOperationId("/api/gateway/version"), "health_check");
  assert.equal(
    resolveOperationId("/api/gateway/symphony/status"),
    "symphony_status"
  );
  assert.equal(
    resolveOperationId("/api/gateway/symphony/status/FEAT-1"),
    "symphony_status"
  );
  assert.equal(
    resolveOperationId("/api/gateway/symphony/attachments/FEAT-1/img.png"),
    "filesystem"
  );
  assert.equal(
    resolveOperationId("/api/gateway/symphony/upload/FEAT-1"),
    "filesystem"
  );
});

test("resolveOperationId returns null for truly unknown gateway paths", () => {
  assert.equal(resolveOperationId("/api/gateway/does-not-exist"), null);
});

test("resolveOperationId returns null for paths outside /api/gateway/", () => {
  assert.equal(resolveOperationId("/health"), null);
});

// --- update_and_restart operation ---

test("resolveOperationId maps /api/gateway/update-and-restart to update_and_restart", () => {
  assert.equal(
    resolveOperationId("/api/gateway/update-and-restart"),
    "update_and_restart"
  );
});

test("update_and_restart has high risk tier", () => {
  assert.equal(OPERATION_RISK_TIERS.update_and_restart, "high");
});

test("update_and_restart is in FORCE_INTERACTIVE_OPERATIONS", () => {
  assert.ok(FORCE_INTERACTIVE_OPERATIONS.has("update_and_restart"));
});

test("update_and_restart is included in SUPPORTED_OPERATION_IDS", () => {
  assert.ok(SUPPORTED_OPERATION_IDS.includes("update_and_restart"));
});

// --- System Check Repair (ISS-5389) ---

test("the System Check Repair path resolves to its own operation id", () => {
  // Without this the local GatewayServer's ApprovalEvaluator resolves nothing
  // for the POST and rejects it as an unmapped operation, so Repair could never
  // run in production (ISS-5389 review).
  assert.equal(
    resolveOperationId(HEALTH_CHECK_REPAIR_PATH),
    HEALTH_CHECK_REPAIR_OPERATION_ID
  );
  assert.ok(SUPPORTED_OPERATION_IDS.includes(HEALTH_CHECK_REPAIR_OPERATION_ID));
});

test("Repair does not ride on the read-only health_check operation", () => {
  // Repair mutates the machine, so it must not inherit health_check's low tier
  // or its auto-approval rule.
  assert.notEqual(HEALTH_CHECK_REPAIR_OPERATION_ID, "health_check");
  assert.equal(resolveOperationId("/api/gateway/health-check"), "health_check");
  assert.equal(OPERATION_RISK_TIERS.health_check, "low");
  assert.equal(
    OPERATION_RISK_TIERS[HEALTH_CHECK_REPAIR_OPERATION_ID],
    "medium"
  );
  // A "low" auto-approve threshold lets the read-only check through but not the
  // repair, which is the whole point of giving it its own id.
  assert.equal(shouldAutoApprove("health_check", "low", false), true);
  assert.equal(
    shouldAutoApprove(HEALTH_CHECK_REPAIR_OPERATION_ID, "low", false),
    false
  );
  assert.equal(
    shouldAutoApprove(HEALTH_CHECK_REPAIR_OPERATION_ID, "medium", false),
    true
  );
});
