/**
 * @file approval-evaluator.test.ts
 * @description Unit tests for `ApprovalEvaluator` (src/main/approvals/approval-evaluator.ts),
 * the security-critical gateway-request gate extracted from `DesktopApplication`
 * in PLN-1359 Phase 3. These tests exercise the evaluator's ORCHESTRATION —
 * onboarding gating, the dangerous-auto-approve escape hatch, operation
 * resolution, the update_and_restart feature gate, always-allow-rule matching
 * and pruning, tier-based auto-approve, force-interactive handling, and the
 * enqueue-and-await-decision tail — against real `SettingsStore`/`ApprovalStore`
 * collaborators. The pure helpers it composes (approval-policy, approval-operations,
 * always-allow-rules, approval-store) each have their own dedicated tests.
 *
 * `evaluate()` runs synchronously through `approvalStore.enqueue()` and only
 * suspends at `approvalStore.waitForDecision()`. Tests exploit this: they invoke
 * `evaluate()` without awaiting, read the freshly-enqueued pending, resolve it
 * via approve/deny/alwaysAllow, then await — driving the real decision path with
 * no timers. The `expired` branch mocks `waitForDecision` to avoid the 120s wait.
 *
 * Every `ApprovalStore` here is built with a temp-dir `cwd` (via
 * makeIsolatedApprovalStore) so tests never touch the shared production
 * "desktop-approvals" store file. The runner executes test files concurrently
 * (separate processes, one hardcoded store name), so an un-isolated store would
 * cross-contaminate sibling suites — the failure PLN-1359 Phase 4 fixed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { vi } from "vitest";
import { ALWAYS_ALLOW_RULE_TTL_MS } from "../src/main/approvals/always-allow-rules.js";
import { ApprovalEvaluator } from "../src/main/approvals/approval-evaluator.js";
import { ApprovalStore } from "../src/main/approvals/approval-store.js";
import { SettingsStore } from "../src/main/settings/settings-store.js";
import type { GatewayApprovalRequest } from "../src/server/router.js";
import type { AlwaysAllowRule, RiskTier } from "../src/shared/contracts.js";
import { GATEWAY_DISPATCH_RENDERER_SOURCE } from "../src/shared/gateway-dispatch-channel.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

const tempDirs: string[] = [];

// Fixed clock for the expiry/refresh tests (AGENTS.md: expiry/freshness behavior
// must pin time with fake timers rather than the real wall clock).
const FIXED_NOW = Date.parse("2026-01-01T00:00:00.000Z");

afterEach(() => {
  vi.restoreAllMocks();
  nodeTestTimers.reset();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeSettingsStore(seed?: {
  defaultApprovalTier?: RiskTier;
  autoApprovalRules?: Record<string, RiskTier>;
  alwaysAllowRules?: AlwaysAllowRule[];
  updateAndRestartEnabled?: boolean;
}): SettingsStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-eval-"));
  tempDirs.push(tmpDir);
  const store = new SettingsStore({ cwd: tmpDir, name: "test-settings" });
  if (seed?.defaultApprovalTier) {
    store.setDefaultApprovalTier(seed.defaultApprovalTier);
  }
  if (seed?.autoApprovalRules) {
    store.setAutoApprovalRules(seed.autoApprovalRules);
  }
  if (seed?.alwaysAllowRules) {
    store.setAlwaysAllowRules(seed.alwaysAllowRules);
  }
  if (seed?.updateAndRestartEnabled !== undefined) {
    store.setUpdateAndRestartEnabled(seed.updateAndRestartEnabled);
  }
  return store;
}

function makeRequest(
  overrides: Partial<GatewayApprovalRequest> = {}
): GatewayApprovalRequest {
  return {
    method: "GET",
    path: "/api/gateway/health-check",
    body: "",
    origin: null,
    referer: null,
    userAgent: null,
    remoteAddress: null,
    source: null,
    forceApproval: false,
    approvalReason: null,
    ...overrides,
  };
}

function makeRule(overrides: Partial<AlwaysAllowRule> = {}): AlwaysAllowRule {
  const now = Date.now();
  return {
    id: "rule-1",
    operationId: "git_pr",
    method: "GET",
    path: "/api/gateway/git/pr/files",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

type EvaluatorHarness = {
  evaluator: ApprovalEvaluator;
  settingsStore: SettingsStore;
  approvalStore: ApprovalStore;
};

/**
 * Build an ApprovalStore with an isolated temp-dir cwd so it never touches the
 * shared production "desktop-approvals" store file (see the file header).
 */
function makeIsolatedApprovalStore(): ApprovalStore {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "approval-store-"));
  tempDirs.push(tmpDir);
  return new ApprovalStore({ cwd: tmpDir });
}

function makeEvaluator(options?: {
  settings?: Parameters<typeof makeSettingsStore>[0];
  setupComplete?: boolean;
  dangerous?: boolean;
}): EvaluatorHarness {
  const settingsStore = makeSettingsStore(options?.settings);
  const approvalStore = makeIsolatedApprovalStore();
  const evaluator = new ApprovalEvaluator({
    settingsStore,
    approvalStore,
    isDesktopSetupComplete: () => options?.setupComplete ?? true,
    isDangerousAutoApprove: () => options?.dangerous ?? false,
  });
  return { evaluator, settingsStore, approvalStore };
}

/**
 * Invoke evaluate() (suspends at waitForDecision after a real enqueue), capture
 * the single freshly-enqueued pending, resolve it via `resolve`, then await.
 */
async function evaluateWithDecision(
  harness: EvaluatorHarness,
  request: GatewayApprovalRequest,
  resolve: (store: ApprovalStore, id: string) => void
) {
  const promise = harness.evaluator.evaluate(request);
  const pending = harness.approvalStore.listPending();
  if (pending.length !== 1) {
    throw new Error(
      `expected exactly one enqueued approval, got ${pending.length}`
    );
  }
  resolve(harness.approvalStore, pending[0].id);
  return { result: await promise, pending: pending[0] };
}

describe("ApprovalEvaluator onboarding gate", () => {
  test("refuses operations before onboarding completes", async () => {
    const harness = makeEvaluator({ setupComplete: false });
    const result = await harness.evaluator.evaluate(
      makeRequest({ path: "/api/gateway/health-check" })
    );
    assert.deepEqual(result, {
      allow: false,
      statusCode: 403,
      payload: { error: "onboarding not completed" },
    });
  });

  // PLN-1535 M5 deletion 2 emptied the setup-independent carve-out: its only
  // members were the three PR overlay routes, now retired. The gate is closed to
  // everything before onboarding, INCLUDING the paths it used to let through —
  // which is what this asserts, so re-opening the carve-out has to be a
  // deliberate edit here rather than a silent widening.
  test("no longer exempts the retired PR reads from the onboarding gate", async () => {
    const harness = makeEvaluator({ setupComplete: false });
    const result = await harness.evaluator.evaluate(
      makeRequest({
        method: "GET",
        path: "/api/gateway/git/pr/files",
        source: GATEWAY_DISPATCH_RENDERER_SOURCE,
        origin: null,
        referer: null,
      })
    );
    assert.equal(result.allow, false);
    assert.equal(result.allow === false && result.statusCode, 403);
  });

  test("still gates a renderer read whose method is not GET", async () => {
    const harness = makeEvaluator({ setupComplete: false });
    const result = await harness.evaluator.evaluate(
      makeRequest({
        method: "POST",
        path: "/api/gateway/git/pr/files",
        source: GATEWAY_DISPATCH_RENDERER_SOURCE,
      })
    );
    assert.equal(result.allow, false);
    assert.equal(result.allow === false && result.statusCode, 403);
  });

  test("still gates a renderer read whose path is not whitelisted", async () => {
    const harness = makeEvaluator({ setupComplete: false });
    const result = await harness.evaluator.evaluate(
      makeRequest({
        method: "GET",
        path: "/api/gateway/git/pr/comments",
        source: GATEWAY_DISPATCH_RENDERER_SOURCE,
      })
    );
    assert.equal(result.allow, false);
  });

  test("still gates a whitelisted read that carries a browser Origin", async () => {
    const harness = makeEvaluator({ setupComplete: false });
    const result = await harness.evaluator.evaluate(
      makeRequest({
        method: "GET",
        path: "/api/gateway/git/pr/files",
        source: GATEWAY_DISPATCH_RENDERER_SOURCE,
        origin: "https://app.closedloop.ai",
      })
    );
    assert.equal(result.allow, false);
  });
});

describe("ApprovalEvaluator short-circuits", () => {
  test("bypasses all checks under dangerous auto-approve", async () => {
    const harness = makeEvaluator({
      dangerous: true,
      settings: { defaultApprovalTier: "low" },
    });
    // A high-risk op that would otherwise enqueue.
    const result = await harness.evaluator.evaluate(
      makeRequest({ method: "POST", path: "/api/gateway/deploy" })
    );
    assert.deepEqual(result, { allow: true });
    assert.equal(harness.approvalStore.countPending(), 0);
  });

  test("rejects an unmapped gateway path", async () => {
    const harness = makeEvaluator();
    const result = await harness.evaluator.evaluate(
      makeRequest({ path: "/api/gateway/does-not-exist" })
    );
    assert.deepEqual(result, {
      allow: false,
      statusCode: 403,
      payload: { error: "Unmapped operation: /api/gateway/does-not-exist" },
    });
  });

  test("rejects a non-gateway path", async () => {
    const harness = makeEvaluator();
    const result = await harness.evaluator.evaluate(
      makeRequest({ path: "/not-the-gateway" })
    );
    assert.equal(result.allow, false);
    assert.equal(
      result.allow === false && result.payload.error,
      "Unmapped operation: /not-the-gateway"
    );
  });

  test("blocks update_and_restart when the feature setting is disabled", async () => {
    const harness = makeEvaluator({
      settings: { updateAndRestartEnabled: false },
    });
    const result = await harness.evaluator.evaluate(
      makeRequest({ method: "POST", path: "/api/gateway/update-and-restart" })
    );
    assert.deepEqual(result, {
      allow: false,
      statusCode: 501,
      payload: { error: "feature_disabled", feature: "update_and_restart" },
    });
  });
});

describe("ApprovalEvaluator auto-approve and always-allow", () => {
  test("auto-approves when the operation risk is within the configured tier", async () => {
    const harness = makeEvaluator({ settings: { defaultApprovalTier: "low" } });
    const result = await harness.evaluator.evaluate(
      makeRequest({ path: "/api/gateway/health-check" })
    );
    assert.deepEqual(result, { allow: true });
    assert.equal(harness.approvalStore.countPending(), 0);
  });

  test("does NOT auto-approve when risk exceeds the configured tier", async () => {
    const harness = makeEvaluator({ settings: { defaultApprovalTier: "low" } });
    // git_pr is medium-risk; low tier must not auto-approve → enqueues.
    const { result, pending } = await evaluateWithDecision(
      harness,
      makeRequest({ method: "GET", path: "/api/gateway/git/pr/files" }),
      (store, id) => store.approve(id)
    );
    assert.deepEqual(result, { allow: true });
    assert.equal(pending.operationId, "git_pr");
    assert.equal(pending.riskTier, "medium");
  });

  test("honors a matching, active always-allow rule", async () => {
    const harness = makeEvaluator({
      settings: {
        defaultApprovalTier: "low",
        alwaysAllowRules: [makeRule()],
      },
    });
    const result = await harness.evaluator.evaluate(
      makeRequest({ method: "GET", path: "/api/gateway/git/pr/files" })
    );
    assert.deepEqual(result, { allow: true });
    assert.equal(harness.approvalStore.countPending(), 0);
  });

  test("prunes expired always-allow rules and persists the pruned set", async () => {
    nodeTestTimers.enable(["Date"], { now: FIXED_NOW });
    const expiredRule = makeRule({
      id: "expired",
      expiresAt: new Date(FIXED_NOW - 1000).toISOString(),
    });
    const harness = makeEvaluator({
      settings: {
        defaultApprovalTier: "low",
        alwaysAllowRules: [expiredRule],
      },
    });
    // health_check auto-approves; the expired rule is pruned + persisted first.
    await harness.evaluator.evaluate(
      makeRequest({ path: "/api/gateway/health-check" })
    );
    assert.deepEqual(harness.settingsStore.getAll().alwaysAllowRules, []);
  });

  test("forces interactive approval for a force-interactive op despite tier + rule", async () => {
    const forcePath = "/api/gateway/git/local-changes/commit-push";
    const harness = makeEvaluator({
      settings: {
        // Both of these WOULD short-circuit a non-force-interactive op.
        defaultApprovalTier: "high",
        alwaysAllowRules: [
          makeRule({
            operationId: "git_local_commit_push",
            method: "POST",
            path: forcePath,
          }),
        ],
      },
    });
    const { result, pending } = await evaluateWithDecision(
      harness,
      makeRequest({ method: "POST", path: forcePath }),
      (store, id) => store.approve(id)
    );
    assert.deepEqual(result, { allow: true });
    assert.equal(pending.operationId, "git_local_commit_push");
  });
});

describe("ApprovalEvaluator interactive decisions", () => {
  const deployRequest = () =>
    makeRequest({
      method: "POST",
      path: "/api/gateway/deploy",
      source: "Local Desktop",
    });

  test("enqueues and allows when the human approves", async () => {
    const harness = makeEvaluator({ settings: { defaultApprovalTier: "low" } });
    const { result, pending } = await evaluateWithDecision(
      harness,
      deployRequest(),
      (store, id) => store.approve(id)
    );
    assert.deepEqual(result, { allow: true });
    assert.equal(pending.operationId, "deploy");
    assert.equal(pending.riskTier, "high");
    assert.equal(pending.location, "Local Desktop");
  });

  test("enqueues and denies when the human denies", async () => {
    const harness = makeEvaluator({ settings: { defaultApprovalTier: "low" } });
    const { result, pending } = await evaluateWithDecision(
      harness,
      deployRequest(),
      (store, id) => store.deny(id)
    );
    assert.equal(result.allow, false);
    assert.equal(result.allow === false && result.statusCode, 403);
    assert.deepEqual(result.allow === false && result.payload, {
      error: "request denied",
      operationId: "deploy",
      approvalId: pending.id,
    });
  });

  test("returns 408 when the approval expires", async () => {
    const harness = makeEvaluator({ settings: { defaultApprovalTier: "low" } });
    vi.spyOn(harness.approvalStore, "waitForDecision").mockImplementation(
      async () => "expired" as const
    );
    const result = await harness.evaluator.evaluate(deployRequest());
    assert.equal(result.allow, false);
    assert.equal(result.allow === false && result.statusCode, 408);
    assert.equal(
      result.allow === false && result.payload.error,
      "approval timed out"
    );
    assert.equal(
      result.allow === false && result.payload.operationId,
      "deploy"
    );
  });

  test("saves an always-allow rule when the human selects always-allow", async () => {
    const harness = makeEvaluator({ settings: { defaultApprovalTier: "low" } });
    const { result } = await evaluateWithDecision(
      harness,
      deployRequest(),
      (store, id) => store.alwaysAllow(id)
    );
    assert.deepEqual(result, { allow: true });
    const rules = harness.settingsStore.getAll().alwaysAllowRules;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].operationId, "deploy");
    assert.equal(rules[0].method, "POST");
    assert.equal(rules[0].path, "/api/gateway/deploy");
  });

  test("does NOT save a rule for a force-interactive always-allow decision", async () => {
    const forcePath = "/api/gateway/git/local-changes/commit-push";
    const harness = makeEvaluator({ settings: { defaultApprovalTier: "low" } });
    const { result } = await evaluateWithDecision(
      harness,
      makeRequest({ method: "POST", path: forcePath }),
      (store, id) => store.alwaysAllow(id)
    );
    assert.deepEqual(result, { allow: true });
    assert.deepEqual(harness.settingsStore.getAll().alwaysAllowRules, []);
  });

  test("threads the request scope path into the enqueued approval", async () => {
    const harness = makeEvaluator({ settings: { defaultApprovalTier: "low" } });
    const { pending } = await evaluateWithDecision(
      harness,
      makeRequest({
        method: "POST",
        path: "/api/gateway/deploy",
        body: JSON.stringify({ repoPath: "/tmp/my-repo" }),
      }),
      (store, id) => store.approve(id)
    );
    assert.equal(pending.scopePath, "/tmp/my-repo");
  });
});

describe("ApprovalEvaluator.saveAlwaysAllowRuleForPending", () => {
  test("adds a new normalized rule", () => {
    const settingsStore = makeSettingsStore();
    const approvalStore = makeIsolatedApprovalStore();
    const evaluator = new ApprovalEvaluator({
      settingsStore,
      approvalStore,
      isDesktopSetupComplete: () => true,
      isDangerousAutoApprove: () => false,
    });
    evaluator.saveAlwaysAllowRuleForPending({
      operationId: "deploy",
      method: "post",
      path: "/api/gateway/deploy",
    });
    const rules = settingsStore.getAll().alwaysAllowRules;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].operationId, "deploy");
    assert.equal(rules[0].method, "POST", "method is upper-cased");
  });

  test("refreshes an existing matching rule's expiry to now + TTL", () => {
    nodeTestTimers.enable(["Date"], { now: FIXED_NOW });
    const stale = makeRule({
      operationId: "deploy",
      method: "POST",
      path: "/api/gateway/deploy",
      expiresAt: new Date(FIXED_NOW + 1000).toISOString(),
    });
    const settingsStore = makeSettingsStore({ alwaysAllowRules: [stale] });
    const approvalStore = makeIsolatedApprovalStore();
    const evaluator = new ApprovalEvaluator({
      settingsStore,
      approvalStore,
      isDesktopSetupComplete: () => true,
      isDangerousAutoApprove: () => false,
    });
    evaluator.saveAlwaysAllowRuleForPending({
      operationId: "deploy",
      method: "POST",
      path: "/api/gateway/deploy",
    });
    const rules = settingsStore.getAll().alwaysAllowRules;
    assert.equal(rules.length, 1, "no duplicate rule created");
    assert.equal(rules[0].id, stale.id, "existing rule updated in place");
    assert.equal(
      rules[0].expiresAt,
      new Date(FIXED_NOW + ALWAYS_ALLOW_RULE_TTL_MS).toISOString(),
      "expiry refreshed to now + TTL"
    );
  });
});
