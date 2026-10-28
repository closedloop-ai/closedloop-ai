import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { ZodError } from "zod";
import { registerOnboardingIpcHandlers } from "../src/main/ipc/onboarding-ipc.js";
import { ONBOARDING_WIZARD_PATH } from "../src/main/onboarding/onboarding-popup.js";
import { OnboardingIpcChannel } from "../src/shared/onboarding-ipc-channel.js";
import {
  SANDBOX_REQUIRED_MESSAGE,
  SANDBOX_RISKY_ROOT_MESSAGE,
} from "../src/shared/sandbox-messages.js";
import {
  openedExternalUrls,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";
import {
  createIpcRegistrar,
  isTrustedSenderDouble,
  TRUSTED_EVENT,
  UNTRUSTED_EVENT,
  UNTRUSTED_SENDER_ERROR,
} from "./helpers/ipc-registrar.js";

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

const AUTOMATED_ONBOARDING_ERROR =
  "Automated onboarding must start from the installer handoff file.";
const UNTRUSTED_ONBOARDING_URL_ERROR =
  "Refusing to open untrusted onboarding URL";
const VALID_WEB_APP_ORIGIN = "https://app.closedloop.ai";
const VALID_API_ORIGIN = "https://api.closedloop.ai";
const VALID_RELAY_ORIGIN = "https://relay.closedloop.ai";
const VALID_API_KEY = "sk_live_boundary_test";
const CLEANUP_UNAVAILABLE_PATTERN = /unavailable during sign-out cleanup/;
const NO_COMPLETE_ONBOARDING_EFFECTS = {
  applyBinaryPathPatch: 0,
  cancelManagedOnboardingForUserChange: 0,
  getOnboardingState: 0,
  persistActiveProfileKey: 0,
  restartCloudSocket: 0,
  setApiKey: 0,
  settingsUpdate: 0,
  warmTelemetryOrgIdentity: 0,
};

const tempDirs: string[] = [];

afterEach(() => {
  resetElectronModuleStub();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/**
 * ISS-8662: the sandbox root has to be a directory `isRiskyAllowedDirectory`
 * ACCEPTS, or every case that gets past payload validation dies on the
 * risky-root refusal instead of reaching its assertion. `os.tmpdir()` is that
 * on Linux and not on macOS: there it is `/var/folders/...`, which
 * `canonicalizeScopePath` realpaths to `/private/var/folders/...` and the guard
 * rejects on both the `/var` and `/private` prefixes. `/tmp` is no escape
 * either — it realpaths to `/private/tmp`. A dot-dir directly under the home
 * directory realpaths to itself and is deep enough to clear the `/Users/<name>`
 * check, which is the same reason `security-sandbox.test.ts` reaches for one
 * (ISS-4577). The `afterEach` above removes it.
 *
 * This suite runs on Linux in every pre- and post-merge lane, and on macOS in
 * no PR check at all: the macOS executions are `desktop-testnode-macos-nightly`
 * (FEA-4224, `test:node` on `macos-latest` against `main`, cron `13 8 * * *`)
 * and `Test Desktop` during `Release Desktop`. So getting this wrong is
 * invisible to every gate on the PR and surfaces post-merge — on the nightly
 * within a day, or at a release attempt if the nightly tick is dropped.
 */
function makeHarness(
  options: { popupOrigin?: string; cleanupPending?: boolean } = {}
) {
  const tempRoot = mkdtempSync(
    path.join(os.homedir(), ".cl-iss-7979-onboarding-ipc-")
  );
  tempDirs.push(tempRoot);
  const sandboxBaseDirectory = path.join(tempRoot, "workspace");
  const callOrder: string[] = [];
  const onboardingState = { onboardingCompleted: true };
  const settingsUpdate = vi.fn((value: unknown) => {
    callOrder.push("settings:update");
    return value;
  });
  const setDashboardWelcomeSeen = vi.fn(() => {
    callOrder.push("settings:welcome-seen");
  });
  const setApiKey = vi.fn((_apiKey: string, _provenance: string) => {
    callOrder.push("api-key:set");
  });
  const persistActiveProfileKey = vi.fn(
    (_apiKey: string, _provenance: string) => {
      callOrder.push("profile-key:persist");
    }
  );
  const cancelManagedOnboardingForUserChange = vi.fn((_reason: string) => {
    callOrder.push("managed-onboarding:cancel");
  });
  const warmTelemetryOrgIdentity = vi.fn(() => {
    callOrder.push("telemetry:warm");
  });
  const applyBinaryPathPatch = vi.fn((_patch: unknown) => {
    callOrder.push("binary-paths:patch");
  });
  const restartCloudSocket = vi.fn(() => {
    callOrder.push("cloud-socket:restart");
  });
  const getOnboardingState = vi.fn(() => {
    callOrder.push("onboarding-state:read");
    return onboardingState;
  });
  const handlers = createIpcRegistrar();

  registerOnboardingIpcHandlers(handlers.registrar, {
    apiKeyStore: { setApiKey },
    applyBinaryPathPatch,
    applyDataSyncLevel: vi.fn(),
    cancelManagedOnboardingForUserChange,
    getOnboardingState,
    getSessionOrganizationId: () => null,
    isTrustedSender: isTrustedSenderDouble,
    persistActiveProfileKey,
    restartCloudSocket,
    settingsStore: {
      getSignOutCleanupState: () => ({
        isPending: () => options.cleanupPending === true,
      }),
      getWebAppOrigin: () => options.popupOrigin ?? VALID_WEB_APP_ORIGIN,
      setDashboardWelcomeSeen,
      update: settingsUpdate,
    },
    startDeviceOnboarding: () => Promise.resolve({ status: "approved" }),
    warmTelemetryOrgIdentity,
  } as unknown as Parameters<typeof registerOnboardingIpcHandlers>[1]);

  return {
    applyBinaryPathPatch,
    callOrder,
    cancelManagedOnboardingForUserChange,
    getOnboardingState,
    handlers,
    onboardingState,
    persistActiveProfileKey,
    restartCloudSocket,
    sandboxBaseDirectory,
    setApiKey,
    setDashboardWelcomeSeen,
    settingsUpdate,
    warmTelemetryOrgIdentity,
  };
}

type Harness = ReturnType<typeof makeHarness>;

function completeOnboardingEffectCounts(harness: Harness) {
  return {
    applyBinaryPathPatch: harness.applyBinaryPathPatch.mock.calls.length,
    cancelManagedOnboardingForUserChange:
      harness.cancelManagedOnboardingForUserChange.mock.calls.length,
    getOnboardingState: harness.getOnboardingState.mock.calls.length,
    persistActiveProfileKey: harness.persistActiveProfileKey.mock.calls.length,
    restartCloudSocket: harness.restartCloudSocket.mock.calls.length,
    setApiKey: harness.setApiKey.mock.calls.length,
    settingsUpdate: harness.settingsUpdate.mock.calls.length,
    warmTelemetryOrgIdentity:
      harness.warmTelemetryOrgIdentity.mock.calls.length,
  };
}

async function captureCompleteOnboardingRejection(
  harness: Harness,
  payload: unknown
): Promise<unknown> {
  try {
    await harness.handlers.invoke(
      OnboardingIpcChannel.CompleteOnboarding,
      TRUSTED_EVENT,
      payload
    );
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("onboarding IPC trusted-sender boundary", () => {
  test("GetOnboardingState refuses an untrusted sender before reading state", () => {
    const harness = makeHarness();

    assert.throws(
      () =>
        harness.handlers.invoke(
          OnboardingIpcChannel.GetOnboardingState,
          UNTRUSTED_EVENT
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(harness.getOnboardingState.mock.calls.length, 0);
  });

  test("GetOnboardingState returns state for the trusted renderer", () => {
    const harness = makeHarness();

    assert.equal(
      harness.handlers.invoke(
        OnboardingIpcChannel.GetOnboardingState,
        TRUSTED_EVENT
      ),
      harness.onboardingState
    );
    assert.equal(harness.getOnboardingState.mock.calls.length, 1);
  });

  test("MarkDashboardWelcomeSeen refuses before its persisted write", () => {
    const harness = makeHarness();

    assert.throws(
      () =>
        harness.handlers.invoke(
          OnboardingIpcChannel.MarkDashboardWelcomeSeen,
          UNTRUSTED_EVENT
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(harness.setDashboardWelcomeSeen.mock.calls.length, 0);
  });

  test("MarkDashboardWelcomeSeen persists for the trusted renderer", () => {
    const harness = makeHarness();

    assert.deepEqual(
      harness.handlers.invoke(
        OnboardingIpcChannel.MarkDashboardWelcomeSeen,
        TRUSTED_EVENT
      ),
      { ok: true }
    );
    assert.deepEqual(harness.setDashboardWelcomeSeen.mock.calls, [[true]]);
  });

  test("CompleteOnboarding rejects an untrusted malformed payload before parsing", async () => {
    const harness = makeHarness();

    await assert.rejects(
      async () =>
        await harness.handlers.invoke(
          OnboardingIpcChannel.CompleteOnboarding,
          UNTRUSTED_EVENT,
          null
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.deepEqual(
      completeOnboardingEffectCounts(harness),
      NO_COMPLETE_ONBOARDING_EFFECTS
    );
  });
});

describe("CompleteOnboarding payload boundary", () => {
  const malformedPayloads = [
    ["undefined", undefined],
    ["null", null],
    ["number", 42],
    ["string", "not-an-object"],
    ["array", []],
  ] as const;

  for (const [name, payload] of malformedPayloads) {
    test(`rejects a trusted ${name} payload with ZodError before effects`, async () => {
      const harness = makeHarness();
      if (Array.isArray(payload)) {
        Object.assign(payload, {
          sandboxBaseDirectory: harness.sandboxBaseDirectory,
        });
      }

      const error = await captureCompleteOnboardingRejection(harness, payload);
      assert.ok(
        error instanceof ZodError,
        "expected a ZodError contract refusal"
      );
      assert.deepEqual(
        completeOnboardingEffectCounts(harness),
        NO_COMPLETE_ONBOARDING_EFFECTS
      );
      assert.equal(
        existsSync(
          path.join(harness.sandboxBaseDirectory, ".closedloop-ai", "config")
        ),
        false,
        "repo config seeding must not run before payload validation"
      );
    });
  }

  test("accepts omitted optional fields and keeps the existing response", async () => {
    const harness = makeHarness();

    const result = await harness.handlers.invoke(
      OnboardingIpcChannel.CompleteOnboarding,
      TRUSTED_EVENT,
      {
        apiOrigin: " ",
        binaryPaths: { git: " " },
        onboardingAttemptId: " ",
        relayOrigin: " ",
        sandboxBaseDirectory: harness.sandboxBaseDirectory,
        webAppOrigin: VALID_WEB_APP_ORIGIN,
      }
    );

    assert.equal(result, harness.onboardingState);
    assert.deepEqual(harness.settingsUpdate.mock.calls[0]?.[0], {
      onboardingCompleted: true,
      sandboxBaseDirectory: harness.sandboxBaseDirectory,
      webAppOrigin: VALID_WEB_APP_ORIGIN,
    });
    assert.equal(harness.setApiKey.mock.calls.length, 0);
    assert.equal(harness.persistActiveProfileKey.mock.calls.length, 0);
    assert.equal(harness.applyBinaryPathPatch.mock.calls.length, 0);
  });

  test.each([false, true])(
    "refuses config-changing onboarding during sign-out cleanup (key present: %s)",
    async (withKey) => {
      const harness = makeHarness({ cleanupPending: true });

      await assert.rejects(
        async () =>
          await harness.handlers.invoke(
            OnboardingIpcChannel.CompleteOnboarding,
            TRUSTED_EVENT,
            {
              ...(withKey ? { apiKey: VALID_API_KEY } : {}),
              apiOrigin: VALID_API_ORIGIN,
              relayOrigin: VALID_RELAY_ORIGIN,
              sandboxBaseDirectory: harness.sandboxBaseDirectory,
              webAppOrigin: VALID_WEB_APP_ORIGIN,
            }
          ),
        CLEANUP_UNAVAILABLE_PATTERN
      );
      assert.deepEqual(
        completeOnboardingEffectCounts(harness),
        NO_COMPLETE_ONBOARDING_EFFECTS
      );
      assert.equal(
        existsSync(
          path.join(harness.sandboxBaseDirectory, ".closedloop-ai", "config")
        ),
        false
      );
    }
  );

  test("accepts every existing field while stripping additive unknown keys", async () => {
    const harness = makeHarness();

    const result = await harness.handlers.invoke(
      OnboardingIpcChannel.CompleteOnboarding,
      TRUSTED_EVENT,
      {
        apiKey: `  ${VALID_API_KEY}  `,
        apiOrigin: `${VALID_API_ORIGIN}/ignored-path`,
        binaryPaths: {
          claude: "  /opt/closedloop/bin/claude  ",
          futureTool: "/opt/closedloop/bin/future",
          git: "   ",
        },
        bootstrapToken: "bootstrap-token",
        futureTopLevelField: "ignored",
        onboardingAttemptId: "attempt-with-key",
        relayOrigin: `${VALID_RELAY_ORIGIN}/ignored-path`,
        sandboxBaseDirectory: harness.sandboxBaseDirectory,
        webAppOrigin: `${VALID_WEB_APP_ORIGIN}/onboarding`,
      }
    );

    assert.equal(result, harness.onboardingState);
    assert.deepEqual(harness.settingsUpdate.mock.calls[0]?.[0], {
      apiOrigin: VALID_API_ORIGIN,
      onboardingCompleted: true,
      relayOrigin: VALID_RELAY_ORIGIN,
      sandboxBaseDirectory: harness.sandboxBaseDirectory,
      webAppOrigin: VALID_WEB_APP_ORIGIN,
    });
    assert.deepEqual(harness.setApiKey.mock.calls[0], [
      VALID_API_KEY,
      "USER_CREATED",
    ]);
    assert.deepEqual(harness.persistActiveProfileKey.mock.calls[0], [
      VALID_API_KEY,
      "USER_CREATED",
    ]);
    assert.deepEqual(harness.applyBinaryPathPatch.mock.calls[0]?.[0], {
      claude: "/opt/closedloop/bin/claude",
    });
    assert.deepEqual(
      harness.cancelManagedOnboardingForUserChange.mock.calls[0],
      ["manual onboarding completed"]
    );
    assert.ok(
      harness.callOrder.indexOf("settings:update") <
        harness.callOrder.indexOf("api-key:set"),
      "origins/settings must be committed before the credential write"
    );
  });
});

describe("CompleteOnboarding semantic refusals", () => {
  test("keeps the required-sandbox refusal", async () => {
    const harness = makeHarness();

    await assert.rejects(
      async () =>
        await harness.handlers.invoke(
          OnboardingIpcChannel.CompleteOnboarding,
          TRUSTED_EVENT,
          { sandboxBaseDirectory: " ", webAppOrigin: VALID_WEB_APP_ORIGIN }
        ),
      new RegExp(SANDBOX_REQUIRED_MESSAGE)
    );
    assert.deepEqual(
      completeOnboardingEffectCounts(harness),
      NO_COMPLETE_ONBOARDING_EFFECTS
    );
  });

  test("keeps the risky-root refusal", async () => {
    const harness = makeHarness();

    await assert.rejects(
      async () =>
        await harness.handlers.invoke(
          OnboardingIpcChannel.CompleteOnboarding,
          TRUSTED_EVENT,
          {
            sandboxBaseDirectory: os.homedir(),
            webAppOrigin: VALID_WEB_APP_ORIGIN,
          }
        ),
      new RegExp(SANDBOX_RISKY_ROOT_MESSAGE)
    );
    assert.deepEqual(
      completeOnboardingEffectCounts(harness),
      NO_COMPLETE_ONBOARDING_EFFECTS
    );
  });

  test("keeps the attempt-id-without-key refusal", async () => {
    const harness = makeHarness();

    await assert.rejects(
      async () =>
        await harness.handlers.invoke(
          OnboardingIpcChannel.CompleteOnboarding,
          TRUSTED_EVENT,
          {
            onboardingAttemptId: "attempt-without-key",
            sandboxBaseDirectory: harness.sandboxBaseDirectory,
            webAppOrigin: VALID_WEB_APP_ORIGIN,
          }
        ),
      new RegExp(AUTOMATED_ONBOARDING_ERROR)
    );
    assert.deepEqual(
      completeOnboardingEffectCounts(harness),
      NO_COMPLETE_ONBOARDING_EFFECTS
    );
  });

  test("keeps the untrusted onboarding URL refusal before opening the OS browser", async () => {
    const harness = makeHarness({ popupOrigin: "https://evil.example" });

    await assert.rejects(
      async () =>
        await harness.handlers.invoke(
          OnboardingIpcChannel.OnboardingPopupCta,
          TRUSTED_EVENT
        ),
      new RegExp(UNTRUSTED_ONBOARDING_URL_ERROR)
    );
    assert.deepEqual(openedExternalUrls(), []);
  });

  test("keeps opening the trusted onboarding URL", async () => {
    const harness = makeHarness();
    const expectedUrl = new URL(
      ONBOARDING_WIZARD_PATH,
      VALID_WEB_APP_ORIGIN
    ).toString();

    assert.deepEqual(
      await harness.handlers.invoke(
        OnboardingIpcChannel.OnboardingPopupCta,
        TRUSTED_EVENT
      ),
      { opened: expectedUrl }
    );
    assert.deepEqual(openedExternalUrls(), [expectedUrl]);
  });
});
