/**
 * @file managed-onboarding-controller-device.test.ts
 * @description ISS-10308 coverage for the sign-in-driven flows of
 * `ManagedOnboardingController`: managed-key auto-provisioning (single-flight
 * guard, provisioned vs not), browser device onboarding (start failure,
 * verification-URL allowlist, the poll loop through errors, pending, approval,
 * denial, expiry and cancellation), and the launch-time onboarding reminder.
 *
 * Managed-key provision, device start/poll, trusted config and the onboarding
 * status fetch are faked at the module boundary — each is pinned by its own
 * suite. Trusted config defaults to a non-retryable failure so an approved
 * device session stops before any claim. Poll pacing runs on fake timers.
 * Pins current behavior; no source changes.
 */
import assert from "node:assert/strict";
import { DesktopDeviceSessionStatus } from "@repo/api/src/types/onboarding";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { Observability } from "../src/main/telemetry/observability.js";
import { silenceWarnings } from "./helpers/gateway-log-spies.js";
import {
  deferred,
  failedState,
  MANUAL_ONLY,
  MANUAL_THEN_RETRY,
  makeController,
  type RetryOptions,
  WEB_APP_ORIGIN,
} from "./helpers/managed-onboarding-controller-harness.js";

const mocks = vi.hoisted(() => ({
  fetchTrustedDesktopConfig: vi.fn(),
  withSingleManagedOnboardingRetry: vi.fn(),
  provisionManagedKey: vi.fn(),
  startDeviceOnboarding: vi.fn(),
  pollDeviceOnboarding: vi.fn(),
  fetchOnboardingStatus: vi.fn(),
}));

vi.mock(
  "../src/main/onboarding/managed-onboarding.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    fetchTrustedDesktopConfig: mocks.fetchTrustedDesktopConfig,
    withSingleManagedOnboardingRetry: mocks.withSingleManagedOnboardingRetry,
  })
);
vi.mock(
  "../src/main/auth/managed-key-provision.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    provisionManagedKey: mocks.provisionManagedKey,
  })
);
vi.mock(
  "../src/main/onboarding/desktop-device-onboarding-client.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    startDeviceOnboarding: mocks.startDeviceOnboarding,
    pollDeviceOnboarding: mocks.pollDeviceOnboarding,
  })
);
vi.mock(
  "../src/main/onboarding/onboarding-popup.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    fetchOnboardingStatus: mocks.fetchOnboardingStatus,
  })
);

const FAKE_NOW = new Date("2026-09-15T12:00:00.000Z");
const VERIFICATION_URL = `${WEB_APP_ORIGIN}/desktop/connect?code=ABCD`;
const CLEANUP_UNAVAILABLE_RE = /unavailable during sign-out cleanup/;
const APPROVED = {
  status: DesktopDeviceSessionStatus.Approved,
  onboardingAttemptId: "attempt-9",
  webAppOrigin: WEB_APP_ORIGIN,
  expiresAt: "2026-09-15T12:10:00.000Z",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.withSingleManagedOnboardingRetry.mockImplementation(
    (options: RetryOptions) => options.operation()
  );
  mocks.fetchTrustedDesktopConfig.mockResolvedValue({
    kind: "failed",
    reason: "invalid_response",
    retryable: false,
    error: "x",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function started(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    value: {
      deviceSessionId: "ds-1",
      deviceSessionSecret: "secret",
      userCode: "ABCD",
      verificationUrl: VERIFICATION_URL,
      pollIntervalSeconds: 0.5,
      expiresAt: new Date(FAKE_NOW.getTime() + 60_000).toISOString(),
      ...overrides,
    },
  };
}

function pollResults(...results: unknown[]) {
  for (const result of results) {
    mocks.pollDeviceOnboarding.mockResolvedValueOnce(result);
  }
}

function useFakeClock() {
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW);
}

describe("maybeAutoProvisionManagedKey — provisioning", () => {
  function provisioningController() {
    return makeController({
      apiKeyProvenance: "USER_CREATED",
      accessToken: "desktop-session-jwt",
      getOrCreateResult: { ok: true, keyPair: { publicKeySpkiPem: "PEM" } },
    });
  }

  test("provisions with the device key and stores the result as DESKTOP_MANAGED", async () => {
    const h = provisioningController();
    mocks.provisionManagedKey.mockResolvedValue({
      kind: "provisioned",
      apiKey: "sk_live_new",
    });
    h.signDesktopRequest.mockReturnValue({ "x-pop": "signed" });

    await h.controller.maybeAutoProvisionManagedKey();

    const args = mocks.provisionManagedKey.mock.calls[0]?.[0];
    assert.equal(args.apiOrigin, h.settingsStore.getApiOrigin());
    assert.equal(args.gatewayId, "gateway-1");
    assert.equal(args.gatewayPublicKeyPem, "PEM");
    assert.equal(args.accessToken, "desktop-session-jwt");
    const request = { method: "POST", path: "/x" };
    assert.deepEqual(args.popSigner(request), { "x-pop": "signed" });
    assert.deepEqual(h.signDesktopRequest.mock.calls, [[request]]);
    assert.deepEqual(h.apiKeyStore.setApiKey.mock.calls, [
      ["sk_live_new", "DESKTOP_MANAGED"],
    ]);
    assert.deepEqual(h.persistActiveProfileKey.mock.calls, [
      ["sk_live_new", "DESKTOP_MANAGED"],
    ]);
    assert.deepEqual(h.persistActiveConfigManagedMetadata.mock.calls, [
      [
        {
          apiKeySource: "DESKTOP_MANAGED",
          gatewayId: "gateway-1",
          gatewayPublicKeyPem: "PEM",
        },
      ],
    ]);
    assert.equal(
      h.desktopSessionManager.refreshExistingUserResolution.mock.calls.length,
      1
    );
    assert.equal(h.telemetryOrgProvider.warm.mock.calls.length, 1);
    assert.equal(h.restartCloudSocket.mock.calls.length, 1);
  });

  test("a non-provisioned result stores nothing and releases the single-flight guard", async () => {
    const h = provisioningController();
    silenceWarnings();
    mocks.provisionManagedKey.mockResolvedValue({ kind: "pop_unavailable" });

    await h.controller.maybeAutoProvisionManagedKey();
    await h.controller.maybeAutoProvisionManagedKey();

    assert.equal(h.apiKeyStore.setApiKey.mock.calls.length, 0);
    assert.equal(h.desktopSessionManager.getAccessToken.mock.calls.length, 2);
  });

  test("a call that arrives while one is in flight is dropped", async () => {
    const h = provisioningController();
    const token = deferred<string | null>();
    h.desktopSessionManager.getAccessToken.mockReturnValue(token.promise);

    const first = h.controller.maybeAutoProvisionManagedKey();
    await h.controller.maybeAutoProvisionManagedKey();
    token.resolve(null);
    await first;

    assert.equal(h.desktopSessionManager.getAccessToken.mock.calls.length, 1);
  });
});

test("sign-out cleanup refuses a new device-onboarding run before network work", async () => {
  const h = makeController({ credentialMutationAllowed: false });

  await assert.rejects(
    h.controller.startDesktopFirstDeviceOnboarding(),
    CLEANUP_UNAVAILABLE_RE
  );

  assert.equal(mocks.startDeviceOnboarding.mock.calls.length, 0);
});

describe("startDesktopFirstDeviceOnboarding", () => {
  const descriptor = { gatewayId: "gateway-1", publicKeyPem: "PEM" };

  test("a failed start throws before any state change or browser launch", async () => {
    const h = makeController({ deviceDescriptor: descriptor });
    mocks.startDeviceOnboarding.mockResolvedValue({
      ok: false,
      error: { kind: "network" },
      retryable: true,
    });

    await assert.rejects(
      h.controller.startDesktopFirstDeviceOnboarding(WEB_APP_ORIGIN),
      { message: "Could not start browser connection" }
    );

    assert.deepEqual(mocks.startDeviceOnboarding.mock.calls, [
      [
        {
          apiOrigin: h.settingsStore.getApiOrigin(),
          webAppOrigin: WEB_APP_ORIGIN,
          ...descriptor,
        },
      ],
    ]);
    assert.equal(h.openExternalUrl.mock.calls.length, 0);
    assert.deepEqual(h.controller.getOnboardingState().managedProvisioning, {
      status: "idle",
    });
  });

  test("without an explicit origin it starts against the stored web app origin", async () => {
    const h = makeController();
    mocks.startDeviceOnboarding.mockResolvedValue({
      ok: false,
      error: { kind: "network" },
      retryable: true,
    });

    await assert.rejects(h.controller.startDesktopFirstDeviceOnboarding());

    assert.equal(
      mocks.startDeviceOnboarding.mock.calls[0]?.[0].webAppOrigin,
      h.settingsStore.getWebAppOrigin()
    );
  });

  test("a verification URL off the configured web app origin is refused before launch", async () => {
    const h = makeController();
    mocks.startDeviceOnboarding.mockResolvedValue(
      started({ verificationUrl: "https://evil.example/connect" })
    );

    await assert.rejects(
      h.controller.startDesktopFirstDeviceOnboarding(WEB_APP_ORIGIN),
      { message: "Could not start browser connection" }
    );

    assert.equal(h.openExternalUrl.mock.calls.length, 0);
  });

  // Pins current behavior; looks odd because the call reports "approved" even
  // though the provisioning it hands off to then fails at the trusted-config
  // step and stores no key.
  test("polls past an error and a pending decision to an approval, confirms the origin, and hands off to provisioning", async () => {
    useFakeClock();
    const h = makeController();
    silenceWarnings();
    mocks.startDeviceOnboarding.mockResolvedValue(started());
    pollResults(
      { ok: false, error: { kind: "network" }, retryable: true },
      { ok: true, value: { status: DesktopDeviceSessionStatus.Pending } },
      { ok: true, value: APPROVED }
    );
    let stateAtLaunch: unknown;
    h.openExternalUrl.mockImplementation(() => {
      stateAtLaunch = h.controller.getOnboardingState().managedProvisioning;
      return Promise.resolve();
    });

    const pending =
      h.controller.startDesktopFirstDeviceOnboarding(WEB_APP_ORIGIN);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;

    assert.deepEqual(result, {
      status: "approved",
      verificationUrl: VERIFICATION_URL,
    });
    assert.deepEqual(h.openExternalUrl.mock.calls, [[VERIFICATION_URL]]);
    assert.deepEqual(stateAtLaunch, {
      status: "provisioning",
      webAppOrigin: WEB_APP_ORIGIN,
      message: "Waiting for browser approval...",
    });
    assert.equal(mocks.pollDeviceOnboarding.mock.calls.length, 3);
    assert.deepEqual(mocks.pollDeviceOnboarding.mock.calls[0], [
      {
        apiOrigin: h.settingsStore.getApiOrigin(),
        deviceSessionId: "ds-1",
        deviceSessionSecret: "secret",
      },
    ]);
    assert.equal(h.showMessageBox.mock.calls.length, 1);
    assert.deepEqual(mocks.fetchTrustedDesktopConfig.mock.calls, [
      [{ webAppOrigin: WEB_APP_ORIGIN }],
    ]);
    assert.deepEqual(
      h.controller.getOnboardingState().managedProvisioning,
      failedState(
        "Desktop could not validate the trusted web app config. Use manual setup or start again from the web app.",
        MANUAL_ONLY
      )
    );
    assert.equal(h.apiKeyStore.setApiKey.mock.calls.length, 0);
  });

  test("a denied decision fails with recovery actions and returns pending", async () => {
    useFakeClock();
    const h = makeController();
    const warn = silenceWarnings();
    mocks.startDeviceOnboarding.mockResolvedValue(started());
    pollResults({
      ok: true,
      value: { status: DesktopDeviceSessionStatus.Denied },
    });

    const pending =
      h.controller.startDesktopFirstDeviceOnboarding(WEB_APP_ORIGIN);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    assert.deepEqual(result, {
      status: "pending",
      verificationUrl: VERIFICATION_URL,
    });
    const message =
      "Browser connection was not approved. Use manual setup or start again.";
    assert.deepEqual(
      h.controller.getOnboardingState().managedProvisioning,
      failedState(message, MANUAL_THEN_RETRY)
    );
    assert.deepEqual(warn.mock.calls.at(-1), [
      "managed-onboarding",
      `device_session_denied: ${message}`,
    ]);
  });

  test("an approval whose origin confirmation is dismissed fails as canceled and returns pending", async () => {
    useFakeClock();
    const h = makeController();
    silenceWarnings();
    mocks.startDeviceOnboarding.mockResolvedValue(started());
    pollResults({ ok: true, value: APPROVED });
    h.showMessageBox.mockResolvedValue({ response: 1 });

    const pending =
      h.controller.startDesktopFirstDeviceOnboarding(WEB_APP_ORIGIN);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    assert.deepEqual(result, {
      status: "pending",
      verificationUrl: VERIFICATION_URL,
    });
    assert.deepEqual(
      h.controller.getOnboardingState().managedProvisioning,
      failedState(
        "Browser connection was canceled. Use manual setup or start again.",
        MANUAL_THEN_RETRY
      )
    );
    assert.equal(mocks.fetchTrustedDesktopConfig.mock.calls.length, 0);
  });

  test("an already-expired window never polls and fails as expired", async () => {
    const h = makeController();
    silenceWarnings();
    mocks.startDeviceOnboarding.mockResolvedValue(
      started({ expiresAt: "2000-01-01T00:00:00.000Z" })
    );

    const result =
      await h.controller.startDesktopFirstDeviceOnboarding(WEB_APP_ORIGIN);

    assert.deepEqual(result, {
      status: "pending",
      verificationUrl: VERIFICATION_URL,
    });
    assert.equal(mocks.pollDeviceOnboarding.mock.calls.length, 0);
    assert.deepEqual(
      h.controller.getOnboardingState().managedProvisioning,
      failedState(
        "Browser connection expired. Use manual setup or start again.",
        MANUAL_THEN_RETRY
      )
    );
  });

  // Pins current behavior; looks odd because a user-initiated cancel mid-poll
  // is reported to the user as an EXPIRED browser session, not as a cancel.
  test("a user change during polling ends the loop and is reported as expired", async () => {
    useFakeClock();
    const h = makeController();
    silenceWarnings();
    mocks.startDeviceOnboarding.mockResolvedValue(started());
    mocks.pollDeviceOnboarding.mockImplementation(() => {
      h.controller.cancelManagedOnboardingForUserChange("signed out");
      return Promise.resolve({
        ok: true,
        value: { status: DesktopDeviceSessionStatus.Pending },
      });
    });

    const pending =
      h.controller.startDesktopFirstDeviceOnboarding(WEB_APP_ORIGIN);
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;

    assert.deepEqual(result, {
      status: "pending",
      verificationUrl: VERIFICATION_URL,
    });
    assert.equal(mocks.pollDeviceOnboarding.mock.calls.length, 1);
    assert.deepEqual(
      h.controller.getOnboardingState().managedProvisioning,
      failedState(
        "Browser connection expired. Use manual setup or start again.",
        MANUAL_THEN_RETRY
      )
    );
  });
});

describe("maybeShowOnboardingPopup", () => {
  test("a permanently dismissed reminder never fetches status", async () => {
    const h = makeController({ setupComplete: true, hasApiKey: true });
    h.settingsStore.setOnboardingPopupDismissedPermanent(true);
    await h.controller.maybeShowOnboardingPopup();
    assert.equal(mocks.fetchOnboardingStatus.mock.calls.length, 0);
  });

  test("incomplete setup or a missing API key never fetches status", async () => {
    for (const options of [
      { setupComplete: false, hasApiKey: true },
      { setupComplete: true, hasApiKey: false },
    ]) {
      const h = makeController(options);
      await h.controller.maybeShowOnboardingPopup();
      assert.equal(h.desktopWindow.sendToRenderer.mock.calls.length, 0);
    }
    assert.equal(mocks.fetchOnboardingStatus.mock.calls.length, 0);
  });

  test("a completed web wizard permanently suppresses the reminder", async () => {
    const h = makeController({ setupComplete: true, hasApiKey: true });
    const suppressed = vi
      .spyOn(Observability, "onboardingPopupSuppressedAuto")
      .mockImplementation(() => undefined);
    mocks.fetchOnboardingStatus.mockResolvedValue({
      kind: "ok",
      wizardCompleted: true,
    });

    await h.controller.maybeShowOnboardingPopup();

    assert.deepEqual(mocks.fetchOnboardingStatus.mock.calls, [
      [{ apiOrigin: h.settingsStore.getApiOrigin(), apiKey: "sk_live_x" }],
    ]);
    assert.equal(h.settingsStore.getOnboardingPopupDismissedPermanent(), true);
    assert.equal(suppressed.mock.calls.length, 1);
    assert.equal(h.desktopWindow.sendToRenderer.mock.calls.length, 0);
  });

  test("an incomplete wizard, or a failed status fetch, shows the reminder", async () => {
    const shown = vi
      .spyOn(Observability, "onboardingPopupShown")
      .mockImplementation(() => undefined);
    for (const statusResult of [
      { kind: "ok", wizardCompleted: false },
      { kind: "failed", reason: "http_error", error: "500" },
    ]) {
      const h = makeController({ setupComplete: true, hasApiKey: true });
      mocks.fetchOnboardingStatus.mockResolvedValue(statusResult);

      await h.controller.maybeShowOnboardingPopup();

      assert.deepEqual(h.desktopWindow.sendToRenderer.mock.calls, [
        ["desktop:show-onboarding-popup"],
      ]);
      assert.equal(
        h.settingsStore.getOnboardingPopupDismissedPermanent(),
        false
      );
    }
    assert.equal(shown.mock.calls.length, 2);
  });

  test("an exception is logged with its reason and swallowed (Error or not)", async () => {
    for (const rejection of [new Error("offline"), "offline"]) {
      vi.restoreAllMocks();
      const h = makeController({ setupComplete: true, hasApiKey: true });
      const warn = silenceWarnings();
      mocks.fetchOnboardingStatus.mockRejectedValue(rejection);

      await h.controller.maybeShowOnboardingPopup();

      assert.deepEqual(warn.mock.calls, [
        ["onboarding-popup", "maybeShowOnboardingPopup failed: offline"],
      ]);
      assert.equal(h.desktopWindow.sendToRenderer.mock.calls.length, 0);
    }
  });
});

describe("device onboarding poll pacing, expiry boundary and approved origin", () => {
  const denied = {
    ok: true,
    value: { status: DesktopDeviceSessionStatus.Denied },
  };

  test("a sub-second server interval is floored to one second between polls", async () => {
    useFakeClock();
    const h = makeController();
    silenceWarnings();
    mocks.startDeviceOnboarding.mockResolvedValue(
      started({ pollIntervalSeconds: 0.5 })
    );
    pollResults(denied);

    const pending =
      h.controller.startDesktopFirstDeviceOnboarding(WEB_APP_ORIGIN);
    await vi.advanceTimersByTimeAsync(999);
    assert.equal(mocks.pollDeviceOnboarding.mock.calls.length, 0);
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    assert.equal(mocks.pollDeviceOnboarding.mock.calls.length, 1);
  });

  test("a server interval above the one-second floor is honored between polls", async () => {
    useFakeClock();
    const h = makeController();
    silenceWarnings();
    mocks.startDeviceOnboarding.mockResolvedValue(
      started({ pollIntervalSeconds: 3 })
    );
    pollResults(denied);

    const pending =
      h.controller.startDesktopFirstDeviceOnboarding(WEB_APP_ORIGIN);
    await vi.advanceTimersByTimeAsync(2999);
    assert.equal(mocks.pollDeviceOnboarding.mock.calls.length, 0);
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    assert.equal(mocks.pollDeviceOnboarding.mock.calls.length, 1);
  });

  test("a window that expires exactly now is already expired and never polls", async () => {
    useFakeClock();
    const h = makeController();
    silenceWarnings();
    mocks.startDeviceOnboarding.mockResolvedValue(
      started({ expiresAt: FAKE_NOW.toISOString() })
    );

    const result =
      await h.controller.startDesktopFirstDeviceOnboarding(WEB_APP_ORIGIN);

    assert.deepEqual(result, {
      status: "pending",
      verificationUrl: VERIFICATION_URL,
    });
    assert.equal(mocks.pollDeviceOnboarding.mock.calls.length, 0);
  });

  test("the origin prompt shows the web app origin the device session approved", async () => {
    useFakeClock();
    const h = makeController();
    silenceWarnings();
    const approvedOrigin = "https://approved.closedloop.example";
    mocks.startDeviceOnboarding.mockResolvedValue(started());
    pollResults({
      ok: true,
      value: { ...APPROVED, webAppOrigin: approvedOrigin },
    });
    h.showMessageBox.mockResolvedValue({ response: 1 });

    const pending =
      h.controller.startDesktopFirstDeviceOnboarding(WEB_APP_ORIGIN);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;

    const dialog = h.showMessageBox.mock.calls[0]?.[0] as { detail?: string };
    assert.equal(dialog.detail, approvedOrigin);
  });
});
