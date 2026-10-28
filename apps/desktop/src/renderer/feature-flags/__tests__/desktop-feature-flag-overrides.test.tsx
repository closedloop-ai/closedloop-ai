import { DEV_MODE_FLAG_KEY } from "@repo/api/src/types/dev-mode-flag";
import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import { FEATURE_FLAG_OVERRIDES_STORAGE_KEY } from "@repo/api/src/types/feature-flag-overrides";
import {
  readCheckedFeatureFlags,
  resetCheckedFeatureFlags,
} from "@repo/app/shared/dev-tools/lib/checked-feature-flags-store";
import { DEV_MODE_STORAGE_KEY } from "@repo/app/shared/feature-flags/dev-mode/dev-mode-contract";
import {
  useDevMode,
  useIsDevModeOn,
} from "@repo/app/shared/feature-flags/dev-mode/dev-mode-provider";
import { useFeatureFlagAdapter } from "@repo/app/shared/feature-flags/provider";
import {
  useFeatureFlagEnabled,
  useFeatureFlagResolved,
} from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopAuthState } from "../../types/desktop-api";
import { DesktopFeatureFlagProvider } from "../desktop-feature-flag-provider";
import type { DesktopPostHogFlagAssignment } from "../desktop-posthog-flag-assignment";

/**
 * ISS-12048 — Desktop Dev Mode, driven through the real provider stack: the
 * account's PostHog assignment (pinned by a module mock), the desktop auth
 * state, and the identity main fetches for it. Dev Mode is on only for a
 * signed-in staff user with `dev-mode`; overrides then beat the assignment, Dev
 * Mode off is the customer view, and main is handed the overrides and reports
 * the keys it checked.
 */
const ASSIGNED_ON_FLAG = "assigned-on-flag";
const ASSIGNED_OFF_FLAG = "assigned-off-flag";
const MAIN_CHECKED_FLAG = "main-checked-flag";
const STAFF_USER = "user-staff";
const STAFF_EMAIL = "ada@closedloop.ai";
const CUSTOMER_EMAIL = "dana@acme-corp.com";
// Not "dev-mode": that is the flag key a FlagProbe below is keyed by.
const DEV_MODE_STATE_TEST_ID = "dev-mode-state";

const mocks = vi.hoisted(() => ({
  assignment: undefined as DesktopPostHogFlagAssignment | undefined,
  auth: null as DesktopAuthState | null,
}));

vi.mock("../desktop-posthog-flag-assignment", () => ({
  useDesktopPostHogFlagAssignment: () => mocks.assignment,
}));

vi.mock(
  "../../shared-agent-sessions/desktop-auth-provider",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useDesktopAuthOptional: () => (mocks.auth ? { state: mocks.auth } : null),
  })
);

let originalDesktopApi: PropertyDescriptor | undefined;
let bridge: ReturnType<typeof installBridge>;

beforeEach(() => {
  originalDesktopApi = Object.getOwnPropertyDescriptor(window, "desktopApi");
  resetCheckedFeatureFlags();
});

afterEach(() => {
  cleanup();
  for (const key of [
    FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
    DEV_MODE_STORAGE_KEY,
  ]) {
    localStorage.removeItem(key);
  }
  mocks.assignment = undefined;
  mocks.auth = null;
  resetCheckedFeatureFlags();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("Desktop Dev Mode eligibility", () => {
  it("gives a signed-out session no Dev Mode and withdraws overrides from main", async () => {
    bridge = installBridge(STAFF_EMAIL);
    pinAssignment({ devMode: true });
    storeOverrides({ [ASSIGNED_ON_FLAG]: false });

    renderProbes();

    await waitFor(() =>
      expect(bridge.setFeatureFlagOverrides).toHaveBeenCalled()
    );
    expect(screen.getByTestId(DEV_MODE_STATE_TEST_ID).textContent).toBe(
      "unavailable off"
    );
    expect(bridge.setFeatureFlagOverrides).toHaveBeenLastCalledWith({});
    expect(probeText(ASSIGNED_ON_FLAG)).toBe("enabled resolved");
  });

  it("turns Dev Mode on for signed-in staff with dev-mode, and hands main the overrides", async () => {
    bridge = installBridge(STAFF_EMAIL);
    signIn();
    pinAssignment({ devMode: true });
    storeOverrides({
      [ASSIGNED_ON_FLAG]: false,
      [ASSIGNED_OFF_FLAG]: true,
      // A restriction never leaves the renderer, whatever storage holds.
      "compute-target-signing": false,
    });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId(DEV_MODE_STATE_TEST_ID).textContent).toBe(
        "available on"
      )
    );
    expect(probeText(ASSIGNED_ON_FLAG)).toBe("disabled resolved");
    expect(probeText(ASSIGNED_OFF_FLAG)).toBe("enabled resolved");
    await waitFor(() =>
      expect(bridge.setFeatureFlagOverrides).toHaveBeenLastCalledWith({
        [ASSIGNED_ON_FLAG]: false,
        [ASSIGNED_OFF_FLAG]: true,
      })
    );
  });

  it("gives a customer no Dev Mode, so stored overrides change nothing", async () => {
    bridge = installBridge(CUSTOMER_EMAIL);
    signIn();
    pinAssignment({ devMode: true });
    storeOverrides({ [ASSIGNED_ON_FLAG]: false });

    renderProbes();

    await waitFor(() => expect(bridge.getDesktopIdentity).toHaveBeenCalled());
    await act(() => Promise.resolve());
    expect(screen.getByTestId(DEV_MODE_STATE_TEST_ID).textContent).toBe(
      "unavailable off"
    );
    expect(probeText(ASSIGNED_ON_FLAG)).toBe("enabled resolved");
  });

  it("gives staff no Dev Mode while dev-mode is not rolled out to them", async () => {
    bridge = installBridge(STAFF_EMAIL);
    signIn();
    pinAssignment({ devMode: false });
    storeOverrides({ [ASSIGNED_ON_FLAG]: false });

    renderProbes();

    await waitFor(() => expect(bridge.getDesktopIdentity).toHaveBeenCalled());
    await act(() => Promise.resolve());
    expect(screen.getByTestId(DEV_MODE_STATE_TEST_ID).textContent).toBe(
      "unavailable off"
    );
    expect(probeText(ASSIGNED_ON_FLAG)).toBe("enabled resolved");
  });

  it("gives staff who turned Dev Mode off the customer view, keeping dev-mode itself", async () => {
    bridge = installBridge(STAFF_EMAIL);
    signIn();
    pinAssignment({ devMode: true });
    localStorage.setItem(DEV_MODE_STORAGE_KEY, "false");
    storeOverrides({ [ASSIGNED_OFF_FLAG]: true });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId(DEV_MODE_STATE_TEST_ID).textContent).toBe(
        "available off"
      )
    );
    // Suppressed to a SETTLED false, and the override does not apply either.
    expect(probeText(ASSIGNED_ON_FLAG)).toBe("disabled resolved");
    expect(probeText(ASSIGNED_OFF_FLAG)).toBe("disabled resolved");
    // The escape hatch: the key that gates the way back stays readable.
    expect(probeText(DEV_MODE_FLAG_KEY)).toBe("enabled resolved");
  });
});

describe("Desktop production flag values", () => {
  it("reports the assignment's value through an override and the customer view", async () => {
    bridge = installBridge(STAFF_EMAIL);
    signIn();
    pinAssignment({ devMode: true });
    storeOverrides({ [ASSIGNED_ON_FLAG]: false, [ASSIGNED_OFF_FLAG]: true });

    renderProbes();

    await waitFor(() =>
      expect(probeText(ASSIGNED_ON_FLAG)).toBe("disabled resolved")
    );
    expect(
      screen.getByTestId(productionTestId(ASSIGNED_ON_FLAG)).textContent
    ).toBe("true");
    expect(
      screen.getByTestId(productionTestId(ASSIGNED_OFF_FLAG)).textContent
    ).toBe("false");
  });

  it("reports no production value while the assignment is pending", () => {
    bridge = installBridge(STAFF_EMAIL);
    mocks.assignment = {
      flags: {},
      resolved: false,
      delivery: FeatureAssignmentDelivery.Pending,
      subject: null,
    };

    renderProbes();

    expect(
      screen.getByTestId(productionTestId(ASSIGNED_ON_FLAG)).textContent
    ).toBe("unknown");
  });
});

describe("Desktop Dev Mode checked flag keys", () => {
  it("keeps mounted renderer and main keys after navigation", async () => {
    bridge = installBridge(STAFF_EMAIL);
    signIn();
    pinAssignment({ devMode: true });

    renderProbes();

    await waitFor(() =>
      expect(readCheckedFeatureFlags().has(MAIN_CHECKED_FLAG)).toBe(true)
    );
    expect(readCheckedFeatureFlags().has(ASSIGNED_ON_FLAG)).toBe(true);

    act(() => resetCheckedFeatureFlags("/another-page"));

    expect([...readCheckedFeatureFlags()]).toEqual([
      ASSIGNED_ON_FLAG,
      ASSIGNED_OFF_FLAG,
      DEV_MODE_FLAG_KEY,
      MAIN_CHECKED_FLAG,
    ]);
  });

  it("asks main for nothing while Dev Mode is off", async () => {
    bridge = installBridge(CUSTOMER_EMAIL);
    signIn();
    pinAssignment({ devMode: true });

    renderProbes();

    await waitFor(() => expect(bridge.getDesktopIdentity).toHaveBeenCalled());
    await act(() => Promise.resolve());
    expect(bridge.getMainCheckedFeatureFlags).not.toHaveBeenCalled();
    expect(readCheckedFeatureFlags().size).toBe(0);
  });
});

function installBridge(email: string) {
  const api = {
    getDesktopIdentity: vi.fn(() =>
      Promise.resolve({
        userId: STAFF_USER,
        organizationId: "org-1",
        email,
        firstName: null,
        lastName: null,
        organizationName: null,
      })
    ),
    setFeatureFlagOverrides: vi.fn(() => Promise.resolve(true)),
    getMainCheckedFeatureFlags: vi.fn(() =>
      Promise.resolve([MAIN_CHECKED_FLAG])
    ),
    onMainCheckedFeatureFlagsChanged: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: api,
  });
  return api;
}

function signIn() {
  mocks.auth = {
    status: "authenticated",
    userId: STAFF_USER,
    organizationId: "org-1",
  };
}

function pinAssignment({ devMode }: { devMode: boolean }) {
  mocks.assignment = {
    flags: { [ASSIGNED_ON_FLAG]: true, [DEV_MODE_FLAG_KEY]: devMode },
    resolved: true,
    delivery: FeatureAssignmentDelivery.Assigned,
    subject: STAFF_USER,
  };
}

function storeOverrides(overrides: Record<string, boolean>) {
  localStorage.setItem(
    FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
    JSON.stringify(overrides)
  );
}

function renderProbes() {
  return render(
    <DesktopFeatureFlagProvider>
      <DevModeProbe />
      <FlagProbe flagKey={ASSIGNED_ON_FLAG} />
      <FlagProbe flagKey={ASSIGNED_OFF_FLAG} />
      <FlagProbe flagKey={DEV_MODE_FLAG_KEY} />
    </DesktopFeatureFlagProvider>
  );
}

function DevModeProbe() {
  const { isDevModeAvailable } = useDevMode();
  const isDevModeOn = useIsDevModeOn();
  return (
    <div data-testid={DEV_MODE_STATE_TEST_ID}>
      {`${isDevModeAvailable ? "available" : "unavailable"} ${isDevModeOn ? "on" : "off"}`}
    </div>
  );
}

function FlagProbe({ flagKey }: { flagKey: string }) {
  const enabled = useFeatureFlagEnabled(flagKey);
  const resolved = useFeatureFlagResolved(flagKey);
  const production =
    useFeatureFlagAdapter().useFeatureFlagProductionValue?.(flagKey);
  return (
    <>
      <div data-testid={flagKey}>
        {`${enabled ? "enabled" : "disabled"} ${resolved ? "resolved" : "pending"}`}
      </div>
      <div data-testid={productionTestId(flagKey)}>
        {production === undefined ? "unknown" : String(production)}
      </div>
    </>
  );
}

function productionTestId(flagKey: string): string {
  return `${flagKey}-production`;
}

function probeText(flagKey: string): string | null {
  return screen.getByTestId(flagKey).textContent;
}
