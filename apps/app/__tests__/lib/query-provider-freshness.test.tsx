/**
 * Production-wiring guard for the web shell's freshness policy (ISS-5976).
 *
 * `packages/app/shared/query/__tests__/query-client-freshness.test.ts` proves the
 * shared factory's behavior. It cannot prove that the WEB SHELL actually takes
 * that behavior: the shell builds its browser client in `lib/query-client.tsx`,
 * and an override added there later (`refetchOnWindowFocus: false`) would
 * silently restore the exact defect ISS-5976 removed while every shared-package
 * test stayed green.
 *
 * So this reads the freshness policy off the client the real `QueryProvider`
 * puts on the context, through the same `useQueryClient` hook every product hook
 * uses. It asserts the shipped behavior of the shell, not of the factory.
 *
 * The focus option is RESOLVED against synthetic query states rather than
 * stringified (wongk review on #4818). Stringifying was already weak — it proved
 * only that an option was exposed — and it became actively unsafe once the
 * default became the `shouldRefetchOnFocus` predicate, whose own source contains
 * the literal `true`: a `toHaveTextContent("true")` assertion would keep passing
 * against a function that always returned `false`. Resolving the policy the way
 * React Query itself does is the only form that can fail for the right reason.
 * The end-to-end proof that these options reach a real surface is the Playwright
 * regression in `e2e/sessions-focus-refetch.spec.ts`.
 */

import type { Query } from "@tanstack/react-query";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QueryProvider } from "../../lib/query-client";

/** A minimal query stand-in carrying only the state the focus policy reads. */
function queryWithState(status: string, errorUpdatedAt: number): Query {
  return { state: { errorUpdatedAt, status } } as unknown as Query;
}

/**
 * Resolve a `refetchOnWindowFocus` value the way React Query's `shouldFetchOn`
 * does: call it when it is a predicate, otherwise take it literally.
 */
function resolveFocusPolicy(
  option: unknown,
  query: Query
): boolean | "always" | undefined {
  if (typeof option === "function") {
    return (option as (q: Query) => boolean | "always")(query);
  }
  return option as boolean | "always" | undefined;
}

function FreshnessProbe() {
  const client = useQueryClient();
  const defaults = client.getDefaultOptions().queries;
  const focus = defaults?.refetchOnWindowFocus;
  return (
    <dl>
      <dt>healthy focus</dt>
      <dd data-testid="focus-healthy">
        {String(resolveFocusPolicy(focus, queryWithState("success", 0)))}
      </dd>
      <dt>errored focus</dt>
      <dd data-testid="focus-errored">
        {String(resolveFocusPolicy(focus, queryWithState("error", Date.now())))}
      </dd>
      <dt>reconnect</dt>
      <dd data-testid="reconnect">{String(defaults?.refetchOnReconnect)}</dd>
      <dt>staleTime</dt>
      <dd data-testid="stale-time">{String(defaults?.staleTime)}</dd>
    </dl>
  );
}

describe("web shell QueryProvider freshness wiring", () => {
  it("puts a client that refetches on focus and reconnect on the context", () => {
    render(
      <QueryProvider>
        <FreshnessProbe />
      </QueryProvider>
    );

    // The web shell has no push stream, so these two events are the only things
    // that ever act on staleness here. Both must survive the trip through the
    // real provider, not just the factory.
    expect(screen.getByTestId("focus-healthy")).toHaveTextContent("true");
    expect(screen.getByTestId("reconnect")).toHaveTextContent("true");
    // ...and the one-minute window that bounds what they can cost.
    expect(screen.getByTestId("stale-time")).toHaveTextContent("60000");
  });

  it("withholds the focus refetch from a query that just failed", () => {
    // The failure-path bound (codex P2 review): `staleTime` never restarts for an
    // errored query, so without this the shell would re-fetch every mounted query
    // on every focus event for the whole duration of an outage.
    render(
      <QueryProvider>
        <FreshnessProbe />
      </QueryProvider>
    );

    expect(screen.getByTestId("focus-errored")).toHaveTextContent("false");
  });

  it("hands the same browser client to every consumer rather than one per mount", () => {
    // The freshness triggers act on a query's cached `dataUpdatedAt`. A provider
    // that minted a fresh client per mount would reset that clock on every
    // navigation, so focus would refetch far more often than `staleTime` implies
    // — the request-volume bound depends on this singleton holding.
    const seen: QueryClient[] = [];
    function Capture() {
      seen.push(useQueryClient());
      return null;
    }
    const first = render(
      <QueryProvider>
        <Capture />
      </QueryProvider>
    );
    first.unmount();
    render(
      <QueryProvider>
        <Capture />
      </QueryProvider>
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});
