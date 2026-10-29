import {
  RELATED_SESSIONS_BATCH_ROUTE,
  RELATED_SESSIONS_PAGE_ARTIFACT_CAP,
} from "@repo/api/src/types/related-session";
/**
 * ISS-7235 — the Related Sessions read hook.
 *
 * This file exists because the section's own suite mocks this module wholesale.
 * That made two claims unfalsifiable there: "issues no read when the flag is
 * off" (which asserted the ARGUMENT the section passes, not that a request was
 * withheld) and the request path itself (which nothing executed, since the
 * route test drives the server handler directly). Deleting `enabled` from
 * `useQuery`, or changing the URL, left the whole suite green. Both mutations
 * fail here.
 */
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../../../shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: mocks.get,
    post: mocks.post,
  }),
}));

import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  relatedSessionKeys,
  useRelatedSessions,
  useRelatedSessionsMatches,
  useRelatedSessionsPage,
  useRelatedSessionsSearch,
} from "../use-related-sessions";

const ARTIFACT = "artifact-a";
const RESULT = { items: [], total: 0 };

function wrapper() {
  const queryClient = createTestQueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(RESULT);
});

describe("Related Sessions collection facets", () => {
  const sessionId = "11111111-1111-7111-8111-111111111111";

  test("uses the selected session filter to match beyond the visible pills", async () => {
    mocks.post.mockResolvedValue({
      results: { a: { items: [], total: 1 }, b: { items: [], total: 0 } },
      appliedSessionArtifactIds: [sessionId],
    });
    const { result } = renderHook(
      () => useRelatedSessionsMatches(["a", "b"], [sessionId], true),
      { wrapper: wrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.post).toHaveBeenCalledWith(RELATED_SESSIONS_BATCH_ROUTE, {
      artifactIds: ["a", "b"],
      sessionArtifactIds: [sessionId],
    });
    expect(result.current.data).toEqual({ matchingArtifactIds: ["a"] });
  });

  test("fails safely when an older server silently ignores the filter", async () => {
    mocks.post.mockResolvedValue({ results: { a: { items: [], total: 5 } } });
    const { result } = renderHook(
      () => useRelatedSessionsMatches(["a"], [sessionId], true),
      { wrapper: wrapper() }
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  test.each([-1, 1.5, "1", undefined])(
    "rejects a malformed matching total instead of treating it as zero: %s",
    async (total) => {
      mocks.post.mockResolvedValue({
        results: { a: { items: [], total } },
        appliedSessionArtifactIds: [sessionId],
      });
      const { result } = renderHook(
        () => useRelatedSessionsMatches(["a"], [sessionId], true),
        { wrapper: wrapper() }
      );
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.data).toBeUndefined();
    }
  );

  test("searches canonical identities before the pill cap and checks scope", async () => {
    mocks.post.mockResolvedValue({
      results: { a: { items: [], total: 0 } },
      appliedSessionSearch: "review",
    });
    const { result } = renderHook(
      () => useRelatedSessionsSearch(["a"], " review ", true),
      { wrapper: wrapper() }
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.post).toHaveBeenCalledWith(RELATED_SESSIONS_BATCH_ROUTE, {
      artifactIds: ["a"],
      sessionSearch: "review",
    });
    expect(result.current.data).toEqual({ items: [] });
  });
});

describe("useRelatedSessions", () => {
  test("issues no request while disabled", async () => {
    renderHook(() => useRelatedSessions(ARTIFACT, false), {
      wrapper: wrapper(),
    });

    // Give react-query a tick to do the thing we are asserting it does NOT do.
    await waitFor(() => expect(mocks.get).not.toHaveBeenCalled());
  });

  test("reads the artifact-generic provenance route when enabled", async () => {
    const { result } = renderHook(() => useRelatedSessions(ARTIFACT, true), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // Pinned as a hand-written literal, not rebuilt from the same template the
    // hook uses, so a changed path fails rather than following along.
    expect(mocks.get).toHaveBeenCalledWith(
      "/artifacts/artifact-a/related-sessions"
    );
    expect(result.current.data).toEqual(RESULT);
  });

  test("defaults to enabled so a caller that omits the flag still reads", async () => {
    const { result } = renderHook(() => useRelatedSessions(ARTIFACT), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  test("surfaces a failed read rather than resolving it as empty", async () => {
    mocks.get.mockRejectedValue(new Error("boom"));

    const { result } = renderHook(() => useRelatedSessions(ARTIFACT, true), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });

  test("keys the cache per artifact so two artifacts cannot share a list", () => {
    expect(relatedSessionKeys.list("a")).not.toEqual(
      relatedSessionKeys.list("b")
    );
  });
});

describe("useRelatedSessionsPage", () => {
  test("does not read a hidden field and batches only distinct visible rows", async () => {
    mocks.post.mockResolvedValue({ results: { a: { items: [], total: 0 } } });
    const disabled = renderHook(
      () => useRelatedSessionsPage(["a", "a"], false),
      { wrapper: wrapper() }
    );
    expect(mocks.post).not.toHaveBeenCalled();
    disabled.unmount();
    const mounted = renderHook(() => useRelatedSessionsPage(["a", "a"], true), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(mounted.result.current.isSuccess).toBe(true));
    expect(mocks.post).toHaveBeenCalledWith(RELATED_SESSIONS_BATCH_ROUTE, {
      artifactIds: ["a"],
    });
    expect(mounted.result.current.data?.results.a?.total).toBe(0);
    expect(mounted.result.current.data?.results.b).toBeUndefined();
  });
  test("reads every visible ID when a grouped view exceeds the server request cap", async () => {
    mocks.post.mockImplementation((_route, body) =>
      Promise.resolve({
        results: Object.fromEntries(
          body.artifactIds.map((id: string) => [id, { items: [], total: 0 }])
        ),
      })
    );
    const ids = Array.from(
      { length: RELATED_SESSIONS_PAGE_ARTIFACT_CAP + 1 },
      (_, i) => `artifact-${i}`
    );
    const mounted = renderHook(() => useRelatedSessionsPage(ids, true), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(mounted.result.current.isSuccess).toBe(true));
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(
      Object.keys(mounted.result.current.data?.results ?? {})
    ).toHaveLength(ids.length);
  });
});
