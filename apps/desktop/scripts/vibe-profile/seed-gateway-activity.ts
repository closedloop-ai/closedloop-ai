import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApprovalEvaluator } from "../../src/main/approvals/approval-evaluator.js";
import { resolveOperationId } from "../../src/main/approvals/approval-operations.js";
import { OPERATION_RISK_TIERS } from "../../src/main/approvals/approval-policy.js";
import { ApprovalStore } from "../../src/main/approvals/approval-store.js";
import { ActivityLogStore } from "../../src/main/diagnostics/activity-log-store.js";
import { SettingsStore } from "../../src/main/settings/settings-store.js";
import { AuthReason } from "../../src/server/gateway-auth-reasons.js";
import { GATEWAY_DISPATCH_RENDERER_SOURCE } from "../../src/shared/gateway-dispatch-channel.js";
import { normalizeScopePath } from "../../src/shared/sandbox-policy.js";
import { mergeProfileSettings } from "./profile-layout";

const MINUTE_MS = 60_000;
const WORKSPACE_DIR = "workspaces";
const WORKSPACE_REPO = "closedloop-ai";

type SeedRequest = {
  readonly minutesAgo: number;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly durationMs: number;
  readonly responseSizeBytes: number;
  readonly securityDetail?: string;
};

/** A morning of gateway traffic. */
const SEED_REQUESTS: readonly SeedRequest[] = [
  {
    minutesAgo: 182,
    method: "GET",
    path: "/api/gateway/settings/binary-paths",
    statusCode: 200,
    durationMs: 4,
    responseSizeBytes: 96,
  },
  {
    minutesAgo: 181,
    method: "GET",
    path: "/api/gateway/directories",
    statusCode: 200,
    durationMs: 412,
    responseSizeBytes: 2140,
  },
  {
    minutesAgo: 175,
    method: "GET",
    path: "/api/gateway/repos",
    statusCode: 200,
    durationMs: 38,
    responseSizeBytes: 1388,
  },
  {
    minutesAgo: 150,
    method: "POST",
    path: "/api/gateway/files/search",
    statusCode: 200,
    durationMs: 121,
    responseSizeBytes: 5310,
  },
  {
    minutesAgo: 141,
    method: "GET",
    path: "/api/gateway/git/local-changes",
    statusCode: 200,
    durationMs: 87,
    responseSizeBytes: 3962,
  },
  {
    minutesAgo: 40,
    method: "POST",
    path: "/api/gateway/git/pr",
    statusCode: 201,
    durationMs: 2230,
    responseSizeBytes: 402,
  },
  {
    minutesAgo: 22,
    method: "GET",
    path: "/api/gateway/repos",
    statusCode: 401,
    durationMs: 2,
    responseSizeBytes: 58,
    securityDetail: AuthReason.OriginNotAllowed,
  },
  {
    minutesAgo: 6,
    method: "GET",
    path: "/api/gateway/git/local-changes/diff",
    statusCode: 200,
    durationMs: 388,
    responseSizeBytes: 2140,
  },
];

type SeedApproval = {
  readonly path: string;
  readonly reason: string;
  /** Resolved "always allow", the way a user answers it from the Approvals view. */
  readonly alwaysAllow: boolean;
};

const SEED_APPROVALS: readonly SeedApproval[] = [
  {
    path: "/api/gateway/git/pr",
    reason: "Open a pull request for the branch the review loop finished.",
    alwaysAllow: true,
  },
  {
    path: "/api/gateway/git/local-changes/commit-push",
    reason: "Commit and push the accepted review fixes.",
    alwaysAllow: false,
  },
];

export type GatewayActivityCounts = {
  readonly requests: number;
  readonly pendingApprovals: number;
  readonly alwaysAllowRules: number;
};

/**
 * The Gateway Request Log and the Approvals queue as the running app leaves
 * them, written through the stores the app persists them with:
 * `ActivityLogStore.add` (the gateway router's activity callback), and
 * `ApprovalStore.enqueue` plus, for an "always allow" answer, the Approvals
 * IPC's own pair `ApprovalEvaluator.saveAlwaysAllowRuleForPending` then
 * `ApprovalStore.alwaysAllow`. The rule lands in a scratch `SettingsStore`
 * (whose boot migrations must not touch the profile's settings, which
 * `sign-in` writes later) and only its `alwaysAllowRules` are merged into the
 * profile.
 */
export function seedGatewayActivity(
  profileDir: string,
  now: Date
): GatewayActivityCounts {
  const activity = new ActivityLogStore({ cwd: profileDir });
  for (const request of SEED_REQUESTS) {
    activity.add({
      type: request.securityDetail ? "security" : "request",
      timestamp: new Date(
        now.getTime() - request.minutesAgo * MINUTE_MS
      ).toISOString(),
      method: request.method,
      path: request.path,
      statusCode: request.statusCode,
      durationMs: request.durationMs,
      responseSizeBytes: request.responseSizeBytes,
      detail: request.securityDetail,
    });
  }

  const scratch = mkdtempSync(path.join(tmpdir(), "vibe-profile-settings-"));
  try {
    const settingsStore = new SettingsStore({ cwd: scratch });
    const approvalStore = new ApprovalStore({ cwd: profileDir });
    const evaluator = new ApprovalEvaluator({
      settingsStore,
      approvalStore,
      isDesktopSetupComplete: () => true,
      isDangerousAutoApprove: () => false,
    });
    const repoPath = path.join(profileDir, WORKSPACE_DIR, WORKSPACE_REPO);
    const scopePath = normalizeScopePath(repoPath) ?? undefined;
    for (const approval of SEED_APPROVALS) {
      const operationId = resolveOperationId(approval.path);
      if (!operationId) {
        throw new Error(`${approval.path} maps to no gateway operation`);
      }
      const pending = approvalStore.enqueue({
        operationId,
        riskTier: OPERATION_RISK_TIERS[operationId],
        method: "POST",
        path: approval.path,
        body: JSON.stringify({ repoPath }),
        scopePath,
        location: GATEWAY_DISPATCH_RENDERER_SOURCE,
        reason: approval.reason,
      });
      if (approval.alwaysAllow) {
        evaluator.saveAlwaysAllowRuleForPending(pending);
        approvalStore.alwaysAllow(pending.id);
      }
    }
    const { alwaysAllowRules } = settingsStore.getAll();
    mergeProfileSettings(profileDir, { alwaysAllowRules });
    return {
      requests: activity.list().length,
      pendingApprovals: approvalStore.countPending(),
      alwaysAllowRules: alwaysAllowRules.length,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
