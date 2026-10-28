/**
 * ISS-5991: the onboarding status is the CALLER's, so its cache entry is
 * namespaced by user. The browser QueryClient is a module-level singleton that
 * is only cleared on an organization switch, so an unnamespaced key would let
 * one user's dismissal answer for the next user in the same tab.
 */

import type { OnboardingStatus } from "@repo/api/src/types/onboarding";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthAdapterProvider } from "../../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../../shared/auth/static-auth-adapter";
import { shouldRetryQuery } from "../../../shared/query/query-client";
import {
  onboardingKeys,
  useCompleteWizard,
  useDismissChecklist,
  useOnboardingStatus,
} from "../use-onboarding";

const mockApiClient = {
  get: vi.fn(),
  put: vi.fn(),
};

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => mockApiClient,
}));

const USER_A = "user-a";
const USER_B = "user-b";
const ORG_A = "org-a";
const ORG_B = "org-b";

function status(checklistDismissed: boolean): OnboardingStatus {
  return { wizardCompleted: true, checklistDismissed, checklist: [] };
}

/**
 * For the mutation suites below: they assert on cache entries that have NO
 * mounted observer (only the mutation hook renders), and `gcTime: 0` collects
 * an unobserved entry on the next tick — which under a loaded run fires
 * between `setQueryData` and the assertion. Pin gcTime so the entry survives
 * long enough to be read.
 */
function createMutationTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Number.POSITIVE_INFINITY, retry: false },
      mutations: { retry: false },
    },
  });
}

/**
 * The shared client's retry predicate with the backoff removed, so a retry the
 * policy allows lands inside the test rather than seconds after it.
 */
function createRetryingTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: 0, retry: shouldRetryQuery, retryDelay: 0 },
    },
  });
}

function createOnboardingWrapper(
  queryClient: QueryClient,
  userId: string | null,
  isLoaded = true,
  orgId: string | null = ORG_A
) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthAdapterProvider
        adapter={createStaticAuthAdapter({ isLoaded, orgId, userId })}
      >
        {children}
      </AuthAdapterProvider>
    </QueryClientProvider>
  );
}

/**
 * A wrapper whose auth snapshot is driven by a mutable identity, so ONE mounted
 * tree can be walked through a real sign-out/sign-in lifecycle. Mounting a
 * second tree with a second fixed adapter proves nothing about propagation: the
 * shell reuses one tree and one QueryClient across the switch, and it is the
 * intermediate unloaded/null state that used to hand account B account A's
 * cached status.
 */
function createSwitchableWrapper(queryClient: QueryClient) {
  let identity: {
    isLoaded: boolean;
    orgId: string | null;
    userId: string | null;
  } = { isLoaded: false, orgId: null, userId: null };

  const adapter = {
    useAuthSnapshot: () => ({
      ...identity,
      getToken: () => Promise.resolve("test-token"),
    }),
  };

  return {
    setIdentity(next: {
      isLoaded: boolean;
      orgId: string | null;
      userId: string | null;
    }) {
      identity = next;
    },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <AuthAdapterProvider adapter={adapter}>{children}</AuthAdapterProvider>
      </QueryClientProvider>
    ),
  };
}

describe("useOnboardingStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("never shows account A's dismissal to account B across one tab's switch", async () => {
    const queryClient = createTestQueryClient();
    const { wrapper, setIdentity } = createSwitchableWrapper(queryClient);
    mockApiClient.get.mockResolvedValue(status(true));

    setIdentity({ isLoaded: true, orgId: ORG_A, userId: USER_A });
    const view = renderHook(() => useOnboardingStatus(), { wrapper });
    await waitFor(() =>
      expect(view.result.current.data?.checklistDismissed).toBe(true)
    );

    // Signing out: the shell drops to unloaded/null before the next identity
    // arrives. Account A's answer must not survive into that window.
    setIdentity({ isLoaded: false, orgId: null, userId: null });
    view.rerender();
    await waitFor(() => expect(view.result.current.isPending).toBe(true));
    expect(view.result.current.data).toBeUndefined();

    mockApiClient.get.mockResolvedValue(status(false));
    setIdentity({ isLoaded: true, orgId: ORG_A, userId: USER_B });
    view.rerender();

    await waitFor(() =>
      expect(view.result.current.data?.checklistDismissed).toBe(false)
    );
    // Account B's answer came from account B's own request, not from the entry
    // account A left behind.
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
    expect(
      queryClient.getQueryData(onboardingKeys.status(ORG_A, USER_B))
    ).toEqual(status(false));
  });

  // The response carries the organization's checklist as well as the caller's
  // dismissal, and the shell clears the cache on an org switch only later, in an
  // effect. Without the org in the key, the previous org's still-fresh status
  // renders in the gap.
  it("never shows one org's status after the same user switches orgs", async () => {
    const queryClient = createTestQueryClient();
    const { wrapper, setIdentity } = createSwitchableWrapper(queryClient);
    mockApiClient.get.mockResolvedValue(status(true));

    setIdentity({ isLoaded: true, orgId: ORG_A, userId: USER_A });
    const view = renderHook(() => useOnboardingStatus(), { wrapper });
    await waitFor(() =>
      expect(view.result.current.data?.checklistDismissed).toBe(true)
    );

    mockApiClient.get.mockResolvedValue(status(false));
    setIdentity({ isLoaded: true, orgId: ORG_B, userId: USER_A });
    view.rerender();

    await waitFor(() =>
      expect(view.result.current.data?.checklistDismissed).toBe(false)
    );
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
    expect(
      queryClient.getQueryData(onboardingKeys.status(ORG_B, USER_A))
    ).toEqual(status(false));
  });

  // The shell reports `userId: null` until auth hydrates. Fetching in that
  // window would park the signed-in user's status under the shared null key,
  // which the next account in the same tab reads back before its own identity
  // resolves — the leak the namespacing exists to close.
  it("does not fetch or cache anything before the identity hydrates", async () => {
    const queryClient = createTestQueryClient();

    const { result } = renderHook(() => useOnboardingStatus(), {
      wrapper: createOnboardingWrapper(queryClient, null, false),
    });

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(mockApiClient.get).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData(onboardingKeys.status(null, null))
    ).toBeUndefined();
  });

  it("stays idle for a loaded-but-signed-out shell", async () => {
    const queryClient = createTestQueryClient();

    const { result } = renderHook(() => useOnboardingStatus(), {
      wrapper: createOnboardingWrapper(queryClient, null),
    });

    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  it("lets a caller narrow the gate but never widen it", () => {
    const queryClient = createTestQueryClient();

    renderHook(() => useOnboardingStatus({ enabled: true }), {
      wrapper: createOnboardingWrapper(queryClient, null, false),
    });

    expect(mockApiClient.get).not.toHaveBeenCalled();
  });

  // ISS-7828: the guard and the page route on `wizardCompleted`, so a 2xx they
  // cannot read must reach them as an error, never as an absent field.
  // Under the shared client's retry policy: a body that failed the schema is not
  // retried on backoff, which would hold off the card for the same body.
  it("turns a malformed 2xx into a query error with no data, on its first read", async () => {
    const queryClient = createRetryingTestQueryClient();
    mockApiClient.get.mockResolvedValue({});

    const { result } = renderHook(() => useOnboardingStatus(), {
      wrapper: createOnboardingWrapper(queryClient, USER_A),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(mockApiClient.get).toHaveBeenCalledTimes(1);
  });

  it("still retries a read that got no response", async () => {
    const queryClient = createRetryingTestQueryClient();
    mockApiClient.get
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(status(false));

    const { result } = renderHook(() => useOnboardingStatus(), {
      wrapper: createOnboardingWrapper(queryClient, USER_A),
    });

    await waitFor(() => expect(result.current.data).toEqual(status(false)));
    expect(mockApiClient.get).toHaveBeenCalledTimes(2);
  });
});

// ISS-7089 F3 (PLN-1750 Step 3.1): both mutations now WRITE the fresh status
// their PUT returns into the caller's namespaced cache entry instead of
// invalidating it. Invalidation left an in-flight refetch window in which the
// cache still read the stale status — the exact window OnboardingGuard used to
// blank the entire content region around. The old "invalidates the entry"
// expectation is deliberately retired with that behavior.
describe("useDismissChecklist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes the returned status into the caller's cache with no refetch window", async () => {
    const queryClient = createMutationTestQueryClient();
    queryClient.setQueryData(
      onboardingKeys.status(ORG_A, USER_A),
      status(false)
    );
    mockApiClient.put.mockResolvedValue(status(true));

    const { result } = renderHook(() => useDismissChecklist(), {
      wrapper: createOnboardingWrapper(queryClient, USER_A),
    });
    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(mockApiClient.put).toHaveBeenCalledWith(
      "/onboarding/dismiss-checklist",
      {}
    );
    expect(
      queryClient.getQueryData(onboardingKeys.status(ORG_A, USER_A))
    ).toEqual(status(true));
    expect(
      queryClient.getQueryState(onboardingKeys.status(ORG_A, USER_A))
        ?.isInvalidated
    ).toBe(false);
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});

describe("useDismissChecklist — mid-flight identity switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Mutation callbacks are refreshed on every render, so a success handler
  // that read the LIVE auth snapshot would write the response under whichever
  // org is active at RESOLVE time — misattributing one tenant's onboarding
  // status to another across a mid-flight org switch.
  it("attributes the response to the identity that made the call, not the one live at resolve time", async () => {
    const queryClient = createMutationTestQueryClient();
    const { wrapper, setIdentity } = createSwitchableWrapper(queryClient);
    let releasePut: ((value: OnboardingStatus) => void) | undefined;
    mockApiClient.put.mockImplementationOnce(
      () =>
        new Promise<OnboardingStatus>((resolve) => {
          releasePut = resolve;
        })
    );

    setIdentity({ isLoaded: true, orgId: ORG_A, userId: USER_A });
    const view = renderHook(() => useDismissChecklist(), { wrapper });

    let mutation: Promise<OnboardingStatus | null> | undefined;
    act(() => {
      mutation = view.result.current.mutateAsync();
      // Settled below; the catch only prevents an unhandled-rejection crash
      // from masking the assertion failure if the mutation errors.
      mutation.catch(() => undefined);
    });
    await waitFor(() => expect(mockApiClient.put).toHaveBeenCalledTimes(1));

    // The org switch lands while the PUT is in flight; the observer's
    // callbacks are refreshed with the new identity before resolution.
    setIdentity({ isLoaded: true, orgId: ORG_B, userId: USER_A });
    view.rerender();

    await act(async () => {
      releasePut?.(status(true));
      await mutation;
    });

    expect(
      queryClient.getQueryData(onboardingKeys.status(ORG_A, USER_A))
    ).toEqual(status(true));
    expect(
      queryClient.getQueryData(onboardingKeys.status(ORG_B, USER_A))
    ).toBeUndefined();
  });
});

describe("useCompleteWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The guard no longer blanks on `isFetching`, so the post-wizard transition
  // must never present a cache that still reads `wizardCompleted: false`: the
  // fresh status lands synchronously with the mutation's success.
  it("flips wizardCompleted in the cache synchronously, leaving no stale window", async () => {
    const queryClient = createMutationTestQueryClient();
    const incomplete: OnboardingStatus = {
      checklist: [],
      checklistDismissed: false,
      wizardCompleted: false,
    };
    queryClient.setQueryData(onboardingKeys.status(ORG_A, USER_A), incomplete);
    mockApiClient.put.mockResolvedValue(status(false));

    const { result } = renderHook(() => useCompleteWizard(), {
      wrapper: createOnboardingWrapper(queryClient, USER_A),
    });
    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(mockApiClient.put).toHaveBeenCalledWith(
      "/onboarding/complete-wizard",
      {}
    );
    expect(
      queryClient.getQueryData(onboardingKeys.status(ORG_A, USER_A))
    ).toEqual(status(false));
    expect(mockApiClient.get).not.toHaveBeenCalled();
  });
});

// ISS-7828: the PUT committed, so the mutation still succeeds; what it must not
// do is write a body the guard would then route on, NOR leave the pre-mutation
// answer in place for it to route on instead. The entry is reset, for
// `GET /onboarding` — which parses — to settle.
describe("status mutations — a response that does not parse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The wizard navigates as soon as this mutation succeeds. A kept
  // `wizardCompleted: false` would send the guard straight back to /onboarding,
  // and a failed re-read would then restart the wizard over the recovery card.
  it("useCompleteWizard drops the stale unfinished answer instead of keeping it", async () => {
    const queryClient = createMutationTestQueryClient();
    const key = onboardingKeys.status(ORG_A, USER_A);
    queryClient.setQueryData(key, {
      checklist: [],
      checklistDismissed: false,
      wizardCompleted: false,
    });
    mockApiClient.put.mockResolvedValue({});

    const { result } = renderHook(() => useCompleteWizard(), {
      wrapper: createOnboardingWrapper(queryClient, USER_A),
    });
    await act(async () => {
      await result.current.mutateAsync({});
    });

    expect(queryClient.getQueryData(key)).toBeUndefined();
    expect(queryClient.getQueryState(key)?.status).toBe("pending");
  });

  it("useDismissChecklist drops the stale answer instead of keeping it", async () => {
    const queryClient = createMutationTestQueryClient();
    const key = onboardingKeys.status(ORG_A, USER_A);
    queryClient.setQueryData(key, status(false));
    mockApiClient.put.mockResolvedValue({});

    const { result } = renderHook(() => useDismissChecklist(), {
      wrapper: createOnboardingWrapper(queryClient, USER_A),
    });
    await act(async () => {
      await result.current.mutateAsync();
    });

    expect(queryClient.getQueryData(key)).toBeUndefined();
    expect(queryClient.getQueryState(key)?.status).toBe("pending");
  });
});
