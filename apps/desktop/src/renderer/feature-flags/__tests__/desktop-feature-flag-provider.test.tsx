import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import { DesktopFeatureFlagProvider } from "../desktop-feature-flag-provider";

const UNKNOWN_SHARED_FLAG_KEY = "sharedDevOnlyFlag";
let originalDesktopApiDescriptor: PropertyDescriptor | undefined;

describe("DesktopFeatureFlagProvider", () => {
  beforeEach(() => {
    originalDesktopApiDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "desktopApi"
    );
  });

  afterEach(() => {
    if (originalDesktopApiDescriptor) {
      Object.defineProperty(window, "desktopApi", originalDesktopApiDescriptor);
    } else {
      Reflect.deleteProperty(window, "desktopApi");
    }
    vi.restoreAllMocks();
  });

  it("keeps default-off desktop flags disabled while settings load in dev", async () => {
    const runtime = deferred<unknown>();
    const flags = deferred<unknown>();
    installDesktopApi({
      flags: flags.promise,
      runtimeStatus: runtime.promise,
    });

    renderFeatureProbe();

    expect(screen.getByTestId("agent-coaching").textContent).toBe("disabled");
    expect(screen.getByTestId("shared-dev").textContent).toBe("disabled");

    runtime.resolve({ isPackaged: false });

    await waitFor(() =>
      expect(screen.getByTestId("shared-dev").textContent).toBe("enabled")
    );
    expect(screen.getByTestId("agent-coaching").textContent).toBe("disabled");

    flags.resolve({ flags: [] });

    await waitFor(() =>
      expect(screen.getByTestId("agent-coaching").textContent).toBe("disabled")
    );
  });

  it("uses explicit persisted desktop flag values when they arrive", async () => {
    installDesktopApi({
      flags: Promise.resolve({
        flags: [
          {
            key: DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY,
            value: true,
          },
        ],
      }),
      runtimeStatus: Promise.resolve({ isPackaged: false }),
    });

    renderFeatureProbe();

    await waitFor(() =>
      expect(screen.getByTestId("agent-coaching").textContent).toBe("enabled")
    );
    expect(screen.getByTestId("shared-dev").textContent).toBe("enabled");
  });
});

function renderFeatureProbe() {
  return render(
    <DesktopFeatureFlagProvider>
      <FeatureProbe
        flagKey={DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY}
        testId="agent-coaching"
      />
      <FeatureProbe flagKey={UNKNOWN_SHARED_FLAG_KEY} testId="shared-dev" />
    </DesktopFeatureFlagProvider>
  );
}

function FeatureProbe({
  flagKey,
  testId,
}: {
  flagKey: string;
  testId: string;
}) {
  const enabled = useFeatureFlagEnabled(flagKey);
  return <div data-testid={testId}>{enabled ? "enabled" : "disabled"}</div>;
}

function installDesktopApi({
  flags,
  runtimeStatus,
}: {
  flags: Promise<unknown>;
  runtimeStatus: Promise<unknown>;
}) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getAllFlags: vi.fn(() => flags),
      getRuntimeStatus: vi.fn(() => runtimeStatus),
      onFlagsChanged: vi.fn(),
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
