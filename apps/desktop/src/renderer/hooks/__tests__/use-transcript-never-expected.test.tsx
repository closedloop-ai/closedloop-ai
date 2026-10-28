import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncConsentRecord } from "../../../shared/sync-consent";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
  type TranscriptSyncStatusSnapshot,
} from "../../../shared/transcript-sync-status-contract";
import { useTranscriptNeverExpected } from "../use-transcript-never-expected";

/**
 * ISS-7516 — the hook that turns three live reads into the panel's verdict.
 *
 * `resolveTranscriptNeverExpected` is graded separately over pure inputs
 * (`apps/desktop/test/transcript-never-expected.test.ts`). What can only be
 * graded HERE is the wiring the resolver never sees:
 *
 *  - the flag-off short-circuit returns `undefined`, NOT `false`. The panel's
 *    prop contract treats those as different claims ("we did not ask" vs "we
 *    asked and the answer is no"), and a mutant returning `false` renders
 *    identically today — so nothing else in the suite would catch it.
 *  - the flag ALSO gates the archive-lane status poll, so a closed-by-default
 *    disclosure costs a session-detail mount no IPC at all. Asserted against a
 *    real spy on the bridge rather than a mocked-out poll hook.
 *  - an unsettled or failed status read supplies `null` for this machine's
 *    identity, so the claim is withheld rather than made against an identity
 *    the hook does not have yet. A mutant reading the snapshot optimistically
 *    before the read settles passes every other test in this diff.
 */

const THIS_DEVICE = "compute-target-this";
const OTHER_DEVICE = "compute-target-other";
const ORG = "org-1";

const flagEnabled = vi.fn<(key: string) => boolean>(() => false);
const authState = vi.fn<
  () => { userId: string | null; organizationId: string | null }
>(() => ({ userId: "user-1", organizationId: ORG }));
const consentRead = vi.fn<
  () => { record: SyncConsentRecord | null; isResolved: boolean }
>(() => ({
  record: { tier: "metadata", bound: true, organizationId: ORG },
  isResolved: true,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) => flagEnabled(key),
}));
vi.mock("../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({ state: authState() }),
}));
vi.mock("../../components/onboarding/use-sync-consent-record", () => ({
  useSyncConsentRecord: () => consentRead(),
}));

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function snapshot(
  computeTargetId: string | null
): TranscriptSyncStatusSnapshot {
  return {
    enabled: true,
    online: true,
    tierGate: TranscriptEgressGate.Denied,
    storeReady: true,
    computeTargetId,
    statusCounts: emptyTranscriptStatusCounts(),
  };
}

function installBridge(
  getTranscriptSyncStatus: () => Promise<TranscriptSyncStatusSnapshot>
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(getTranscriptSyncStatus);
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { getTranscriptSyncStatus: spy },
  });
  return spy;
}

beforeEach(() => {
  flagEnabled.mockReturnValue(false);
  authState.mockReturnValue({ userId: "user-1", organizationId: ORG });
  consentRead.mockReturnValue({
    record: { tier: "metadata", bound: true, organizationId: ORG },
    isResolved: true,
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("useTranscriptNeverExpected (ISS-7516)", () => {
  it("returns undefined and makes no IPC while the flag is off", async () => {
    const spy = installBridge(() => Promise.resolve(snapshot(THIS_DEVICE)));

    const { result } = renderHook(() =>
      useTranscriptNeverExpected(THIS_DEVICE)
    );
    await act(async () => {
      await Promise.resolve();
    });

    // Not `false`: the panel's prop contract distinguishes an unasked question
    // from a settled negative, and only this assertion pins it.
    expect(result.current).toBeUndefined();
    // Closed by default costs nothing: the status poll never starts.
    expect(spy).not.toHaveBeenCalled();
  });

  it("claims the settled absence once the status read supplies this machine's identity", async () => {
    flagEnabled.mockReturnValue(true);
    installBridge(() => Promise.resolve(snapshot(THIS_DEVICE)));

    const { result } = renderHook(() =>
      useTranscriptNeverExpected(THIS_DEVICE)
    );

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("withholds the claim for a session recorded on another machine", async () => {
    flagEnabled.mockReturnValue(true);
    installBridge(() => Promise.resolve(snapshot(THIS_DEVICE)));

    const { result } = renderHook(() =>
      useTranscriptNeverExpected(OTHER_DEVICE)
    );

    // The positive sibling above proves this fixture CAN reach `true`, so a
    // `false` here is the identity comparison doing work rather than the hook
    // being inert.
    await waitFor(() => expect(result.current).toBe(false));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
  });

  it("withholds the claim while the status read has not settled", async () => {
    flagEnabled.mockReturnValue(true);
    // A read that never resolves: the poll is in flight, so this machine's
    // identity is not known yet and no verdict may be asserted from it.
    installBridge(
      () => new Promise<TranscriptSyncStatusSnapshot>(() => undefined)
    );

    const { result } = renderHook(() =>
      useTranscriptNeverExpected(THIS_DEVICE)
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(false);
  });

  it("withholds the claim when the status read fails", async () => {
    flagEnabled.mockReturnValue(true);
    installBridge(() => Promise.reject(new Error("db-host down")));

    const { result } = renderHook(() =>
      useTranscriptNeverExpected(THIS_DEVICE)
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(false);
  });

  it("withholds the claim on a machine whose level does carry transcripts", async () => {
    flagEnabled.mockReturnValue(true);
    consentRead.mockReturnValue({
      record: { tier: "full", bound: true, organizationId: ORG },
      isResolved: true,
    });
    installBridge(() => Promise.resolve(snapshot(THIS_DEVICE)));

    const { result } = renderHook(() =>
      useTranscriptNeverExpected(THIS_DEVICE)
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current).toBe(false);
  });
});
