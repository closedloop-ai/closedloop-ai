import { randomUUID } from "node:crypto";
import type {
  GatewayApprovalRequest,
  GatewayApprovalResult,
} from "../../server/router.js";
import type { RiskTier } from "../../shared/contracts.js";
import { GATEWAY_DISPATCH_RENDERER_SOURCE } from "../../shared/gateway-dispatch-channel.js";
import { normalizeScopePath } from "../../shared/sandbox-policy.js";
import type { SettingsStore } from "../settings/settings-store.js";
import {
  buildUpdateAndRestartDisabledResult,
  shouldHonorAlwaysAllowRule,
} from "../update/update-and-restart-helpers.js";
import {
  ALWAYS_ALLOW_RULE_TTL_MS,
  matchesAlwaysAllowRule,
  pruneExpiredAlwaysAllowRules,
} from "./always-allow-rules.js";
import { resolveOperationId } from "./approval-operations.js";
import {
  FORCE_INTERACTIVE_OPERATIONS,
  OPERATION_RISK_TIERS,
  shouldAutoApprove,
} from "./approval-policy.js";
import type { ApprovalStore } from "./approval-store.js";

const APPROVAL_TIMEOUT_MS = 120_000;

/**
 * Renderer gateway reads allowed to run before onboarding completes.
 *
 * EMPTY since PLN-1535 M5 deletion 2 retired the three PR overlay routes that
 * were its only members. Kept as the named carve-out so a future
 * setup-independent read is added here deliberately, rather than by loosening
 * the onboarding gate itself.
 */
const SETUP_INDEPENDENT_RENDERER_GATEWAY_READ_PATHS: ReadonlySet<string> =
  new Set<string>();

/**
 * Collaborators the approval evaluator reads from the owning application. Kept
 * as callbacks (rather than the `DesktopApplication` instance) so the evaluator
 * is unit-testable with fakes and never reaches back into the God-object.
 */
export type ApprovalEvaluatorDeps = {
  settingsStore: SettingsStore;
  approvalStore: ApprovalStore;
  /** Onboarding gate — most operations are refused until setup completes. */
  isDesktopSetupComplete: () => boolean;
  /** Debug escape hatch (toggled via debug IPC) that approves everything. */
  isDangerousAutoApprove: () => boolean;
};

/**
 * Decides whether an inbound gateway request is allowed: onboarding/tier gating,
 * always-allow-rule matching, auto-approve policy, and — when none of those
 * short-circuit — enqueuing an interactive approval and awaiting the decision.
 * Extracted from `DesktopApplication` (PLN-1359 Phase 3); behavior unchanged.
 */
export class ApprovalEvaluator {
  private readonly deps: ApprovalEvaluatorDeps;

  constructor(deps: ApprovalEvaluatorDeps) {
    this.deps = deps;
  }

  async evaluate(
    request: GatewayApprovalRequest
  ): Promise<GatewayApprovalResult> {
    if (
      !(
        this.deps.isDesktopSetupComplete() ||
        isSetupIndependentRendererGatewayRead(request)
      )
    ) {
      return {
        allow: false,
        statusCode: 403,
        payload: {
          error: "onboarding not completed",
        },
      };
    }

    if (this.deps.isDangerousAutoApprove()) {
      return { allow: true };
    }

    const operationId = resolveOperationId(request.path);
    if (!operationId) {
      return {
        allow: false,
        statusCode: 403,
        payload: { error: `Unmapped operation: ${request.path}` },
      };
    }

    if (
      operationId === "update_and_restart" &&
      !this.deps.settingsStore.getUpdateAndRestartEnabled()
    ) {
      return buildUpdateAndRestartDisabledResult();
    }

    const settings = this.deps.settingsStore.getAll();
    const requestScopePath = resolveApprovalScopePath(request.body);
    const activeAlwaysAllowRules = pruneExpiredAlwaysAllowRules(
      settings.alwaysAllowRules
    );
    if (activeAlwaysAllowRules.length !== settings.alwaysAllowRules.length) {
      this.deps.settingsStore.setAlwaysAllowRules(activeAlwaysAllowRules);
    }
    const isForceInteractiveOperation = !shouldHonorAlwaysAllowRule(
      operationId,
      FORCE_INTERACTIVE_OPERATIONS as ReadonlySet<string>
    );
    if (
      !isForceInteractiveOperation &&
      matchesAlwaysAllowRule(activeAlwaysAllowRules, {
        operationId,
        method: request.method,
        path: request.path,
        scopePath: requestScopePath,
      })
    ) {
      return { allow: true };
    }

    const configuredTier =
      settings.autoApprovalRules[operationId] ?? settings.defaultApprovalTier;
    // Force-interactive operations skip auto-approve and always go through
    // the interactive approval queue.
    if (
      !isForceInteractiveOperation &&
      shouldAutoApprove(
        operationId,
        configuredTier,
        request.forceApproval ?? false
      )
    ) {
      return { allow: true };
    }

    return await this.enqueueAndAwaitApproval({
      request,
      operationId,
      configuredTier,
      requestScopePath,
      isForceInteractiveOperation,
    });
  }

  /**
   * Enqueue an interactive approval and resolve the request from the human
   * decision: approve/always-allow → allow, expired → 408, denied → 403.
   * `always_allow` on a non-force-interactive operation also persists a rule.
   */
  private async enqueueAndAwaitApproval(params: {
    request: GatewayApprovalRequest;
    operationId: string;
    configuredTier: RiskTier;
    requestScopePath: string | null;
    isForceInteractiveOperation: boolean;
  }): Promise<GatewayApprovalResult> {
    const {
      request,
      operationId,
      configuredTier,
      requestScopePath,
      isForceInteractiveOperation,
    } = params;
    const operationRisk =
      (OPERATION_RISK_TIERS as Record<string, Exclude<RiskTier, "none">>)[
        operationId
      ] ?? "high";
    const reason =
      request.approvalReason?.trim() ||
      `${operationId} is ${operationRisk}-risk, but your auto-approve threshold is ${configuredTier}`;
    const pending = this.deps.approvalStore.enqueue({
      operationId,
      riskTier: operationRisk,
      method: request.method,
      path: request.path,
      body: request.body,
      scopePath: requestScopePath ?? undefined,
      location: describeRequestLocation(request),
      reason,
    });
    const decision = await this.deps.approvalStore.waitForDecision(
      pending.id,
      APPROVAL_TIMEOUT_MS
    );

    if (decision === "always_allow" && !isForceInteractiveOperation) {
      this.saveAlwaysAllowRuleForPending(pending);
    }

    if (decision === "approved" || decision === "always_allow") {
      return { allow: true };
    }

    if (decision === "expired") {
      return {
        allow: false,
        statusCode: 408,
        payload: {
          error: "approval timed out",
          operationId,
          approvalId: pending.id,
        },
      };
    }

    return {
      allow: false,
      statusCode: 403,
      payload: {
        error: "request denied",
        operationId,
        approvalId: pending.id,
      },
    };
  }

  saveAlwaysAllowRuleForPending(pending: {
    operationId: string;
    method: string;
    path: string;
    scopePath?: string;
  }): void {
    const settings = this.deps.settingsStore.getAll();
    const now = Date.now();
    const activeRules = pruneExpiredAlwaysAllowRules(
      settings.alwaysAllowRules,
      now
    );
    const expiresAt = new Date(now + ALWAYS_ALLOW_RULE_TTL_MS).toISOString();

    const existingIndex = activeRules.findIndex(
      (rule) =>
        rule.operationId === pending.operationId &&
        rule.method.toUpperCase() === pending.method.toUpperCase() &&
        rule.path === pending.path &&
        normalizeScopePath(rule.scopePath) ===
          normalizeScopePath(pending.scopePath)
    );

    if (existingIndex >= 0) {
      activeRules[existingIndex] = {
        ...activeRules[existingIndex],
        expiresAt,
      };
    } else {
      activeRules.push({
        id: randomUUID(),
        operationId: pending.operationId,
        method: pending.method.toUpperCase(),
        path: pending.path,
        scopePath: normalizeScopePath(pending.scopePath) ?? undefined,
        createdAt: new Date(now).toISOString(),
        expiresAt,
      });
    }

    this.deps.settingsStore.setAlwaysAllowRules(activeRules);
  }
}

function resolveApprovalScopePath(rawBody: string): string | null {
  if (!rawBody?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    return (
      normalizeScopePath(maybeString(parsed.repoPath)) ??
      normalizeScopePath(maybeString(parsed.worktreePath)) ??
      normalizeScopePath(maybeString(parsed.workDir)) ??
      normalizeScopePath(maybeString(parsed.runDir)) ??
      normalizeScopePath(maybeString(parsed.path))
    );
  } catch {
    return null;
  }
}

function maybeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim();
}

function describeRequestLocation(request: GatewayApprovalRequest): string {
  if (request.source) {
    return request.source;
  }
  if (request.origin) {
    return request.origin;
  }
  if (request.referer) {
    return request.referer;
  }
  if (request.remoteAddress) {
    return request.remoteAddress;
  }
  return "unknown";
}

/**
 * Desktop-renderer branch overlays are local, read-only PR lookups. They must
 * keep working for existing users whose older settings were never marked
 * onboarded, while cloud/browser commands and mutating gateway operations remain
 * setup-gated. The source header is main-held for IPC, and the missing browser
 * Origin/Referer distinguishes the in-process loopback fetch from browser
 * session-token traffic that can set arbitrary request headers.
 */
function isSetupIndependentRendererGatewayRead(
  request: GatewayApprovalRequest
): boolean {
  return (
    request.source === GATEWAY_DISPATCH_RENDERER_SOURCE &&
    request.origin === null &&
    request.referer === null &&
    request.method.toUpperCase() === "GET" &&
    SETUP_INDEPENDENT_RENDERER_GATEWAY_READ_PATHS.has(request.path)
  );
}
