import type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../../../test/deferred.js";
import {
  DesktopFeatureFlagProvider,
  useDesktopFeatureFlagsResolved,
} from "../desktop-feature-flag-provider";

/**
 * ISS-8753 — the Electron E2E flag-assignment seam, from the renderer's side.
 *
 * WHAT IS BEING PROVEN. Desktop flag resolution is the SIGNED-IN user's PostHog
 * assignment, and the Electron E2E harness launches with no account — a terminal
 * CLOSED answer for every key. The seam gives those launches an assignment to
 * read, so every spec that calls `seedDesktopFeatureFlags` (including
 * the two "(flag on)" cases the required `desktop` job runs in
 * `settings-labs-gateway-health.spec.ts`) still exercise an open gate.
 *
 * Every case here mounts SIGNED OUT, because that is the state the harness is
 * actually in and the state in which the seam is the only thing that can open a
 * gate outside the ISS-11945 anonymous keys. Deleting the seam turns the first case red and leaves the rest green,
 * which is the split those cases are for.
 *
 * The probed keys are deliberately ones the LOCAL registry cannot answer: the
 * registry snapshot below declares neither, so an "enabled" render can only have
 * come from the assignment. That is what stops this suite passing on the very
 * mechanism ISS-8753 removes.
 *
 * The gating that makes the seam a test seam rather than a product back door is
 * NOT here — it is `readE2eFeatureFlagAssignment` in the main process, covered
 * by `test/e2e-feature-flag-assignment.test.ts`. The renderer holds no gate of
 * its own on purpose: the only one available to it would be `isPackaged`, which
 * describes a dev build and not a test harness.
 */

/** Written as a literal for the reason the cutover suite states: a fixture built
 * from the module it polices survives that module being renamed. */
const CUTOVER_FLAG_KEY = "desktopPosthogFlags";
/** A key no desktop registry entry declares, so only an assignment can open it. */
const SEEDED_FLAG_KEY = "harnessSeededGateNoRegistryEntryDeclares";
const HARNESS_SUBJECT = "e2e-harness";

const SEEDED_ASSIGNMENT: DesktopFeatureFlagAssignment = {
  userId: HARNESS_SUBJECT,
  resolved: true,
  flags: { [SEEDED_FLAG_KEY]: true },
};

let originalDesktopApiDescriptor: PropertyDescriptor | undefined;

describe("DesktopFeatureFlagProvider — ISS-8753 E2E assignment seam", () => {
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

  it("opens a seeded gate for a signed-out launch, without ever asking the cloud", async () => {
    const bridge = installDesktopApi({ seed: SEEDED_ASSIGNMENT });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId("seeded").textContent).toBe("enabled")
    );
    expect(screen.getByTestId("resolved").textContent).toBe("resolved");
    // Signed out, so the account-scoped read is never issued: the verdict came
    // from the seam and from nowhere else.
    expect(bridge.getDesktopFeatureFlags).not.toHaveBeenCalled();
  });

  it("changes nothing when there is no seed — a signed-out launch is still closed", async () => {
    installDesktopApi({ seed: null });

    renderProbes();

    // SETTLED closed, not stranded pending: an absent seed must fall through to
    // the production path, which settles a signed-out session CLOSED.
    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("seeded").textContent).toBe("disabled");
  });

  it("is inert on a build whose preload does not expose the seam at all", async () => {
    installDesktopApi({ seed: null, exposeSeam: false });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("seeded").textContent).toBe("disabled");
  });

  it("settles disabled when the seam bridge rejects", async () => {
    installDesktopApi({
      seed: () => Promise.reject(new Error("no handler")),
    });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("seeded").textContent).toBe("disabled");
  });

  it("opens nothing on a malformed seed, and still settles", async () => {
    installDesktopApi({
      seed: { userId: HARNESS_SUBJECT, flags: { [SEEDED_FLAG_KEY]: "yes" } },
    });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("seeded").textContent).toBe("disabled");
  });

  it("opens nothing on a seed with resolved:false, even when the flag is true", async () => {
    installDesktopApi({
      seed: {
        userId: HARNESS_SUBJECT,
        resolved: false,
        flags: { [SEEDED_FLAG_KEY]: true },
      },
    });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("seeded").textContent).toBe("disabled");
  });

  it("reports UNRESOLVED while the seam is in flight, never resolved-closed", async () => {
    const gate = deferred<DesktopFeatureFlagAssignment | null>();
    installDesktopApi({ seed: () => gate.promise });

    renderProbes();

    // The frame this pins: settling closed first and correcting on arrival would
    // publish a resolved-closed verdict a one-way gate can act on before the
    // seeded one exists. `resolved` is settled-ness, not enabled-ness.
    await waitFor(() =>
      expect(screen.getByTestId("seeded").textContent).toBe("disabled")
    );
    expect(screen.getByTestId("resolved").textContent).toBe("pending");

    gate.resolve(SEEDED_ASSIGNMENT);

    await waitFor(() =>
      expect(screen.getByTestId("seeded").textContent).toBe("enabled")
    );
    expect(screen.getByTestId("resolved").textContent).toBe("resolved");
  });
});

function renderProbes() {
  return render(
    <DesktopFeatureFlagProvider>
      <FlagProbe flagKey={SEEDED_FLAG_KEY} testId="seeded" />
      <ResolvedProbe />
    </DesktopFeatureFlagProvider>
  );
}

function FlagProbe({ flagKey, testId }: { flagKey: string; testId: string }) {
  const enabled = useFeatureFlagEnabled(flagKey);
  return <div data-testid={testId}>{enabled ? "enabled" : "disabled"}</div>;
}

function ResolvedProbe() {
  const resolved = useDesktopFeatureFlagsResolved();
  return <div data-testid="resolved">{resolved ? "resolved" : "pending"}</div>;
}

/**
 * A signed-out launch with the PostHog path mounted.
 *
 * The registry snapshot carries the cutover gate and NOTHING else, so this suite
 * reads the same on either side of ISS-8753: before it, the gate selects the
 * PostHog adapter; after it, the provider consults no registry at all and the
 * snapshot is simply unread.
 */
function installDesktopApi({
  seed,
  exposeSeam = true,
}: {
  seed: unknown | (() => Promise<DesktopFeatureFlagAssignment | null>);
  exposeSeam?: boolean;
}) {
  const getE2eSeededFeatureFlags = vi.fn(() =>
    typeof seed === "function"
      ? (seed as () => Promise<DesktopFeatureFlagAssignment | null>)()
      : Promise.resolve(seed ?? null)
  );
  const bridge: Record<string, unknown> = {
    getAllFlags: vi.fn(() =>
      Promise.resolve({ flags: [{ key: CUTOVER_FLAG_KEY, value: true }] })
    ),
    getRuntimeStatus: vi.fn(() => Promise.resolve({ isPackaged: false })),
    onFlagsChanged: vi.fn(() => () => {
      // No-op unsubscribe: these cases never push a flag change.
    }),
    getDesktopAuthState: vi.fn(() =>
      Promise.resolve({
        status: "signed_out",
        userId: null,
        organizationId: null,
      })
    ),
    onDesktopAuthStateChanged: vi.fn(() => () => {
      // No-op unsubscribe: these cases never change account.
    }),
    getDesktopFeatureFlags: vi.fn(() => Promise.resolve(null)),
  };
  if (exposeSeam) {
    bridge.getE2eSeededFeatureFlags = getE2eSeededFeatureFlags;
  }
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: bridge,
  });
  return bridge as {
    getDesktopFeatureFlags: ReturnType<typeof vi.fn>;
    getE2eSeededFeatureFlags?: ReturnType<typeof vi.fn>;
  };
}
