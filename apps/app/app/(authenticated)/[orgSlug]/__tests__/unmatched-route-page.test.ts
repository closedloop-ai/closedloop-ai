import { notFound } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UnmatchedOrgRoutePage from "../[...unmatched]/page";

/**
 * closedloop-ai-stage, PR #4501 (ISS-5011): `/{orgSlug}/webhooks` was deleted
 * with no successor, and an org-scoped URL that matches no route falls out of
 * the `(authenticated)` layout onto Next's bare system 404 — no sidebar, no org
 * context. The catch-all under `[orgSlug]` exists solely to raise `notFound()`
 * so `(authenticated)/not-found.tsx` renders the in-shell 404 instead.
 *
 * `notFound()` is the whole behavior, so this executes the page and asserts the
 * raise. The route's *placement* (that Next actually dispatches an unmatched org
 * URL here) is proven end to end by `e2e/navigation.spec.ts`.
 */

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  }),
}));

describe("[orgSlug]/[...unmatched] catch-all", () => {
  // The `notFound` mock is created once at module scope, so its call count is
  // cumulative across every execution of the test body. Vitest applies no
  // global reset (no `clearMocks` in vitest.config.mts, no `clearAllMocks` in
  // vitest.setup.ts), so a re-run — vitest `retry`/`repeats`, or Datadog Early
  // Flake Detection re-running a newly added test — would observe 2 calls and
  // fail an assertion that passed the first time. Clearing here scopes the
  // count to the current execution and keeps the assertion exact.
  beforeEach(() => {
    vi.mocked(notFound).mockClear();
  });

  it("raises notFound() so the in-shell 404 boundary renders", () => {
    expect(() => UnmatchedOrgRoutePage()).toThrow(
      "NEXT_HTTP_ERROR_FALLBACK;404"
    );
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
