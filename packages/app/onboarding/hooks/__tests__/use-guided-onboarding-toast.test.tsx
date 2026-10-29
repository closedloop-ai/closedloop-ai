/**
 * PLN-1875 Step 8: what a failed `finish_tour` shows the reader.
 *
 * Nothing. `finish_tour` posts on the beat the reader presses Done or Skip on a
 * welcome tour — they asked to close a callout, not to save anything — and the
 * shared client's default handler would answer a lost write with "Operation
 * failed · The operation did not complete", which names nothing they did and
 * offers nothing they can retry. A stale revision across two tabs is enough to
 * reach it.
 *
 * Driven through the REAL shared client rather than a bare `QueryClient`,
 * because the suppression is a `meta` flag that only that client's default
 * `onError` reads: a hand-rolled client would assert the flag's presence and
 * prove nothing about the toast. The control case posts an unsuppressed
 * mutation through the same client, so a run where the toast path itself had
 * gone quiet cannot read as a pass.
 */

import { OnboardingEvent } from "@repo/api/src/types/onboarding-events";
import { OnboardingHost } from "@repo/api/src/types/onboarding-phase";
import { QueryClientProvider, useMutation } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { makeQueryClient } from "../../../shared/query/query-client";
import { useGuidedOnboardingTransition } from "../use-guided-onboarding";
import {
  EXPERIENCE_VARIANT,
  ORG_A,
  tourSnapshot,
  USER_A,
} from "./guided-onboarding.test-helpers";

const { toast } = vi.hoisted(() => ({
  toast: { error: vi.fn() },
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({ toast }));

const mockApiClient = { get: vi.fn(), post: vi.fn() };

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const TRANSITION_FAILED = new Error("transition failed");

function sharedClientWrapper() {
  const queryClient = makeQueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({
          isLoaded: true,
          orgId: ORG_A,
          userId: USER_A,
        })}
      >
        {children}
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useGuidedOnboardingTransition — a lost write", () => {
  it("tells the reader nothing when the run cannot be recorded", async () => {
    mockApiClient.post.mockRejectedValue(TRANSITION_FAILED);

    const { result } = renderHook(
      () =>
        useGuidedOnboardingTransition({
          analysisStarted: false,
          experienceVariant: EXPERIENCE_VARIANT,
          host: OnboardingHost.Web,
        }),
      { wrapper: sharedClientWrapper() }
    );
    await act(async () => {
      await expect(
        result.current.mutateAsync({
          event: { type: OnboardingEvent.FinishTour },
          snapshot: tourSnapshot(),
        })
      ).rejects.toThrow(TRANSITION_FAILED);
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("still toasts a mutation that did not ask to be silenced", async () => {
    // The control. Same client, same failure — so the case above cannot pass on
    // a toast path that was never wired up in this environment at all.
    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: () => Promise.reject(TRANSITION_FAILED),
        }),
      { wrapper: sharedClientWrapper() }
    );
    await act(async () => {
      await expect(result.current.mutateAsync()).rejects.toThrow(
        TRANSITION_FAILED
      );
    });

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
  });
});
