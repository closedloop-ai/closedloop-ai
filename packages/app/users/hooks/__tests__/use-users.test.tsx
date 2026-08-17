/**
 * FEA-4123: prove the profile-stats split at the hook + React Query layer with
 * a real transport, closing wongk's deferred #3691 architectural review.
 *
 * The page-level tests (`apps/app/.../users/[userId]/__tests__/`) mock the
 * hooks and prove the *filter* the toggle drives; the service tests prove the
 * ranged read fires no heatmap SQL. Neither exercises the actual hooks through
 * a live `QueryClient`, so neither proves that a range change cannot cause the
 * fixed-window contribution query to REFETCH.
 *
 * This test mounts the real `useUserProfileHeadline` + `useUserContributionHeatmap`
 * hooks under a real `QueryClientProvider` with an injected counting transport
 * (the sanctioned `ApiAdapter.fetch` fixture seam), then:
 *   - changes the range filter and asserts the HEADLINE endpoint refetches
 *     with the NEW `startDate` in its query string (never the old date or a
 *     dropped date) while the CONTRIBUTIONS endpoint is hit exactly once (a
 *     range click never re-issues the trailing-year heatmap read);
 *   - fails the contributions transport and asserts the headline query still
 *     resolves (widget independence), and the inverse.
 *
 * Any request that classifies to an unexpected endpoint throws inside the
 * transport, so a stray fetch fails the test loudly instead of silently
 * satisfying a refetch count. Counts are asserted from captured fetch calls
 * (structural), never from elapsed time.
 */

import type { ApiAdapter } from "@repo/app/shared/api/api-adapter";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import type {
  AuthAdapter,
  AuthSnapshot,
} from "@repo/app/shared/auth/auth-adapter";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import {
  useUserContributionHeatmap,
  useUserProfileHeadline,
  useUserProfileMilestones,
  useUserProfileStanding,
} from "@repo/app/users/hooks/use-users";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { describe, expect, it } from "vitest";

const userId = "user-1";
const headlinePath = `/users/${userId}/stats/headline`;
const contributionsPath = `/users/${userId}/contributions`;
const standingPath = `/users/${userId}/standing`;
const milestonesPath = `/users/${userId}/milestones`;

const initialStartDate = "2026-06-01T00:00:00.000Z";
const changedStartDate = "2026-01-01T00:00:00.000Z";

const headlineBody = {
  totalDocuments: 10,
  documentsByType: [],
  totalComments: 5,
  totalPRsLanded: 3,
  totalLoops: 7,
  avgConcurrency: 1.2,
  totalTokensInput: 1000,
  totalTokensOutput: 500,
  totalEstimatedCost: 4.2,
};

const heatmapBody = { contributionHeatmap: [] };
const standingBody = { streak: { currentDays: 3, bestDays: 9 } };
const milestonesBody = { milestones: [] };

/** Classify a request URL to the profile endpoint it targets. */
const Endpoint = {
  Headline: "headline",
  Contributions: "contributions",
  Standing: "standing",
  Milestones: "milestones",
  Other: "other",
} as const;
type Endpoint = (typeof Endpoint)[keyof typeof Endpoint];

function classify(url: string): Endpoint {
  const path = new URL(url, "http://api.test").pathname;
  if (path === headlinePath) {
    return Endpoint.Headline;
  }
  if (path === contributionsPath) {
    return Endpoint.Contributions;
  }
  if (path === standingPath) {
    return Endpoint.Standing;
  }
  if (path === milestonesPath) {
    return Endpoint.Milestones;
  }
  return Endpoint.Other;
}

/** Body for an endpoint's successful response. */
function bodyFor(endpoint: Endpoint): unknown {
  switch (endpoint) {
    case Endpoint.Headline:
      return headlineBody;
    case Endpoint.Contributions:
      return heatmapBody;
    case Endpoint.Standing:
      return standingBody;
    case Endpoint.Milestones:
      return milestonesBody;
    default:
      return {};
  }
}

/** Normalize the three `fetch` input shapes to a URL string. */
function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ success: true, data: body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A loaded, signed-in auth snapshot so the client never stalls on hydration. */
const loadedSnapshot: AuthSnapshot = {
  isLoaded: true,
  userId,
  orgId: "org-1",
  getToken: () => Promise.resolve("test-token"),
};

const authAdapter: AuthAdapter = {
  useAuthSnapshot: () => loadedSnapshot,
};

type TransportControls = {
  fetch: typeof fetch;
  /** Per-endpoint request counts, in call order. */
  counts: () => Record<Endpoint, number>;
  /** Full request URLs captured for the headline endpoint, in call order. */
  headlineUrls: () => string[];
  /** Force the given endpoint's transport to reject the next+all calls. */
  failEndpoint: (endpoint: Endpoint) => void;
};

function makeTransport(): TransportControls {
  const calls: Endpoint[] = [];
  const headlineRequests: string[] = [];
  const failing = new Set<Endpoint>();

  const fetchImpl: typeof fetch = (input) => {
    const url = requestUrl(input);
    const endpoint = classify(url);
    calls.push(endpoint);

    // A request to an unexpected endpoint is a real defect, not a passing
    // refetch: fail loudly so a stray read cannot slip through while the test
    // still claims the headline was the only thing that re-fetched.
    if (endpoint === Endpoint.Other) {
      return Promise.reject(
        new Error(`unexpected request to un-classified endpoint: ${url}`)
      );
    }

    if (endpoint === Endpoint.Headline) {
      headlineRequests.push(url);
    }

    if (failing.has(endpoint)) {
      // A failing fixed-window/headline read: 500 with a valid error envelope.
      return Promise.resolve(
        new Response(JSON.stringify({ success: false, error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      );
    }
    return Promise.resolve(jsonResponse(bodyFor(endpoint)));
  };

  const countOf = (endpoint: Endpoint) =>
    calls.filter((c) => c === endpoint).length;

  return {
    fetch: fetchImpl,
    counts: () => ({
      [Endpoint.Headline]: countOf(Endpoint.Headline),
      [Endpoint.Contributions]: countOf(Endpoint.Contributions),
      [Endpoint.Standing]: countOf(Endpoint.Standing),
      [Endpoint.Milestones]: countOf(Endpoint.Milestones),
      [Endpoint.Other]: countOf(Endpoint.Other),
    }),
    headlineUrls: () => [...headlineRequests],
    failEndpoint: (endpoint) => failing.add(endpoint),
  };
}

/** The `startDate` query value carried by a captured headline request URL. */
function startDateOf(url: string): string | null {
  return new URL(url, "http://api.test").searchParams.get("startDate");
}

function makeWrapper(transport: TransportControls) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const apiAdapter: ApiAdapter = {
    resolveApiOrigin: () => "http://api.test",
    fetch: transport.fetch,
  };
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <AuthAdapterProvider adapter={authAdapter}>
          <ApiAdapterProvider adapter={apiAdapter}>
            {children}
          </ApiAdapterProvider>
        </AuthAdapterProvider>
      </QueryClientProvider>
    );
  };
}

/**
 * Mount both split hooks with a mutable range filter, exactly as the profile
 * page composes them: the headline query is keyed by the range filter, the
 * contribution query is not.
 */
function useProfileHooks() {
  const [startDate, setStartDate] = useState(initialStartDate);
  const headline = useUserProfileHeadline(userId, { startDate });
  const heatmap = useUserContributionHeatmap(userId);
  const standing = useUserProfileStanding(userId);
  const milestones = useUserProfileMilestones(userId);
  return { headline, heatmap, standing, milestones, setStartDate };
}

describe("profile stats hooks split (FEA-4123)", () => {
  it("re-fetches ONLY the headline query on a range change, carrying the new startDate, never the fixed-window contribution read", async () => {
    const transport = makeTransport();
    const { result } = renderHook(() => useProfileHooks(), {
      wrapper: makeWrapper(transport),
    });

    // Both widgets load once on mount.
    await waitFor(() => {
      expect(result.current.headline.data).toBeDefined();
      expect(result.current.heatmap.data).toBeDefined();
    });
    expect(transport.counts()).toMatchObject({
      [Endpoint.Headline]: 1,
      [Endpoint.Contributions]: 1,
    });
    // The first headline read carries the initial range's startDate.
    expect(transport.headlineUrls().map(startDateOf)).toEqual([
      initialStartDate,
    ]);

    // A range click changes ONLY the headline query key.
    act(() => {
      result.current.setStartDate(changedStartDate);
    });

    // The headline read re-issues under the new window...
    await waitFor(() => {
      expect(transport.counts()[Endpoint.Headline]).toBe(2);
    });
    // ...and the second read carries the NEW startDate, not the old one and
    // not a dropped date. `classify()` discards the query string, so this
    // guards the actual window each fetch requested.
    expect(transport.headlineUrls().map(startDateOf)).toEqual([
      initialStartDate,
      changedStartDate,
    ]);
    // ...while the fixed-window contribution read is NOT re-issued: a range
    // click can never re-run the trailing-year heatmap SQL (widget split).
    expect(transport.counts()[Endpoint.Contributions]).toBe(1);
    // And no unrelated endpoint was touched.
    expect(transport.counts()[Endpoint.Other]).toBe(0);
  });

  it("still resolves the headline query when the fixed-window contribution read fails (widget independence)", async () => {
    const transport = makeTransport();
    transport.failEndpoint(Endpoint.Contributions);

    const { result } = renderHook(() => useProfileHooks(), {
      wrapper: makeWrapper(transport),
    });

    await waitFor(() => {
      // The ranged headline resolves with real data despite the failing widget.
      expect(result.current.headline.data).toMatchObject({
        totalDocuments: 10,
      });
      // The heatmap query surfaces its own error, isolated to that widget.
      expect(result.current.heatmap.isError).toBe(true);
    });
    expect(result.current.headline.isError).toBe(false);
  });

  it("still resolves the contribution query when the ranged headline read fails (inverse independence)", async () => {
    const transport = makeTransport();
    transport.failEndpoint(Endpoint.Headline);

    const { result } = renderHook(() => useProfileHooks(), {
      wrapper: makeWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.heatmap.data).toMatchObject({
        contributionHeatmap: [],
      });
      expect(result.current.headline.isError).toBe(true);
    });
    expect(result.current.heatmap.isError).toBe(false);
  });

  it("loads the standing and milestones widgets on mount alongside the others (FEA-4108)", async () => {
    const transport = makeTransport();
    const { result } = renderHook(() => useProfileHooks(), {
      wrapper: makeWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.standing.data).toMatchObject({
        streak: { currentDays: 3, bestDays: 9 },
      });
      expect(result.current.milestones.data).toMatchObject({
        milestones: [],
      });
    });
    // Each new widget fires exactly one read of its own endpoint — not scoped
    // by the range toggle, so a range change never re-issues them.
    expect(transport.counts()[Endpoint.Standing]).toBe(1);
    expect(transport.counts()[Endpoint.Milestones]).toBe(1);
    expect(transport.counts()[Endpoint.Other]).toBe(0);
  });

  it("isolates a failing standing read from milestones, headline, and contributions (FEA-4108 widget independence)", async () => {
    const transport = makeTransport();
    transport.failEndpoint(Endpoint.Standing);

    const { result } = renderHook(() => useProfileHooks(), {
      wrapper: makeWrapper(transport),
    });

    await waitFor(() => {
      // The failing widget surfaces its own error...
      expect(result.current.standing.isError).toBe(true);
      // ...while every other widget still resolves with real data.
      expect(result.current.milestones.data).toMatchObject({
        milestones: [],
      });
      expect(result.current.headline.data).toMatchObject({
        totalDocuments: 10,
      });
      expect(result.current.heatmap.data).toMatchObject({
        contributionHeatmap: [],
      });
    });
    expect(result.current.milestones.isError).toBe(false);
    expect(result.current.headline.isError).toBe(false);
    expect(result.current.heatmap.isError).toBe(false);
  });

  it("isolates a failing milestones read from the other three widgets (FEA-4108 widget independence)", async () => {
    const transport = makeTransport();
    transport.failEndpoint(Endpoint.Milestones);

    const { result } = renderHook(() => useProfileHooks(), {
      wrapper: makeWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.milestones.isError).toBe(true);
      expect(result.current.standing.data).toMatchObject({
        streak: { currentDays: 3, bestDays: 9 },
      });
      expect(result.current.headline.data).toMatchObject({
        totalDocuments: 10,
      });
    });
    expect(result.current.standing.isError).toBe(false);
    expect(result.current.headline.isError).toBe(false);
  });
});
