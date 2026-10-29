import { FeatureAssignmentDelivery } from "@repo/api/src/types/feature-assignment-delivery";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { useDesktopPostHogFlagAssignment } from "../desktop-posthog-flag-assignment";

const SIGNED_IN_USER_ID = "user_desktop_1";

let originalDesktopApiDescriptor: PropertyDescriptor | undefined;

/**
 * A minimal desktopApi bridge: an authenticated, online auth state resolved
 * synchronously, plus whatever `getDesktopFeatureFlags`/`getE2eSeededFeatureFlags`
 * the case supplies. Deliberately omits every member `desktop-feature-flag-provider`
 * consumes that this hook does not — this file targets
 * `useDesktopPostHogFlagAssignment` directly, not the provider.
 */
function installBridge(overrides: Record<string, unknown>) {
  const bridge: Record<string, unknown> = {
    getDesktopAuthState: vi.fn(async () => ({
      status: DesktopAuthStatus.Authenticated,
      userId: SIGNED_IN_USER_ID,
      organizationId: "org_1",
    })),
    onDesktopAuthStateChanged: vi.fn(() => () => {}),
    getE2eSeededFeatureFlags: vi.fn(() => Promise.resolve(null)),
    ...overrides,
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: bridge,
  });
  return bridge;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useDesktopPostHogFlagAssignment — bridge and cancellation branches", () => {
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

  it("closes with MissingBridge when the bridge has no getDesktopFeatureFlags member", async () => {
    installBridge({ getDesktopFeatureFlags: undefined });

    const { result } = renderHook(() => useDesktopPostHogFlagAssignment());

    await waitFor(() => expect(result.current.resolved).toBe(true));
    expect(result.current.delivery).toBe(
      FeatureAssignmentDelivery.MissingBridge
    );
    expect(result.current.flags).toEqual({});
  });

  it("ignores a stale successful fetch resolution once the signed-in account changes mid-flight", async () => {
    const firstFetch = deferred<unknown>();
    const secondFetch = deferred<unknown>();
    const authListeners: Array<(next: unknown) => void> = [];
    let call = 0;
    installBridge({
      onDesktopAuthStateChanged: vi.fn((onChange: (next: unknown) => void) => {
        authListeners.push(onChange);
        return () => {};
      }),
      getDesktopFeatureFlags: vi.fn(() => {
        call += 1;
        return call === 1 ? firstFetch.promise : secondFetch.promise;
      }),
    });

    const { result } = renderHook(() => useDesktopPostHogFlagAssignment());

    await waitFor(() => expect(result.current.subject).toBe(SIGNED_IN_USER_ID));

    // Switch accounts before the first fetch answers — its effect cleanup sets
    // `cancelled = true` for that in-flight call.
    for (const listener of [...authListeners]) {
      listener({
        status: DesktopAuthStatus.Authenticated,
        userId: "user_desktop_2",
        organizationId: "org_2",
      });
    }

    // The stale first fetch now resolves with an answer that would open a gate
    // if it were adopted.
    firstFetch.resolve({
      userId: SIGNED_IN_USER_ID,
      resolved: true,
      flags: { staleGate: true },
    });

    secondFetch.resolve({
      userId: "user_desktop_2",
      resolved: true,
      flags: { staleGate: false },
    });

    await waitFor(() => expect(result.current.subject).toBe("user_desktop_2"));
    // The cancelled first answer never reached state: the flag it would have
    // opened stays closed under the new account's own (different) answer.
    expect(result.current.flags.staleGate).toBe(false);
  });

  it("ignores a stale rejected fetch once the signed-in account changes mid-flight", async () => {
    const firstFetch = deferred<unknown>();
    const secondFetch = deferred<unknown>();
    const authListeners: Array<(next: unknown) => void> = [];
    let call = 0;
    installBridge({
      onDesktopAuthStateChanged: vi.fn((onChange: (next: unknown) => void) => {
        authListeners.push(onChange);
        return () => {};
      }),
      getDesktopFeatureFlags: vi.fn(() => {
        call += 1;
        return call === 1 ? firstFetch.promise : secondFetch.promise;
      }),
    });

    const { result } = renderHook(() => useDesktopPostHogFlagAssignment());

    await waitFor(() => expect(result.current.subject).toBe(SIGNED_IN_USER_ID));

    for (const listener of [...authListeners]) {
      listener({
        status: DesktopAuthStatus.Authenticated,
        userId: "user_desktop_2",
        organizationId: "org_2",
      });
    }

    // The stale first fetch rejects after cancellation — its cleanup must not
    // publish an EvaluationFailed frame for the account that is no longer current.
    firstFetch.reject(new Error("stale network error"));
    secondFetch.resolve({
      userId: "user_desktop_2",
      resolved: true,
      flags: {},
    });

    await waitFor(() => expect(result.current.subject).toBe("user_desktop_2"));
    // The second (current) account's own resolved answer is what's published,
    // not an EvaluationFailed frame carried over from the cancelled first call.
    expect(result.current.resolved).toBe(true);
    expect(result.current.delivery).toBe(FeatureAssignmentDelivery.Assigned);
  });
});
