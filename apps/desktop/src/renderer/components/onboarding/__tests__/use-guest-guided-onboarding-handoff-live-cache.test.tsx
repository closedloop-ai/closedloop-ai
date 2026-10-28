/**
 * ISS-10340: the guest's position survives a lost handoff against the REAL
 * transition hook and a REAL `QueryClient`.
 *
 * The sibling suite stubs `useGuidedOnboardingTransition` so it can drive each
 * `onError` shape by hand, and that stub is exactly what hides this: the shared
 * hook's own `onError` calls `invalidateQueries` on the snapshot key before any
 * per-call handler runs, so the first shipped fix — seeding the composed
 * snapshot into that key — was overwritten by the refetch the invalidation had
 * already started, and `isInvalidated` outlived the write in any case. Nothing
 * with a stubbed mutation and a stubbed query client can see that, which is why
 * these two cases go through the real module graph.
 */

import { OnboardingAccountMode } from "@repo/api/src/types/onboarding-analytics";
import { guidedOnboardingSnapshotSchema } from "@repo/api/src/types/onboarding-guided";
import {
  KnownFlag,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { ApiError } from "@repo/app/shared/api/api-error";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { useGuestGuidedOnboardingHandoff } from "../use-guest-guided-onboarding-handoff";
import {
  firstRunServerSnapshot,
  ORG_ID,
  seedGuestRecord,
  USER_ID,
} from "./guest-guided-onboarding-handoff-fixtures";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

// The ONLY seam stubbed: the transport. Everything from `useApiClient` inward
// — the transition mutation, its invalidation, the snapshot query, the cache —
// is the production module.
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: mocks.get, post: mocks.post }),
}));

vi.mock("@repo/app/shared/auth/use-auth-snapshot", () => ({
  useAuthSnapshot: () => authSnapshot(),
  useOptionalAuthSnapshot: () => authSnapshot(),
}));

beforeEach(() => {
  stubLocalStorage();
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(firstRunServerSnapshot());
});

describe("useGuestGuidedOnboardingHandoff against a live query cache", () => {
  it("keeps the guest's position after the shared hook invalidates and re-reads", async () => {
    seedGuestRecord();
    // A lost write: status 0 is what `createApiClient` mints for a network
    // failure or a client deadline, and it is the only class the position is
    // held through.
    mocks.post.mockRejectedValue(new ApiError("Network error", 0));

    const { result } = renderHandoff();

    await waitFor(() => {
      expect(result.current?.snapshot?.state.phase).toBe(
        OnboardingPhase.Account
      );
    });

    // The invalidation the shared `onError` fired re-reads the server's absent
    // attempt — a first run at Welcome. That answer landing is the moment the
    // seeded-cache fix lost the position, so wait for it specifically rather
    // than asserting on the tick the failure happened.
    await waitFor(() => {
      expect(mocks.get.mock.calls.length).toBeGreaterThan(1);
    });
    expect(result.current?.snapshot?.state.phase).toBe(OnboardingPhase.Account);
    expect(result.current?.snapshot?.revision).toBe(0);
  });

  /**
   * The snapshot query PARSES its body, so a fixture the schema rejects would
   * fail the query and both cases above would pass for the wrong reason — the
   * hook never posts without a server read. Pinned rather than trusted.
   */
  it("uses a server fixture the production schema accepts", () => {
    expect(() =>
      guidedOnboardingSnapshotSchema.parse(firstRunServerSnapshot())
    ).not.toThrow();
  });

  it("hands the mount back to the server when the API refuses the command", async () => {
    seedGuestRecord();
    mocks.post.mockRejectedValue(new ApiError("refused", 400));

    const { result } = renderHandoff();

    // A refusal is the server ruling on this command, so the re-read the shared
    // hook performs is the reconciliation — not a position to hold.
    await waitFor(() => {
      expect(mocks.post).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current).toBeUndefined();
    });
  });
});

function renderHandoff() {
  return renderHook(
    () =>
      useGuestGuidedOnboardingHandoff({
        accountMode: [OnboardingAccountMode.SignedIn],
        active: true,
        analysisStarted: true,
        onDashboardAvailable: () => undefined,
        organizationId: ORG_ID,
        syncConsentRecorded: KnownFlag.Yes,
        userId: USER_ID,
      }),
    { wrapper: withQueryClient }
  );
}

function authSnapshot() {
  return {
    getToken: () => Promise.resolve(null),
    isLoaded: true,
    orgId: ORG_ID,
    userId: USER_ID,
  };
}

function withQueryClient({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
