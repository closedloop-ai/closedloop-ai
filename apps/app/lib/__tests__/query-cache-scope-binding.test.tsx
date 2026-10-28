/**
 * ISS-7442. The web shell's production wiring for tenant cache identity, plus
 * the timing property that motivated it.
 *
 * The shell's clear-on-organization-change effect (`sidebar.tsx`, hardened by
 * ISS-7344) can only run after commit, so between an organization flip and that
 * effect there is a render in which the previous organization's entries are
 * still reachable — the window `use-onboarding.ts` documents (ISS-5991).
 * Nothing here mounts a clear: the only thing standing between the probe and
 * the previous organization's rows is the render-phase scope binding, so a leak
 * here is a real leak.
 */

import { makeQueryClient } from "@repo/app/shared/query/query-client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryCacheScopeBinding } from "../query-cache-scope-binding";

const authState = vi.hoisted(() => ({
  current: { userId: "user-1", orgId: "org-a" } as {
    userId: string | null;
    orgId: string | null;
  },
}));

vi.mock("@repo/auth/client", () => ({
  useAuth: () => authState.current,
}));

const DOCUMENTS_LIST_KEY = ["documents", "list", { status: "draft" }] as const;
const ORG_A_ROWS = "org-a-rows";
const LOADING = "loading";

let client: ReturnType<typeof makeQueryClient>;

function Probe() {
  const { data, isPending } = useQuery({
    queryKey: DOCUMENTS_LIST_KEY,
    // Never settles, so the probe has exactly two reachable outcomes: it either
    // found a cached entry or it is loading. That makes "not the previous
    // organization's rows" a decision rather than a race with a resolved fetch.
    queryFn: () => new Promise<string>(() => undefined),
  });
  return <output>{isPending ? LOADING : data}</output>;
}

function shell() {
  return (
    <QueryClientProvider client={client}>
      <QueryCacheScopeBinding />
      <Probe />
    </QueryClientProvider>
  );
}

/**
 * Land a completed org-A read the way a finished request would have, through
 * the binding rather than by setting the scope directly — so these cases fail if
 * the shell stops wiring the scope at all, not only if the fold breaks.
 */
function seedOrgARows() {
  render(shell());
  client.setQueryData(DOCUMENTS_LIST_KEY, ORG_A_ROWS);
  cleanup();
}

beforeEach(() => {
  authState.current = { userId: "user-1", orgId: "org-a" };
  client = makeQueryClient();
});

afterEach(() => {
  cleanup();
});

describe("web shell query cache scope binding", () => {
  it("still serves org A's rows to a surface remounting in org A", () => {
    // The positive control for every absence below, on the same locator and the
    // same seeding path: the probe does read this cache, so "loading" elsewhere
    // cannot be satisfied by a probe that never reads it.
    seedOrgARows();

    render(shell());

    expect(screen.getByRole("status")).toHaveTextContent(ORG_A_ROWS);
  });

  it("does not hand org A's rows to a surface mounting for the first time in org B", () => {
    // The paint-once shape: org A's entry is still resident (no clear has run)
    // and a page for org B renders against it.
    seedOrgARows();

    authState.current = { userId: "user-1", orgId: "org-b" };
    render(shell());

    expect(screen.getByRole("status")).toHaveTextContent(LOADING);
  });

  it("drops org A's rows from a mounted surface the moment the org flips", () => {
    seedOrgARows();
    const { rerender } = render(shell());
    expect(screen.getByRole("status")).toHaveTextContent(ORG_A_ROWS);

    authState.current = { userId: "user-1", orgId: "org-b" };
    rerender(shell());

    expect(screen.getByRole("status")).toHaveTextContent(LOADING);
  });

  it("does not hand a signed-in user's rows to the next account in the tab", () => {
    seedOrgARows();

    authState.current = { userId: "user-2", orgId: "org-a" };
    render(shell());

    expect(screen.getByRole("status")).toHaveTextContent(LOADING);
  });
});
