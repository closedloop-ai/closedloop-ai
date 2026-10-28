/**
 * @file managed-onboarding-controller.test.ts
 * @description Unit tests for `ManagedOnboardingController`
 * (src/main/onboarding/managed-onboarding-controller.ts), the managed/automated
 * onboarding owner extracted from `DesktopApplication` in PLN-1359 Phase 3.
 *
 * Scope: the controller's ORCHESTRATION that is cleanly unit-testable through the
 * injected deps bag — onboarding-state projection, user-change cancellation, and
 * the `maybeAutoProvisionManagedKey` guard ladder (flag gate, already-managed
 * short-circuit, shutdown gate, missing-access-token stop, and signing-key
 * failure). The network/Electron-heavy provisioning and device-onboarding flows
 * call module-level primitives (fetchTrustedDesktopConfig, claimDesktopManagedApiKey,
 * provisionManagedKey, startDeviceOnboarding, …) that are each covered by their
 * own dedicated suites (managed-onboarding, managed-key-provision, bootstrap-claim,
 * desktop-device-onboarding-client); this file does not re-exercise them.
 *
 * The controller harness (real temp-dir `SettingsStore`, `vi.fn()` fakes for
 * every other dep) lives in `helpers/managed-onboarding-controller-harness.ts`,
 * shared with `managed-onboarding-controller-handoff.test.ts` (handoff and
 * provisioning flows) and `managed-onboarding-controller-device.test.ts`
 * (auto-provisioning, browser device onboarding, the onboarding reminder).
 */
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { makeController } from "./helpers/managed-onboarding-controller-harness.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ManagedOnboardingController.getOnboardingState", () => {
  test("reports not-complete with idle managed provisioning by default", () => {
    const h = makeController({ hasApiKey: false });
    const state = h.controller.getOnboardingState();
    assert.equal(state.completed, false);
    assert.equal(state.hasStoredApiKey, false);
    assert.deepEqual(state.managedProvisioning, { status: "idle" });
  });

  test("reflects a stored API key in hasStoredApiKey", () => {
    const h = makeController({ hasApiKey: true });
    const state = h.controller.getOnboardingState();
    assert.equal(state.hasStoredApiKey, true);
  });
});

describe("ManagedOnboardingController.cancelManagedOnboardingForUserChange", () => {
  test("cancels silently (no renderer notification) when state is idle", () => {
    const h = makeController();
    h.controller.cancelManagedOnboardingForUserChange("profile switched");
    // Idle state short-circuits before notifying/resetting the renderer.
    assert.equal(h.desktopWindow.sendToRenderer.mock.calls.length, 0);
    assert.deepEqual(h.controller.getOnboardingState().managedProvisioning, {
      status: "idle",
    });
  });
});

describe("ManagedOnboardingController.maybeAutoProvisionManagedKey", () => {
  test("no-ops when already holding a DESKTOP_MANAGED key", async () => {
    const h = makeController({
      apiKeyProvenance: "DESKTOP_MANAGED",
    });
    await h.controller.maybeAutoProvisionManagedKey();
    assert.equal(h.desktopSessionManager.getAccessToken.mock.calls.length, 0);
  });

  test("no-ops while shutting down", async () => {
    const h = makeController({ shuttingDown: true });
    await h.controller.maybeAutoProvisionManagedKey();
    assert.equal(h.desktopSessionManager.getAccessToken.mock.calls.length, 0);
  });

  test("stops before key work when there is no access token", async () => {
    const h = makeController({
      apiKeyProvenance: "USER_CREATED",
      accessToken: null,
    });
    await h.controller.maybeAutoProvisionManagedKey();
    assert.equal(h.desktopSessionManager.getAccessToken.mock.calls.length, 1);
    assert.equal(h.gatewaySigningKeyStore.getOrCreate.mock.calls.length, 0);
    assert.equal(h.apiKeyStore.setApiKey.mock.calls.length, 0);
  });

  test("reports PoP-unavailable and stops when the signing key cannot be created", async () => {
    const h = makeController({
      apiKeyProvenance: "USER_CREATED",
      accessToken: "desktop-session-jwt",
      getOrCreateResult: { ok: false, reason: "keystore_locked" },
    });
    await h.controller.maybeAutoProvisionManagedKey();
    assert.deepEqual(h.reportDesktopPopUnavailable.mock.calls[0], [
      "managed_key_auto_provision",
      "keystore_locked",
    ]);
    assert.equal(h.apiKeyStore.setApiKey.mock.calls.length, 0);
  });
});

describe("ManagedOnboardingController.runSecurityUpgradeProvisioning", () => {
  test("short-circuits as cancelled (no provisioning side effects) while shutting down", async () => {
    const h = makeController({ shuttingDown: true });
    const result = await h.controller.runSecurityUpgradeProvisioning({
      onboardingAttemptId: "attempt-1",
      webAppOrigin: "https://app.closedloop.ai",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // A shutting-down run is treated as cancelled, so the collapsed method
    // returns { cancelled: true } and never reaches provisioning.
    assert.deepEqual(result, { cancelled: true });
    assert.equal(h.apiKeyStore.setApiKey.mock.calls.length, 0);
    assert.equal(h.telemetryOrgProvider.warm.mock.calls.length, 0);
  });
});
