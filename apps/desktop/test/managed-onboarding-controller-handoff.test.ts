/**
 * @file managed-onboarding-controller-handoff.test.ts
 * @description ISS-10308 coverage for the installer-handoff flows of
 * `ManagedOnboardingController`: open-file intake and queueing, every handoff
 * read result, origin confirmation, the trusted-config and managed-key claim
 * failure ladders, the claimed-key success path (safe vs risky sandbox), the
 * security-upgrade entry, and user-change cancellation.
 *
 * The module-level primitives (handoff read, trusted config, claim, repo
 * seeding) are faked at the module boundary — each is pinned by its own suite —
 * so this file drives the controller's orchestration branch by branch. The
 * single-retry wrapper is faked to run its operation once; its `shouldRetry` /
 * `delayMs` / `isCancelled` wiring is asserted directly. Pins current behavior;
 * no source changes.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { getCanonicalOnboardingHandoffPath } from "../src/main/onboarding/onboarding-handoff.js";
import { silenceWarnings } from "./helpers/gateway-log-spies.js";
import {
  type ControllerHarness,
  deferred,
  failedState,
  handoff,
  MANUAL_ONLY,
  MANUAL_THEN_RETRY,
  makeController,
  RETRY_THEN_MANUAL,
  type RetryOptions,
  WEB_APP_ORIGIN,
} from "./helpers/managed-onboarding-controller-harness.js";

const mocks = vi.hoisted(() => ({
  readPendingOnboardingHandoff: vi.fn(),
  fetchTrustedDesktopConfig: vi.fn(),
  withSingleManagedOnboardingRetry: vi.fn(),
  claimDesktopManagedApiKey: vi.fn(),
  seedReposConfig: vi.fn(),
}));

vi.mock(
  "../src/main/onboarding/onboarding-handoff.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    readPendingOnboardingHandoff: mocks.readPendingOnboardingHandoff,
  })
);
vi.mock(
  "../src/main/onboarding/managed-onboarding.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    fetchTrustedDesktopConfig: mocks.fetchTrustedDesktopConfig,
    withSingleManagedOnboardingRetry: mocks.withSingleManagedOnboardingRetry,
  })
);
vi.mock(
  "../src/main/onboarding/bootstrap-claim.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    claimDesktopManagedApiKey: mocks.claimDesktopManagedApiKey,
  })
);
vi.mock(
  "../src/main/settings/seed-repos-config.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    seedReposConfig: mocks.seedReposConfig,
  })
);

const TRUSTED_API_ORIGIN = "https://api.trusted.example";
const TRUSTED_RELAY_ORIGIN = "https://relay.trusted.example";
const MANAGED_KEY = "sk_live_managed";
/** Nonexistent absolute path: canonicalizes lexically, so it is safe on every OS. */
const SAFE_SANDBOX = path.join(
  path.parse(process.cwd()).root,
  "iss-10308-sandbox",
  "projects"
);

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.readPendingOnboardingHandoff.mockResolvedValue({ kind: "absent" });
  mocks.withSingleManagedOnboardingRetry.mockImplementation(
    (options: RetryOptions) => options.operation()
  );
  mocks.fetchTrustedDesktopConfig.mockResolvedValue({
    kind: "ok",
    config: {
      apiOrigin: TRUSTED_API_ORIGIN,
      relayOrigin: TRUSTED_RELAY_ORIGIN,
    },
  });
  mocks.claimDesktopManagedApiKey.mockResolvedValue({
    kind: "claimed",
    apiKey: MANAGED_KEY,
  });
  mocks.seedReposConfig.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Feed `payload` through the canonical handoff and return the final state. */
async function runLoadedHandoff(h: ControllerHarness, payload = handoff()) {
  mocks.readPendingOnboardingHandoff.mockResolvedValue({
    kind: "loaded",
    payload,
  });
  await h.controller.processCanonicalOnboardingHandoff("cold-start");
  return h.controller.getOnboardingState().managedProvisioning;
}

function retryOptionsAt(index: number): RetryOptions {
  return mocks.withSingleManagedOnboardingRetry.mock.calls[index]?.[0];
}

function openFileHandlerOf(h: ControllerHarness): (filePath: string) => void {
  h.controller.registerOnboardingFileOpenHandler();
  const handler = h.registerOpenFileHandler.mock.calls[0]?.[0];
  if (!handler) {
    throw new Error("the controller registered no open-file handler");
  }
  return handler;
}

function savedProfile(h: ControllerHarness) {
  const [configId] = h.apiKeyStore.saveProfileKey.mock.calls[0] ?? [];
  return h.settingsStore
    .getSavedConfigs()
    .find((config) => config.id === configId);
}

describe("open-file handoff intake", () => {
  test("an open-file path that is not the canonical handoff path is ignored", async () => {
    const h = makeController();
    const onOpenFile = openFileHandlerOf(h);
    h.controller.markBootReadyForOnboarding();

    onOpenFile("/tmp/elsewhere/pending-onboarding.json");
    await h.controller.drainQueuedOnboardingHandoffs();

    assert.equal(mocks.readPendingOnboardingHandoff.mock.calls.length, 0);
  });

  test("a canonical open-file before boot is ready is queued, and a drain processes it exactly once", async () => {
    const h = makeController();
    const onOpenFile = openFileHandlerOf(h);

    onOpenFile(getCanonicalOnboardingHandoffPath());
    assert.equal(mocks.readPendingOnboardingHandoff.mock.calls.length, 0);

    await h.controller.drainQueuedOnboardingHandoffs();
    await h.controller.drainQueuedOnboardingHandoffs();

    assert.deepEqual(mocks.readPendingOnboardingHandoff.mock.calls, [
      [getCanonicalOnboardingHandoffPath()],
    ]);
  });

  test("once boot is ready a canonical open-file is processed immediately", async () => {
    const h = makeController();
    const onOpenFile = openFileHandlerOf(h);
    const read = deferred();
    mocks.readPendingOnboardingHandoff.mockImplementation(() => {
      read.resolve();
      return Promise.resolve({ kind: "absent" });
    });
    h.controller.markBootReadyForOnboarding();

    onOpenFile(getCanonicalOnboardingHandoffPath());
    await read.promise;

    assert.equal(mocks.readPendingOnboardingHandoff.mock.calls.length, 1);
  });

  test("a background handoff that throws is logged with the reason, never rethrown (Error or not)", async () => {
    for (const rejection of [new Error("disk gone"), "disk gone"]) {
      vi.restoreAllMocks();
      const h = makeController();
      const onOpenFile = openFileHandlerOf(h);
      mocks.readPendingOnboardingHandoff.mockRejectedValue(rejection);
      const warned = deferred<[string, string]>();
      vi.spyOn(gatewayLog, "warn").mockImplementation((tag, message) => {
        warned.resolve([tag, message]);
      });
      h.controller.markBootReadyForOnboarding();

      onOpenFile(getCanonicalOnboardingHandoffPath());

      assert.deepEqual(await warned.promise, [
        "onboarding-handoff",
        "Background onboarding handoff failed: disk gone",
      ]);
    }
  });
});

describe("processCanonicalOnboardingHandoff", () => {
  test("does nothing while the app is shutting down", async () => {
    const h = makeController({ shuttingDown: true });
    await h.controller.processCanonicalOnboardingHandoff("activate");
    assert.equal(mocks.readPendingOnboardingHandoff.mock.calls.length, 0);
  });

  test("an absent handoff leaves provisioning idle and the window alone", async () => {
    const h = makeController();
    await h.controller.processCanonicalOnboardingHandoff("cold-start");
    assert.deepEqual(h.controller.getOnboardingState().managedProvisioning, {
      status: "idle",
    });
    assert.equal(h.showWindow.mock.calls.length, 0);
    assert.equal(h.desktopWindow.sendToRenderer.mock.calls.length, 0);
  });

  const ignoredCases: [string, string][] = [
    [
      "stale",
      "The automated onboarding handoff expired. Start a fresh onboarding attempt from the web app.",
    ],
    [
      "invalid_origin",
      "The automated onboarding handoff contained an invalid web app URL. Use manual setup or start again from the web app.",
    ],
    [
      "read_failed",
      "Desktop could not read the automated onboarding handoff. Use manual setup or start again from the web app.",
    ],
    [
      "delete_failed",
      "Desktop could not consume the automated onboarding handoff safely. Use manual setup or start again from the web app.",
    ],
    [
      "invalid_json",
      "The automated onboarding handoff was invalid. Use manual setup or start again from the web app.",
    ],
  ];
  for (const [reason, message] of ignoredCases) {
    test(`an ignored handoff (${reason}) fails with its message, notifies the renderer and shows the window`, async () => {
      const h = makeController();
      silenceWarnings();
      mocks.readPendingOnboardingHandoff.mockResolvedValue({
        kind: "ignored",
        reason,
      });

      await h.controller.processCanonicalOnboardingHandoff("open-file");

      assert.deepEqual(
        h.controller.getOnboardingState().managedProvisioning,
        failedState(message, MANUAL_THEN_RETRY)
      );
      assert.deepEqual(h.desktopWindow.sendToRenderer.mock.calls, [
        ["desktop:onboarding-state-changed"],
      ]);
      assert.ok(h.showWindow.mock.calls.length >= 1);
    });
  }

  test("a second call while one is in flight returns without reading again", async () => {
    const h = makeController();
    const read = deferred<{ kind: "absent" }>();
    mocks.readPendingOnboardingHandoff.mockReturnValue(read.promise);

    const first = h.controller.processCanonicalOnboardingHandoff("cold-start");
    await h.controller.processCanonicalOnboardingHandoff("activate");
    assert.equal(mocks.readPendingOnboardingHandoff.mock.calls.length, 1);

    read.resolve({ kind: "absent" });
    await first;
  });

  test("an open-file queued while a handoff is processing is drained when it finishes", async () => {
    const h = makeController();
    const onOpenFile = openFileHandlerOf(h);
    h.controller.markBootReadyForOnboarding();
    const firstRead = deferred<{ kind: "absent" }>();
    mocks.readPendingOnboardingHandoff.mockReturnValueOnce(firstRead.promise);

    const first = h.controller.processCanonicalOnboardingHandoff("cold-start");
    onOpenFile(getCanonicalOnboardingHandoffPath());
    firstRead.resolve({ kind: "absent" });
    await first;

    assert.equal(mocks.readPendingOnboardingHandoff.mock.calls.length, 2);
  });
});

describe("loaded handoff — origin confirmation", () => {
  test("asks the user to confirm the web app URL, and a dismissal fails without provisioning", async () => {
    const h = makeController();
    silenceWarnings();
    const seen: unknown[] = [];
    h.showMessageBox.mockImplementation((options: unknown) => {
      seen.push(options, h.controller.getOnboardingState().managedProvisioning);
      return Promise.resolve({ response: 1 });
    });

    const state = await runLoadedHandoff(h);

    assert.deepEqual(seen, [
      {
        type: "question",
        buttons: ["Continue", "Use manual setup"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        title: "Confirm Closedloop Web App URL",
        message:
          "Auto-provisioning was initiated. Please confirm this Closedloop web app URL before we continue.",
        detail: WEB_APP_ORIGIN,
      },
      {
        status: "awaiting-origin-confirmation",
        webAppOrigin: WEB_APP_ORIGIN,
        message: "Waiting for URL confirmation before automated provisioning.",
      },
    ]);
    assert.deepEqual(
      state,
      failedState(
        "Automated provisioning was canceled. Start a fresh onboarding attempt from the web app or use manual setup.",
        RETRY_THEN_MANUAL
      )
    );
    assert.equal(mocks.fetchTrustedDesktopConfig.mock.calls.length, 0);
  });

  test("a user change while the confirmation is open resets to idle, notifies the renderer, and never provisions", async () => {
    const h = makeController();
    h.showMessageBox.mockImplementation(() => {
      h.controller.cancelManagedOnboardingForUserChange("profile switched");
      return Promise.resolve({ response: 0 });
    });

    const state = await runLoadedHandoff(h);

    assert.deepEqual(state, { status: "idle" });
    // One notification entering confirmation, one for the cancel's reset.
    assert.deepEqual(h.desktopWindow.sendToRenderer.mock.calls, [
      ["desktop:onboarding-state-changed"],
      ["desktop:onboarding-state-changed"],
    ]);
    assert.equal(mocks.fetchTrustedDesktopConfig.mock.calls.length, 0);
  });
});

describe("loaded handoff — trusted config", () => {
  test("fetches from the handoff origin through one 5s retry gated on the failure's retryable flag", async () => {
    const h = makeController();
    silenceWarnings();
    let stateDuringFetch: unknown;
    mocks.fetchTrustedDesktopConfig.mockImplementation(() => {
      stateDuringFetch = h.controller.getOnboardingState().managedProvisioning;
      return Promise.resolve({
        kind: "failed",
        reason: "invalid_response",
        retryable: false,
        error: "bad body",
      });
    });

    await runLoadedHandoff(h);

    assert.deepEqual(mocks.fetchTrustedDesktopConfig.mock.calls, [
      [{ webAppOrigin: WEB_APP_ORIGIN }],
    ]);
    assert.deepEqual(stateDuringFetch, {
      status: "provisioning",
      webAppOrigin: WEB_APP_ORIGIN,
      message: "Fetching trusted Desktop configuration...",
    });
    const retry = retryOptionsAt(0);
    assert.equal(retry.delayMs, 5000);
    assert.equal(retry.shouldRetry({ kind: "failed", retryable: true }), true);
    assert.equal(
      retry.shouldRetry({ kind: "failed", retryable: false }),
      false
    );
    assert.equal(retry.shouldRetry({ kind: "ok" }), false);
    assert.equal(retry.isCancelled?.(), false);
    assert.equal(mocks.claimDesktopManagedApiKey.mock.calls.length, 0);
  });

  const failureCases: [string, boolean, string, string[]][] = [
    [
      "request_failed",
      true,
      "Desktop could not reach the trusted web app config after retrying. Start a fresh onboarding attempt or use manual setup.",
      RETRY_THEN_MANUAL,
    ],
    [
      "unsupported_protocol",
      false,
      "This Closedloop web app does not support this Desktop onboarding protocol. Use manual setup.",
      MANUAL_ONLY,
    ],
    [
      "invalid_response",
      false,
      "Desktop could not validate the trusted web app config. Use manual setup or start again from the web app.",
      MANUAL_ONLY,
    ],
  ];
  for (const [reason, retryable, message, recovery] of failureCases) {
    test(`a ${retryable ? "retryable" : "non-retryable"} ${reason} failure stops with its message`, async () => {
      const h = makeController();
      silenceWarnings();
      mocks.fetchTrustedDesktopConfig.mockResolvedValue({
        kind: "failed",
        reason,
        retryable,
        error: "x",
      });

      const state = await runLoadedHandoff(h);

      assert.deepEqual(state, failedState(message, recovery));
    });
  }

  test("a user change while the config is being fetched stops before claiming", async () => {
    const h = makeController();
    mocks.fetchTrustedDesktopConfig.mockImplementation(() => {
      h.controller.cancelManagedOnboardingForUserChange("profile switched");
      return Promise.resolve({
        kind: "ok",
        config: {
          apiOrigin: TRUSTED_API_ORIGIN,
          relayOrigin: TRUSTED_RELAY_ORIGIN,
        },
      });
    });

    const state = await runLoadedHandoff(h);

    assert.deepEqual(state, { status: "idle" });
    assert.equal(mocks.claimDesktopManagedApiKey.mock.calls.length, 0);
  });
});

describe("loaded handoff — managed-key claim", () => {
  test("claims against the TRUSTED api origin with the handoff attempt, active gateway and signing keys, forwarding diagnostics", async () => {
    const h = makeController();
    silenceWarnings();
    const diagnostic = { phase: "claim", detail: "probe" };
    let stateDuringClaim: unknown;
    mocks.claimDesktopManagedApiKey.mockImplementation(
      (options: { onDiagnostic: (value: unknown) => void }) => {
        stateDuringClaim =
          h.controller.getOnboardingState().managedProvisioning;
        options.onDiagnostic(diagnostic);
        return Promise.resolve({
          kind: "manual_fallback",
          reason: "keystore_locked",
        });
      }
    );

    const state = await runLoadedHandoff(h);

    const claimArgs = mocks.claimDesktopManagedApiKey.mock.calls[0]?.[0];
    assert.equal(claimArgs.apiOrigin, TRUSTED_API_ORIGIN);
    assert.equal(claimArgs.onboardingAttemptId, "attempt-1");
    assert.equal(claimArgs.webAppOrigin, WEB_APP_ORIGIN);
    assert.equal(claimArgs.gatewayId, "gateway-1");
    assert.equal(claimArgs.signingKeys, h.gatewaySigningKeyStore);
    assert.deepEqual(h.reportBootstrapClaimDiagnostic.mock.calls, [
      [diagnostic],
    ]);
    assert.deepEqual(stateDuringClaim, {
      status: "provisioning",
      webAppOrigin: WEB_APP_ORIGIN,
      message: "Claiming managed Desktop key...",
    });
    assert.deepEqual(
      state,
      failedState(
        "Managed Desktop key setup is unavailable on this machine. Use manual API key setup.",
        MANUAL_ONLY
      )
    );
    const retry = retryOptionsAt(1);
    assert.equal(retry.delayMs, 5000);
    assert.equal(retry.shouldRetry({ kind: "failed", statusCode: 503 }), true);
    assert.equal(retry.shouldRetry({ kind: "failed", statusCode: 500 }), false);
    assert.equal(retry.isCancelled?.(), false);
    assert.equal(h.apiKeyStore.setApiKey.mock.calls.length, 0);
  });

  const claimCases: {
    claim: { statusCode?: number; retryable?: boolean; error: string };
    reason: string;
    message: string;
    recovery: string[];
  }[] = [
    {
      claim: { statusCode: 401, error: "x" },
      reason: "claim_401",
      message:
        "The onboarding attempt expired or was already used. Start a fresh onboarding attempt from the web app.",
      recovery: RETRY_THEN_MANUAL,
    },
    {
      claim: { statusCode: 400, error: "x" },
      reason: "claim_400",
      message:
        "The automated onboarding request was rejected. Use manual setup.",
      recovery: MANUAL_ONLY,
    },
    {
      claim: { statusCode: 403, error: "x" },
      reason: "claim_403",
      message:
        "The automated onboarding request was rejected. Use manual setup.",
      recovery: MANUAL_ONLY,
    },
    {
      claim: { statusCode: 409, error: "x" },
      reason: "claim_409",
      message:
        "Desktop managed-key rotation conflicted with another active attempt. Start a fresh onboarding attempt or use manual setup.",
      recovery: RETRY_THEN_MANUAL,
    },
    {
      claim: { statusCode: 502, retryable: false, error: "x" },
      reason: "claim_502",
      message:
        "Desktop could not claim a managed key. Start a fresh onboarding attempt or use manual setup.",
      recovery: RETRY_THEN_MANUAL,
    },
    {
      claim: { statusCode: 503, error: "x" },
      reason: "claim_503",
      message:
        "Desktop could not claim a managed key after retrying. Start a fresh onboarding attempt or use manual setup.",
      recovery: RETRY_THEN_MANUAL,
    },
    {
      claim: { statusCode: 500, error: "gateway exploded" },
      reason: "claim_500",
      message: "gateway exploded",
      recovery: RETRY_THEN_MANUAL,
    },
    {
      claim: { error: "" },
      reason: "claim_failed",
      message: "Desktop could not claim a managed key. Use manual setup.",
      recovery: RETRY_THEN_MANUAL,
    },
  ];
  for (const { claim, reason, message, recovery } of claimCases) {
    test(`a failed claim (${reason}) fails with its message and recovery actions`, async () => {
      const h = makeController();
      const warn = silenceWarnings();
      mocks.claimDesktopManagedApiKey.mockResolvedValue({
        kind: "failed",
        ...claim,
      });

      const state = await runLoadedHandoff(h);

      assert.deepEqual(state, failedState(message, recovery));
      assert.deepEqual(warn.mock.calls.at(-1), [
        "managed-onboarding",
        `${reason}: ${message}`,
      ]);
    });
  }

  test("a user change while the claim is in flight stops before storing the key", async () => {
    const h = makeController();
    mocks.claimDesktopManagedApiKey.mockImplementation(() => {
      h.controller.cancelManagedOnboardingForUserChange("signed out");
      return Promise.resolve({ kind: "claimed", apiKey: MANAGED_KEY });
    });

    const state = await runLoadedHandoff(h);

    assert.deepEqual(state, { status: "idle" });
    assert.equal(h.apiKeyStore.setApiKey.mock.calls.length, 0);
  });
});

describe("loaded handoff — claimed key", () => {
  test("with a safe sandbox: commits origins before the key, persists the managed profile, seeds repos and completes", async () => {
    const h = makeController({
      loadResult: { ok: true, keyPair: { publicKeySpkiPem: "PEM" } },
    });
    let apiOriginWhenKeyStored = "";
    h.apiKeyStore.setApiKey.mockImplementation(() => {
      apiOriginWhenKeyStored = h.settingsStore.getApiOrigin();
    });

    const state = await runLoadedHandoff(
      h,
      handoff({ sandboxBaseDirectory: SAFE_SANDBOX })
    );

    // ISS-6243: the origins are committed BEFORE the credential is stored.
    assert.equal(apiOriginWhenKeyStored, TRUSTED_API_ORIGIN);
    const settings = h.settingsStore.getAll();
    assert.equal(settings.apiOrigin, TRUSTED_API_ORIGIN);
    assert.equal(settings.relayOrigin, TRUSTED_RELAY_ORIGIN);
    assert.equal(settings.webAppOrigin, WEB_APP_ORIGIN);
    assert.equal(settings.sandboxBaseDirectory, SAFE_SANDBOX);
    assert.equal(settings.onboardingCompleted, true);
    assert.deepEqual(h.apiKeyStore.setApiKey.mock.calls, [
      [MANAGED_KEY, "DESKTOP_MANAGED"],
    ]);
    const [, savedKey, provenance] =
      h.apiKeyStore.saveProfileKey.mock.calls[0] ?? [];
    assert.equal(savedKey, MANAGED_KEY);
    assert.equal(provenance, "DESKTOP_MANAGED");
    const profile = savedProfile(h);
    assert.equal(profile?.apiKeySource, "DESKTOP_MANAGED");
    assert.equal(profile?.gatewayId, "gateway-1");
    assert.equal(profile?.gatewayPublicKeyPem, "PEM");
    assert.equal(profile?.desktopSecurityUpgradeProtocolVersion, 1);
    assert.equal(profile?.pendingOnboardingAttemptId, null);
    const seedCall = mocks.seedReposConfig.mock.calls[0];
    assert.equal(seedCall?.[0], SAFE_SANDBOX);
    assert.equal(seedCall?.[1].isCancelled(), false);
    assert.equal(
      h.desktopSessionManager.refreshExistingUserResolution.mock.calls.length,
      1
    );
    assert.equal(h.telemetryOrgProvider.warm.mock.calls.length, 1);
    assert.equal(h.restartCloudSocket.mock.calls.length, 1);
    assert.deepEqual(state, {
      status: "idle",
      webAppOrigin: WEB_APP_ORIGIN,
      message: "Automated onboarding completed.",
    });
  });

  test("a risky sandbox is not persisted: setup stays incomplete and the state asks for a safe sandbox", async () => {
    const h = makeController();
    const defaultSandbox = h.settingsStore.getAll().sandboxBaseDirectory;

    const state = await runLoadedHandoff(
      h,
      handoff({ sandboxBaseDirectory: path.parse(process.cwd()).root })
    );

    const settings = h.settingsStore.getAll();
    assert.equal(settings.onboardingCompleted, false);
    assert.equal(settings.sandboxBaseDirectory, defaultSandbox);
    assert.deepEqual(state, {
      status: "sandbox-required",
      webAppOrigin: WEB_APP_ORIGIN,
      message: "Choose a safe sandbox directory to finish Desktop setup.",
      recoveryActions: ["choose_sandbox", "use_manual_setup"],
    });
    assert.equal(mocks.seedReposConfig.mock.calls.length, 0);
    assert.equal(h.restartCloudSocket.mock.calls.length, 0);
    // The key is still stored: only the sandbox step remains.
    assert.deepEqual(h.apiKeyStore.setApiKey.mock.calls, [
      [MANAGED_KEY, "DESKTOP_MANAGED"],
    ]);
  });

  test("without a loadable signing key the managed profile carries no public key", async () => {
    const h = makeController();

    await runLoadedHandoff(h);

    const profile = savedProfile(h);
    assert.equal(profile?.apiKeySource, "DESKTOP_MANAGED");
    assert.equal(profile?.gatewayPublicKeyPem, undefined);
  });

  test("a user change during repo seeding abandons the completion step", async () => {
    const h = makeController();
    mocks.seedReposConfig.mockImplementation(() => {
      h.controller.cancelManagedOnboardingForUserChange("signed out");
      return Promise.resolve();
    });

    const state = await runLoadedHandoff(
      h,
      handoff({ sandboxBaseDirectory: SAFE_SANDBOX })
    );

    assert.deepEqual(state, { status: "idle" });
    assert.equal(h.restartCloudSocket.mock.calls.length, 0);
  });
});

describe("runSecurityUpgradeProvisioning", () => {
  test("provisions without an origin prompt and reports not-cancelled when the run completes", async () => {
    const h = makeController();

    const result = await h.controller.runSecurityUpgradeProvisioning(handoff());

    assert.deepEqual(result, { cancelled: false });
    assert.equal(h.showMessageBox.mock.calls.length, 0);
    assert.deepEqual(h.apiKeyStore.setApiKey.mock.calls, [
      [MANAGED_KEY, "DESKTOP_MANAGED"],
    ]);
  });
});

describe("cancellation and state projection", () => {
  test("cancelling a non-idle run resets it to idle and notifies the renderer", async () => {
    const h = makeController();
    silenceWarnings();
    mocks.readPendingOnboardingHandoff.mockResolvedValue({
      kind: "ignored",
      reason: "stale",
    });
    await h.controller.processCanonicalOnboardingHandoff("cold-start");
    const notifiedBefore = h.desktopWindow.sendToRenderer.mock.calls.length;

    h.controller.cancelManagedOnboardingForUserChange("profile switched");

    assert.deepEqual(h.controller.getOnboardingState().managedProvisioning, {
      status: "idle",
    });
    assert.equal(
      h.desktopWindow.sendToRenderer.mock.calls.length,
      notifiedBefore + 1
    );
  });

  test("setup reads complete once a key and a sandbox exist, and the sandbox is reported normalized", () => {
    const h = makeController({ hasApiKey: true });
    h.settingsStore.update({
      sandboxBaseDirectory: `${SAFE_SANDBOX}${path.sep}`,
    });

    const state = h.controller.getOnboardingState();

    assert.equal(state.completed, true);
    assert.equal(state.settings.sandboxBaseDirectory, SAFE_SANDBOX);
  });

  test("a blank sandbox is reported raw and does not count toward setup", () => {
    const h = makeController({ hasApiKey: true });
    h.settingsStore.update({ sandboxBaseDirectory: "   " });

    const state = h.controller.getOnboardingState();

    assert.equal(state.completed, false);
    assert.equal(state.settings.sandboxBaseDirectory, "   ");
  });
});

describe("risky sandbox on an already-completed setup", () => {
  test("a risky sandbox un-completes a previously completed setup", async () => {
    const h = makeController();
    h.settingsStore.update({ onboardingCompleted: true });

    await runLoadedHandoff(
      h,
      handoff({ sandboxBaseDirectory: path.parse(process.cwd()).root })
    );

    assert.equal(h.settingsStore.getAll().onboardingCompleted, false);
  });
});
