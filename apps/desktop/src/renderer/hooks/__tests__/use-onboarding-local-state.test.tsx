import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RENDERER_WINDOW_GONE_MESSAGE,
  UNTRUSTED_IPC_SENDER_MESSAGE,
} from "../../../shared/ipc-refusal-messages";
import {
  ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
  OnboardingInventoryStatus,
} from "../../../shared/onboarding-local-state-contract";
import {
  ANALYSIS_ETA_CONTRACT_VERSION,
  AnalysisEtaKind,
  AnalysisEtaUnavailableReason,
} from "../../../shared/transcript-analysis-eta-contract";
import {
  ONBOARDING_LOCAL_STATE_POLL_MS,
  useOnboardingLocalState,
} from "../use-onboarding-local-state";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function snapshot(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    contractVersion: ONBOARDING_LOCAL_STATE_CONTRACT_VERSION,
    computeTargetId: "ct-01",
    inventory: { status: OnboardingInventoryStatus.Unavailable },
    analysisEta: {
      contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
      inventoryRevision: 0,
      kind: AnalysisEtaKind.Unavailable,
      reason: AnalysisEtaUnavailableReason.ProgressIndeterminate,
    },
    ...overrides,
  };
}

function installDesktopApi(
  getOnboardingLocalState:
    | ((payload?: { attemptId?: string }) => Promise<unknown>)
    | null
): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: getOnboardingLocalState ? { getOnboardingLocalState } : {},
  });
}

/** Let the in-flight read resolve without advancing the clock. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

describe("useOnboardingLocalState (ISS-8376)", () => {
  it("starts on loading and settles on the snapshot", async () => {
    installDesktopApi(() => Promise.resolve(snapshot()));

    const { result } = renderHook(() => useOnboardingLocalState(true));
    expect(result.current.state).toBe("loading");

    await flush();
    expect(result.current.state).toBe("ready");
  });

  it("makes no call at all while inactive", async () => {
    const getState = vi.fn(() => Promise.resolve(snapshot()));
    installDesktopApi(getState);

    renderHook(() => useOnboardingLocalState(false));
    await flush();

    expect(getState).not.toHaveBeenCalled();
  });

  it("settles on bridge-absent when there is nothing to call", async () => {
    installDesktopApi(null);

    const { result } = renderHook(() => useOnboardingLocalState(true));
    await flush();

    // Nothing to retry toward — this must settle, not climb the ladder.
    expect(result.current.state).toBe("bridge-absent");
  });

  it("settles on forbidden for an untrusted-sender refusal and never retries", async () => {
    const getState = vi.fn(() =>
      Promise.reject(
        new Error(
          `Error invoking remote method 'desktop:get-onboarding-local-state': Error: ${UNTRUSTED_IPC_SENDER_MESSAGE}`
        )
      )
    );
    installDesktopApi(getState);

    const { result } = renderHook(() => useOnboardingLocalState(true));
    await flush();
    expect(result.current.state).toBe("forbidden");

    await advance(ONBOARDING_LOCAL_STATE_POLL_MS * 10);
    // Asking a settled authorization question again, forever, is the defect.
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it("reports window-gone as its own state, not as forbidden", async () => {
    installDesktopApi(() =>
      Promise.reject(
        new Error(
          `Error invoking remote method 'desktop:get-onboarding-local-state': Error: ${RENDERER_WINDOW_GONE_MESSAGE}`
        )
      )
    );

    const { result } = renderHook(() => useOnboardingLocalState(true));
    await flush();

    // ISS-8776: a teardown race is a DIFFERENT FACT from an auth refusal.
    expect(result.current.state).toBe("window-gone");
  });

  it("reports a transient failure and RECOVERS on a later poll", async () => {
    let calls = 0;
    installDesktopApi(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("db-host hiccup"))
        : Promise.resolve(snapshot());
    });

    const { result } = renderHook(() => useOnboardingLocalState(true));
    await flush();
    expect(result.current.state).toBe("failed");

    await advance(ONBOARDING_LOCAL_STATE_POLL_MS);
    await flush();
    expect(result.current.state).toBe("ready");
  });

  it("drops a reply from a superseded sweep, keeping the newer one", async () => {
    let calls = 0;
    installDesktopApi(() => {
      calls += 1;
      // Second reply carries an OLDER inventory revision than the first: a late
      // answer from a sweep that has already been superseded.
      return Promise.resolve(
        snapshot({
          analysisEta: {
            contractVersion: ANALYSIS_ETA_CONTRACT_VERSION,
            inventoryRevision: calls === 1 ? 7 : 3,
            kind: AnalysisEtaKind.Calculating,
          },
        })
      );
    });

    const { result } = renderHook(() => useOnboardingLocalState(true));
    await flush();
    expect(result.current.state).toBe("ready");

    await advance(ONBOARDING_LOCAL_STATE_POLL_MS);
    await flush();

    expect(result.current.state).toBe("ready");
    if (result.current.state !== "ready") {
      return;
    }
    // The held snapshot stays at the newer revision.
    expect(result.current.snapshot.analysisEta.inventoryRevision).toBe(7);
  });

  it("accepts a changed identity rather than freezing on the old one", async () => {
    let calls = 0;
    installDesktopApi(() => {
      calls += 1;
      // Main reads the CURRENT identity every time, so a sign-in mid-onboarding
      // legitimately changes this. Rejecting it would freeze the hook for the
      // rest of the session.
      return Promise.resolve(
        snapshot({ computeTargetId: calls === 1 ? "ct-01" : "ct-99" })
      );
    });

    const { result } = renderHook(() => useOnboardingLocalState(true));
    await flush();
    await advance(ONBOARDING_LOCAL_STATE_POLL_MS);
    await flush();

    expect(result.current.state).toBe("ready");
    if (result.current.state !== "ready") {
      return;
    }
    expect(result.current.snapshot.computeTargetId).toBe("ct-99");
  });

  it("drops a reply belonging to a superseded onboarding attempt", async () => {
    installDesktopApi(() =>
      Promise.resolve(snapshot({ attemptId: "attempt-OLD" }))
    );

    const { result } = renderHook(() =>
      useOnboardingLocalState(true, "attempt-NEW")
    );
    await flush();

    // The echo disagreed with what we asked for, so this answer is not ours.
    expect(result.current.state).toBe("loading");
  });

  it("accepts a payload that omits the optional identity", async () => {
    const { computeTargetId: _omitted, ...bare } = snapshot();
    installDesktopApi(() => Promise.resolve(bare));

    const { result } = renderHook(() => useOnboardingLocalState(true));
    await flush();

    // Onboarding genuinely runs before sign-in, so the identity is legitimately
    // absent and the payload must still be usable.
    expect(result.current.state).toBe("ready");
  });

  it("reports failed for a payload the boundary parser refuses", async () => {
    installDesktopApi(() => Promise.resolve({ nonsense: true }));

    const { result } = renderHook(() => useOnboardingLocalState(true));
    await flush();

    expect(result.current.state).toBe("failed");
  });

  it("clears its timer on unmount", async () => {
    const getState = vi.fn(() => Promise.resolve(snapshot()));
    installDesktopApi(getState);

    const { unmount } = renderHook(() => useOnboardingLocalState(true));
    await flush();
    expect(getState).toHaveBeenCalledTimes(1);

    unmount();
    await advance(ONBOARDING_LOCAL_STATE_POLL_MS * 5);

    expect(getState).toHaveBeenCalledTimes(1);
  });

  it("drops a read that resolves after unmount", async () => {
    let resolveRead: ((value: unknown) => void) | undefined;
    installDesktopApi(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        })
    );

    const { result, unmount } = renderHook(() => useOnboardingLocalState(true));
    // Captured BEFORE unmount: after it, `result.current` stops tracking, so
    // comparing against a post-unmount read would prove nothing.
    expect(result.current.state).toBe("loading");
    unmount();

    await act(async () => {
      resolveRead?.(snapshot());
      await Promise.resolve();
    });

    // The load never settled into `ready`, which is what the post-await
    // `cancelled` check buys. Delete that guard and React logs a setState on an
    // unmounted component and this value moves.
    expect(result.current.state).toBe("loading");
  });
});
