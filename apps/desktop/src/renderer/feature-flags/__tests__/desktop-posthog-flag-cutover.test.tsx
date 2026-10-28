import {
  DESKTOP_SESSION_REPLAY_FLAG_KEY,
  type DesktopFeatureFlagAssignment,
} from "@repo/api/src/types/desktop-feature-flags";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../../../../test/deferred.js";
import { DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY } from "../../../shared/feature-flags";
import {
  DesktopFeatureFlagProvider,
  useDesktopFeatureFlagsResolved,
} from "../desktop-feature-flag-provider";
import { useDesktopPostHogFlagAssignment } from "../desktop-posthog-flag-assignment";

/**
 * ISS-8024 / ISS-8753 — the flag-source cutover, now unconditional.
 *
 * The retired gate key is written out as a LITERAL, and so is the Labs
 * container key below. Both are here for one job: to prove a persisted LOCAL
 * value under either name can no longer open anything. That is also why the
 * literal outlived its constant — ISS-9660 retired the key and deleted
 * `desktop-posthog-flags-flag.ts`, and an assertion that had imported that
 * module would have been deleted along with it, losing the proof exactly when
 * the stranded profiles it describes are the only thing left carrying the key.
 */
const CUTOVER_FLAG_KEY = "desktopPosthogFlags";
/**
 * A key no desktop registry entry declares. Under the retired Labs adapter this
 * was the dev fail-OPEN case — an unpackaged build resolved it ENABLED. On the
 * PostHog path it is closed, in every build.
 */
const UNREGISTERED_FLAG_KEY = "sharedFlagNoRegistryEntryDeclares";
/** The retired Labs container key. See {@link CUTOVER_FLAG_KEY}. */
const LABS_NAV_FLAG_KEY = "labsNav";
const SIGNED_IN_USER_ID = "user_desktop_1";

let originalDesktopApiDescriptor: PropertyDescriptor | undefined;

describe("DesktopFeatureFlagProvider — ISS-8753 PostHog is the only flag source", () => {
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

  // ISS-8753's own contract, and the one that fails if the local branch creeps
  // back. Every key below is persisted ON in the launch profile — an ordinary
  // Labs key, the retired cutover switch, and the retired Labs container — while
  // PostHog carries none of them. A provider that still consulted the registry
  // for ANY of them, including as a "bootstrap" carve-out, opens a gate here.
  it("cannot be opened by a persisted Labs value, and never asks the local registry at all", async () => {
    const bridge = installDesktopApi({
      desktopFlags: {
        [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true,
        [CUTOVER_FLAG_KEY]: true,
        [LABS_NAV_FLAG_KEY]: true,
      },
      // The build type that made the retired adapter answer ENABLED for an
      // unregistered key. Nothing reads it now.
      isPackaged: false,
      authedUserId: SIGNED_IN_USER_ID,
      assignment: { userId: SIGNED_IN_USER_ID, resolved: true, flags: {} },
    });

    renderProbes();

    // Settled first, so the assertions below are about the verdict rather than
    // about a window that had not closed yet.
    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("coaching").textContent).toBe("disabled");
    expect(screen.getByTestId("cutover").textContent).toBe("disabled");
    expect(screen.getByTestId("labs-nav").textContent).toBe("disabled");
    expect(screen.getByTestId("unregistered").textContent).toBe("disabled");
    // Not merely outvoted — not read. The registry snapshot and the build type
    // are no longer inputs to any gate, so neither IPC is issued.
    expect(bridge.getAllFlags).not.toHaveBeenCalled();
    expect(bridge.getRuntimeStatus).not.toHaveBeenCalled();
  });

  it("resolves from the signed-in user's PostHog assignment", async () => {
    installDesktopApi({
      desktopFlags: {},
      isPackaged: false,
      authedUserId: SIGNED_IN_USER_ID,
      assignment: {
        userId: SIGNED_IN_USER_ID,
        resolved: true,
        // Enabled in PostHog and nowhere else: only the assignment path can
        // produce this render.
        flags: { [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true },
      },
    });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId("coaching").textContent).toBe("enabled")
    );
    expect(screen.getByTestId("resolved").textContent).toBe("resolved");
  });

  it("holds an unregistered key CLOSED in an unpackaged dev build — no dev fail-open on the PostHog path", async () => {
    installDesktopApi({
      desktopFlags: {},
      // The exact build type that made the RETIRED Labs adapter answer ENABLED
      // for an unregistered key. Operator decision (2026-08-25): fail closed,
      // dev included.
      isPackaged: false,
      authedUserId: SIGNED_IN_USER_ID,
      assignment: { userId: SIGNED_IN_USER_ID, resolved: true, flags: {} },
    });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("unregistered").textContent).toBe("disabled");
    expect(screen.getByTestId("coaching").textContent).toBe("disabled");
  });

  it("stays closed but UNSETTLED through the resolution window, so no gated UI flashes", async () => {
    const pending = deferred<DesktopFeatureFlagAssignment | null>();
    installDesktopApi({
      desktopFlags: {},
      isPackaged: false,
      authedUserId: SIGNED_IN_USER_ID,
      assignment: pending.promise,
    });

    renderProbes();

    // The assignment has not arrived, so the answer is closed but UNSETTLED.
    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("pending")
    );
    expect(screen.getByTestId("coaching").textContent).toBe("disabled");

    pending.resolve({
      userId: SIGNED_IN_USER_ID,
      resolved: true,
      flags: { [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true },
    });

    await waitFor(() =>
      expect(screen.getByTestId("coaching").textContent).toBe("enabled")
    );
    expect(screen.getByTestId("resolved").textContent).toBe("resolved");
  });

  // ISS-11945: a signed-out install now asks for its own node_uuid-keyed
  // assignment, AFTER settling closed, and adopts only the allow-listed keys.
  // The reply here answers for every key — a reply main produced for an account
  // this renderer has not heard of yet — so only the filter keeps coaching shut.
  it("resolves pre-auth CLOSED and SETTLED, then adopts only the anonymous allow-list", async () => {
    const anonymous = deferred<DesktopFeatureFlagAssignment | null>();
    const bridge = installDesktopApi({
      desktopFlags: {},
      isPackaged: false,
      authedUserId: null,
      assignment: anonymous.promise,
    });

    renderProbes();

    // SETTLED, not pending, before the anonymous read answers: a signed-out
    // session is terminal, and holding `resolved` false would strand a gated
    // route in loading with no event left that could release it.
    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("replay").textContent).toBe("disabled");
    await waitFor(() =>
      expect(bridge.getDesktopFeatureFlags).toHaveBeenCalledTimes(1)
    );

    anonymous.resolve({
      userId: SIGNED_IN_USER_ID,
      resolved: true,
      flags: {
        [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true,
        [DESKTOP_SESSION_REPLAY_FLAG_KEY]: true,
      },
    });

    await waitFor(() =>
      expect(screen.getByTestId("replay").textContent).toBe("enabled")
    );
    expect(screen.getByTestId("coaching").textContent).toBe("disabled");
    expect(screen.getByTestId("resolved").textContent).toBe("resolved");
  });

  // "We do not know who this is yet" is not "nobody is signed in". The auth
  // store starts on a `loading` snapshot until its IPC pull answers, and
  // collapsing that to a null user id settled the assignment CLOSED on every
  // signed-in launch — a resolved-closed frame a one-way gate can act on before
  // the real assignment has even been requested.
  it("never publishes a resolved-closed frame before the authenticated user is known", async () => {
    const authGate = deferred<void>();
    const bridge = installDesktopApi({
      desktopFlags: {},
      isPackaged: false,
      authedUserId: SIGNED_IN_USER_ID,
      authStateGate: authGate.promise,
      assignment: {
        userId: SIGNED_IN_USER_ID,
        resolved: true,
        flags: { [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true },
      },
    });

    renderProbes();

    // Pin the moment precisely: the auth pull HAS been issued and is held
    // unresolved by `authStateGate`, so the assertions below describe the
    // auth-loading window and not a render that had not started yet.
    await waitFor(() => expect(bridge.getDesktopAuthState).toHaveBeenCalled());
    expect(screen.getByTestId("resolved").textContent).toBe("pending");
    expect(screen.getByTestId("coaching").textContent).toBe("disabled");
    expect(bridge.getDesktopFeatureFlags).not.toHaveBeenCalled();

    authGate.resolve();

    await waitFor(() =>
      expect(screen.getByTestId("coaching").textContent).toBe("enabled")
    );
    expect(screen.getByTestId("resolved").textContent).toBe("resolved");
  });

  it("resolves offline CLOSED and SETTLED, without asking the cloud", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const bridge = installDesktopApi({
      desktopFlags: {},
      isPackaged: false,
      authedUserId: SIGNED_IN_USER_ID,
      assignment: {
        userId: SIGNED_IN_USER_ID,
        resolved: true,
        flags: { [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true },
      },
    });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("coaching").textContent).toBe("disabled");
    expect(bridge.getDesktopFeatureFlags).not.toHaveBeenCalled();
  });

  // The cold-offline case above proves only that nothing is asked while
  // offline. The RELEASE is the half that can silently rot: the hook re-runs
  // solely because `useOnlineStatus()` re-renders it on the `online` event, so
  // if that subscription or the effect's dependency on it drifts, a user who
  // launched offline stays settled-closed for the whole session and the
  // cold-offline case still passes.
  it("asks the cloud and opens the gate when a launched-offline session comes back online", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const bridge = installDesktopApi({
      desktopFlags: {},
      isPackaged: false,
      authedUserId: SIGNED_IN_USER_ID,
      assignment: {
        userId: SIGNED_IN_USER_ID,
        resolved: true,
        flags: { [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true },
      },
    });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("coaching").textContent).toBe("disabled");
    expect(bridge.getDesktopFeatureFlags).not.toHaveBeenCalled();

    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("coaching").textContent).toBe("enabled")
    );
    expect(bridge.getDesktopFeatureFlags).toHaveBeenCalled();
    expect(screen.getByTestId("resolved").textContent).toBe("resolved");
  });

  // The effect's reset runs AFTER React commits, so an end-state assertion
  // cannot see this: by the time the switch has settled, both the fixed and the
  // broken version read closed. What separates them is the FRAME in between, so
  // this records every committed value and asserts on the sequence.
  it("commits no frame of the previous account's gates when the signed-in account changes", async () => {
    const NEXT_USER_ID = "user_desktop_2";
    const frames: boolean[] = [];
    const bridge = installDesktopApi({
      desktopFlags: {},
      isPackaged: false,
      authedUserId: SIGNED_IN_USER_ID,
      assignment: {
        userId: SIGNED_IN_USER_ID,
        resolved: true,
        flags: { [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true },
      },
    });

    render(
      <AssignmentProbe
        flagKey={DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY}
        frames={frames}
      />
    );

    // Account A's gate is open, which is the state that must not survive the
    // switch.
    await waitFor(() => expect(frames.at(-1)).toBe(true));

    // Everything recorded from here belongs to account B.
    frames.length = 0;
    act(() => {
      bridge.pushAuthState({
        status: "authenticated",
        userId: NEXT_USER_ID,
        organizationId: "org_2",
      });
    });

    // Not "settles closed" — NEVER open. One true anywhere in this window is a
    // frame in which account B mounted account A's gate.
    expect(frames).not.toContain(true);
    await waitFor(() =>
      expect(bridge.getDesktopFeatureFlags).toHaveBeenCalledTimes(2)
    );
    expect(frames).not.toContain(true);
  });

  it("refuses an assignment evaluated for a DIFFERENT user", async () => {
    installDesktopApi({
      desktopFlags: {},
      isPackaged: false,
      authedUserId: SIGNED_IN_USER_ID,
      assignment: {
        userId: "user_someone_else",
        resolved: true,
        flags: { [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true },
      },
    });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("coaching").textContent).toBe("disabled");
  });

  it("treats an UNAVAILABLE flag service as closed, never as an assignment of all-off it could act on", async () => {
    installDesktopApi({
      desktopFlags: {},
      isPackaged: false,
      authedUserId: SIGNED_IN_USER_ID,
      // `resolved: false` is the server saying it could not evaluate. The
      // payload's `flags` must not be adopted as an answer.
      assignment: {
        userId: SIGNED_IN_USER_ID,
        resolved: false,
        flags: { [DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY]: true },
      },
    });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("coaching").textContent).toBe("disabled");
  });

  it("settles closed when the assignment fetch rejects", async () => {
    installDesktopApi({
      desktopFlags: {},
      isPackaged: false,
      authedUserId: SIGNED_IN_USER_ID,
      // A factory, not an eager `Promise.reject(...)`: an eagerly-created
      // rejection is unhandled from the moment the fixture is built until the
      // production code happens to call it, which vitest reports as an
      // unhandled rejection even though the test passes.
      assignment: () => Promise.reject(new Error("offline")),
    });

    renderProbes();

    await waitFor(() =>
      expect(screen.getByTestId("resolved").textContent).toBe("resolved")
    );
    expect(screen.getByTestId("coaching").textContent).toBe("disabled");
  });
});

function renderProbes() {
  return render(
    <DesktopFeatureFlagProvider>
      <FlagProbe
        flagKey={DESKTOP_AGENT_COACHING_TIPS_FEATURE_FLAG_KEY}
        testId="coaching"
      />
      <FlagProbe flagKey={UNREGISTERED_FLAG_KEY} testId="unregistered" />
      <FlagProbe flagKey={DESKTOP_SESSION_REPLAY_FLAG_KEY} testId="replay" />
      <FlagProbe flagKey={LABS_NAV_FLAG_KEY} testId="labs-nav" />
      <FlagProbe flagKey={CUTOVER_FLAG_KEY} testId="cutover" />
      <ResolvedProbe />
    </DesktopFeatureFlagProvider>
  );
}

function FlagProbe({ flagKey, testId }: { flagKey: string; testId: string }) {
  const enabled = useFeatureFlagEnabled(flagKey);
  return <div data-testid={testId}>{enabled ? "enabled" : "disabled"}</div>;
}

/**
 * Records the assignment on EVERY committed render of the hook itself.
 *
 * Deliberately NOT via `useFeatureFlagEnabled` through the provider: the
 * provider memoizes its adapter, so a stale verdict whose object identity has
 * not changed produces no new context value and re-renders no consumer. A probe
 * downstream of that memo therefore records NOTHING on the stale frame, which
 * reads identically to "the gate was closed" — while the mounted gate is in fact
 * still open from the previous account. Calling the hook directly is what makes
 * the frame observable.
 */
function AssignmentProbe({
  flagKey,
  frames,
}: {
  flagKey: string;
  frames: boolean[];
}) {
  const assignment = useDesktopPostHogFlagAssignment();
  frames.push(assignment.flags[flagKey] === true);
  return null;
}

function ResolvedProbe() {
  const resolved = useDesktopFeatureFlagsResolved();
  return <div data-testid="resolved">{resolved ? "resolved" : "pending"}</div>;
}

function installDesktopApi({
  desktopFlags,
  isPackaged,
  authedUserId,
  assignment,
  authStateGate,
}: {
  desktopFlags: Record<string, boolean>;
  isPackaged: boolean;
  authedUserId?: string | null;
  assignment?:
    | DesktopFeatureFlagAssignment
    | null
    | Promise<DesktopFeatureFlagAssignment | null>
    | (() => Promise<DesktopFeatureFlagAssignment | null>);
  /**
   * Holds `getDesktopAuthState()` unresolved, which is what keeps the auth store
   * on its `loading` snapshot — the real state of every launch until the auth
   * IPC pull answers.
   */
  authStateGate?: Promise<unknown>;
}) {
  const authListeners: Array<(next: unknown) => void> = [];
  const getDesktopFeatureFlags = vi.fn(() =>
    typeof assignment === "function"
      ? assignment()
      : Promise.resolve(assignment ?? null)
  );
  const bridge = {
    getAllFlags: vi.fn(() =>
      Promise.resolve({
        flags: Object.entries(desktopFlags).map(([key, value]) => ({
          key,
          value,
        })),
      })
    ),
    getRuntimeStatus: vi.fn(() => Promise.resolve({ isPackaged })),
    onFlagsChanged: vi.fn(() => () => {
      // No-op unsubscribe: these cases never push a flag change.
    }),
    getDesktopAuthState: vi.fn(async () => {
      await authStateGate;
      return authedUserId
        ? {
            status: "authenticated",
            userId: authedUserId,
            organizationId: "org_1",
          }
        : { status: "signed_out", userId: null, organizationId: null };
    }),
    onDesktopAuthStateChanged: vi.fn((onChange: (next: unknown) => void) => {
      authListeners.push(onChange);
      return () => {
        authListeners.splice(authListeners.indexOf(onChange), 1);
      };
    }),
    getDesktopFeatureFlags,
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: bridge,
  });
  return {
    ...bridge,
    /** Push an account transition the way main does, not by re-rendering. */
    pushAuthState(next: {
      status: string;
      userId: string | null;
      organizationId: string | null;
    }) {
      for (const listener of [...authListeners]) {
        listener(next);
      }
    },
  };
}
