import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { SyncConsentLevel } from "@repo/app/onboarding/components/sync-consent";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type RecordSyncConsentResult,
  SAVE_FAILED_MESSAGE,
} from "../../components/onboarding/sync-consent-committed-level";
import {
  type CommittedSyncConsent,
  useOnboardingSyncPersistence,
} from "../use-onboarding-sync-persistence";

const ORG_ID = "org_acme";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function installDesktopApi(
  recordSyncConsent: (payload: {
    level: SyncConsentLevel;
    organizationId: string | null;
  }) => Promise<RecordSyncConsentResult>
): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { recordSyncConsent },
  });
}

/**
 * A bridge whose handler resolves `reply` verbatim, however malformed.
 *
 * Separate from `installDesktopApi` and typed `unknown` on purpose: the shapes
 * below are exactly the ones the call site's type forbids and the runtime can
 * still receive, so routing them through the typed installer would take a cast
 * to express and prove nothing about the boundary.
 */
function installDesktopApiReturning(reply: unknown): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { recordSyncConsent: vi.fn().mockResolvedValue(reply) },
  });
}

function installBridgeWithNoRecordSyncConsent(): void {
  // A bridge that exists but is missing this one method: the shape an older
  // preload, mid-rollout, sends.
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {},
  });
}

beforeEach(() => {
  Reflect.deleteProperty(window, "desktopApi");
});

afterEach(() => {
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("useOnboardingSyncPersistence (ISS-8346)", () => {
  it("resolves null and reports the failure when there is no desktop bridge at all", async () => {
    // `window.desktopApi` is left undefined by the `beforeEach` above. `?.`
    // RESOLVES `undefined` here rather than throwing, which is exactly the
    // silent no-op this hook's own explicit null-check exists to stop.
    const { result } = renderHook(() => useOnboardingSyncPersistence(ORG_ID));

    const resolved: { current: CommittedSyncConsent | null } = {
      current: null,
    };
    await act(async () => {
      resolved.current = await result.current.persist(DataSyncLevel.Full);
    });

    expect(resolved.current).toBeNull();
    expect(result.current.error).toBe(SAVE_FAILED_MESSAGE);
  });

  it("resolves null and reports the failure when the bridge has no recordSyncConsent", async () => {
    installBridgeWithNoRecordSyncConsent();
    const { result } = renderHook(() => useOnboardingSyncPersistence(ORG_ID));

    const resolved: { current: CommittedSyncConsent | null } = {
      current: null,
    };
    await act(async () => {
      resolved.current = await result.current.persist(DataSyncLevel.Full);
    });

    expect(resolved.current).toBeNull();
    expect(result.current.error).toBe(SAVE_FAILED_MESSAGE);
  });

  it("resolves null without leaking the rejection, and reports the failure", async () => {
    installDesktopApi(vi.fn().mockRejectedValue(new Error("bridge down")));
    const { result } = renderHook(() => useOnboardingSyncPersistence(ORG_ID));

    // A `persist` promise that REJECTS instead of resolving to `null` would
    // throw inside this `act`, and Vitest would fail the test on that throw —
    // resolving cleanly is itself the proof the rejection was caught, not
    // left to surface as an unhandled renderer rejection.
    const resolved: { current: CommittedSyncConsent | null } = {
      current: null,
    };
    await act(async () => {
      resolved.current = await result.current.persist(DataSyncLevel.Full);
    });

    expect(resolved.current).toBeNull();
    expect(result.current.error).toBe(SAVE_FAILED_MESSAGE);
    expect(result.current.saving).toBe(false);
  });

  it("resolves the level main COMMITTED, not the one requested", async () => {
    installDesktopApi(
      vi.fn().mockResolvedValue({
        level: DataSyncLevel.Off,
        organizationId: ORG_ID,
      })
    );
    const { result } = renderHook(() => useOnboardingSyncPersistence(ORG_ID));

    const resolved: { current: CommittedSyncConsent | null } = {
      current: null,
    };
    await act(async () => {
      resolved.current = await result.current.persist(DataSyncLevel.Full);
    });

    expect(resolved.current?.level).toBe(DataSyncLevel.Off);
    expect(result.current.error).toBeNull();
  });

  it("resolves null when the bridge RESOLVES nothing at all", async () => {
    // The third silent failure, and the one that looks most like success: an
    // older preload whose handler returns nothing satisfies the call site's type
    // at compile time and resolves `undefined` at runtime. A `=== null` check
    // misses it and the caller then reads `.level` off `undefined`.
    installDesktopApi(vi.fn().mockResolvedValue(undefined));
    const { result } = renderHook(() => useOnboardingSyncPersistence(ORG_ID));

    const resolved: { current: CommittedSyncConsent | null } = {
      current: null,
    };
    await act(async () => {
      resolved.current = await result.current.persist(DataSyncLevel.Full);
    });

    expect(resolved.current).toBeNull();
    expect(result.current.error).toBe(SAVE_FAILED_MESSAGE);
  });

  // The fourth silent failure, and the one an `=== null` check cannot see: a
  // reply ARRIVES and proves nothing. Each of these takes the success path
  // unvalidated, publishing a committed answer nobody wrote — and the second
  // and third also hand back an `organizationId` of `undefined` through a field
  // this hook's own type declares as `string | null`.
  for (const [label, reply] of [
    ["an empty object", {}],
    ["a level with no organization", { level: "bogus" }],
    ["a real level with no organization", { level: DataSyncLevel.Full }],
    [
      "an organization of the wrong type",
      { level: DataSyncLevel.Full, organizationId: 7 },
    ],
  ] as const) {
    it(`resolves null and reports the failure when the bridge returns ${label}`, async () => {
      installDesktopApiReturning(reply);
      const { result } = renderHook(() => useOnboardingSyncPersistence(ORG_ID));

      const resolved: { current: CommittedSyncConsent | null } = {
        current: null,
      };
      await act(async () => {
        resolved.current = await result.current.persist(DataSyncLevel.Full);
      });

      expect(resolved.current).toBeNull();
      expect(result.current.error).toBe(SAVE_FAILED_MESSAGE);
    });
  }

  it("accepts a level this build has not heard of, provided the reply proves a commit", async () => {
    // The skew control for the four above: an unknown level from a WORKING
    // bridge is a write that landed, so it must not be reported as a failure.
    // The level itself falls back to the requested one, which is what
    // `committedSyncConsentLevel` is for.
    installDesktopApiReturning({
      level: "some-future-level",
      organizationId: ORG_ID,
    });
    const { result } = renderHook(() => useOnboardingSyncPersistence(ORG_ID));

    const resolved: { current: CommittedSyncConsent | null } = {
      current: null,
    };
    await act(async () => {
      resolved.current = await result.current.persist(DataSyncLevel.Full);
    });

    expect(resolved.current).toEqual({
      level: DataSyncLevel.Full,
      organizationId: ORG_ID,
    });
    expect(result.current.error).toBeNull();
  });

  it("keeps the requested level when main returns one the consent surface does not offer", async () => {
    // `redacted` is a real `DataSyncLevel`, but no consent surface offers it —
    // the wider producer set is not one this renderer may echo as a choice.
    installDesktopApi(
      vi.fn().mockResolvedValue({
        level: DataSyncLevel.Redacted,
        organizationId: ORG_ID,
      })
    );
    const { result } = renderHook(() => useOnboardingSyncPersistence(ORG_ID));

    const resolved: { current: CommittedSyncConsent | null } = {
      current: null,
    };
    await act(async () => {
      resolved.current = await result.current.persist(DataSyncLevel.Full);
    });

    expect(resolved.current?.level).toBe(DataSyncLevel.Full);
  });

  it("is true while the write is in flight and false once it resolves", async () => {
    let settle: ((result: RecordSyncConsentResult) => void) | undefined;
    installDesktopApi(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    const { result } = renderHook(() => useOnboardingSyncPersistence(ORG_ID));

    let persistPromise: Promise<CommittedSyncConsent | null> | undefined;
    act(() => {
      persistPromise = result.current.persist(DataSyncLevel.Full);
    });
    expect(result.current.saving).toBe(true);

    await act(async () => {
      settle?.({ level: DataSyncLevel.Full, organizationId: ORG_ID });
      await persistPromise;
    });

    expect(result.current.saving).toBe(false);
  });

  it("clears the previous error on a retry", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("bridge down"))
      .mockResolvedValueOnce({
        level: DataSyncLevel.Full,
        organizationId: ORG_ID,
      });
    installDesktopApi(write);
    const { result } = renderHook(() => useOnboardingSyncPersistence(ORG_ID));

    await act(async () => {
      await result.current.persist(DataSyncLevel.Full);
    });
    expect(result.current.error).toBe(SAVE_FAILED_MESSAGE);

    await act(async () => {
      await result.current.persist(DataSyncLevel.Full);
    });
    expect(result.current.error).toBeNull();
  });
});
