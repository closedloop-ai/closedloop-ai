/**
 * Tenant cache-identity contract for the shared query client (ISS-7442).
 *
 * These assert CACHE BEHAVIOR, never a key string: a key string proves someone
 * typed a segment, not that one organization's entry is unreachable from
 * another's. Every case below drives a real `QueryClient` and asserts on
 * whether the read hit or fetched. Nothing here calls `refetch()`, which forces
 * a request past the cache and would report a hit as a miss.
 */

import { describe, expect, it, vi } from "vitest";
import { queryCacheScopeOf } from "../query-cache-scope";
import {
  DEFAULT_QUERY_STALE_TIME_MS,
  makeQueryClient,
  setQueryCacheScope,
} from "../query-client";

const ORG_A = queryCacheScopeOf("user-1", "org-a");
const ORG_B = queryCacheScopeOf("user-1", "org-b");

// A family this change never touched, written out here rather than imported
// from a key factory: the point is that a family gets isolation without its
// factory participating, so deriving the fixture from a factory would hide
// exactly the property under test.
const DOCUMENTS_LIST_KEY = ["documents", "list", { status: "draft" }] as const;

/**
 * A cache-respecting read: `fetchQuery` serves a fresh entry without calling
 * `queryFn`, and only reaches `queryFn` on a miss. That difference is the whole
 * assertion, so it must not be replaced with `refetch()`.
 */
function read(
  client: ReturnType<typeof makeQueryClient>,
  queryKey: readonly unknown[],
  queryFn: () => Promise<string>
) {
  return client.fetchQuery({
    queryKey,
    queryFn,
    staleTime: DEFAULT_QUERY_STALE_TIME_MS,
  });
}

describe("queryCacheScopeOf", () => {
  it("leaves the cache unscoped when there is no resolved user", () => {
    expect(queryCacheScopeOf(null, "org-a")).toBeNull();
    expect(queryCacheScopeOf(undefined, undefined)).toBeNull();
  });
});

describe("cross-organization cache identity", () => {
  it("does not let an org-A entry satisfy an org-B read of the same family", () => {
    const client = makeQueryClient();

    setQueryCacheScope(client, ORG_A);
    client.setQueryData(DOCUMENTS_LIST_KEY, "org-a-documents");

    setQueryCacheScope(client, ORG_B);
    expect(client.getQueryData(DOCUMENTS_LIST_KEY)).toBeUndefined();

    // The positive sibling: returning to org A must find the entry again, so
    // "undefined in org B" cannot be satisfied by a write that never landed.
    setQueryCacheScope(client, ORG_A);
    expect(client.getQueryData(DOCUMENTS_LIST_KEY)).toBe("org-a-documents");
  });

  it("issues a request in org B where org A is served from cache", async () => {
    const client = makeQueryClient();
    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("fetched-rows");

    setQueryCacheScope(client, ORG_A);
    client.setQueryData(DOCUMENTS_LIST_KEY, "org-a-rows");

    // Org A HITS: the seeded entry is fresh, so the read never reaches the
    // network. Asserted first so the org-B leg cannot be satisfied by a client
    // that simply always fetches.
    await expect(read(client, DOCUMENTS_LIST_KEY, queryFn)).resolves.toBe(
      "org-a-rows"
    );
    expect(queryFn).not.toHaveBeenCalled();

    // Org B MISSES, so the same read reaches the network — which is what gives
    // the server its chance to scope the response.
    setQueryCacheScope(client, ORG_B);
    await expect(read(client, DOCUMENTS_LIST_KEY, queryFn)).resolves.toBe(
      "fetched-rows"
    );
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("does not let one user's entry satisfy another user's read in the same org", () => {
    const client = makeQueryClient();

    setQueryCacheScope(client, queryCacheScopeOf("user-1", "org-a"));
    client.setQueryData(DOCUMENTS_LIST_KEY, "user-1-documents");

    setQueryCacheScope(client, queryCacheScopeOf("user-2", "org-a"));
    expect(client.getQueryData(DOCUMENTS_LIST_KEY)).toBeUndefined();

    setQueryCacheScope(client, queryCacheScopeOf("user-1", "org-a"));
    expect(client.getQueryData(DOCUMENTS_LIST_KEY)).toBe("user-1-documents");
  });

  it("isolates a brand-new family whose key factory was never folded", () => {
    // The counterfactual for "a new org-scoped family added without the fold":
    // this family does not exist in the app and nothing in the diff mentions
    // it, yet it is isolated, because isolation is applied at the cache rather
    // than per factory.
    const newFamilyKey = ["widgets", "list", { ownerId: "team-9" }] as const;
    const client = makeQueryClient();

    setQueryCacheScope(client, ORG_A);
    client.setQueryData(newFamilyKey, "org-a-widgets");

    setQueryCacheScope(client, ORG_B);
    expect(client.getQueryData(newFamilyKey)).toBeUndefined();

    setQueryCacheScope(client, ORG_A);
    expect(client.getQueryData(newFamilyKey)).toBe("org-a-widgets");
  });

  it("keeps unscoped prefix invalidation reaching a scoped entry", async () => {
    const client = makeQueryClient();
    const queryFn = vi
      .fn<() => Promise<string>>()
      .mockResolvedValue("fresh-rows");

    setQueryCacheScope(client, ORG_A);
    await read(client, DOCUMENTS_LIST_KEY, queryFn);

    // Invalidation matches on the query KEY, which the fold leaves untouched.
    // Folding into the key array instead would make every `invalidateQueries`
    // prefix in the app silently miss its own entries.
    await client.invalidateQueries({ queryKey: ["documents", "list"] });
    expect(client.getQueryState(DOCUMENTS_LIST_KEY)?.isInvalidated).toBe(true);
  });

  it("keeps an exact filter reaching a scoped entry", async () => {
    const client = makeQueryClient();

    setQueryCacheScope(client, ORG_A);
    client.setQueryData(DOCUMENTS_LIST_KEY, "org-a-rows");

    // React Query resolves `exact: true` by RECOMPUTING the hash from the key
    // and comparing it to the stored one, so a fold applied by overwriting
    // `queryHash` after the fact makes the two disagree forever and turns every
    // exact `cancelQueries`/`invalidateQueries`/`find` into a silent no-op —
    // including `useCancelAgentSessionsPageData`, whose own docstring warns it
    // "would silently cancel nothing". Hashing from the key keeps them equal.
    expect(
      client.getQueryCache().find({ queryKey: DOCUMENTS_LIST_KEY })
    ).toBeDefined();

    await client.invalidateQueries({
      queryKey: DOCUMENTS_LIST_KEY,
      exact: true,
    });
    expect(client.getQueryState(DOCUMENTS_LIST_KEY)?.isInvalidated).toBe(true);
  });

  it("does not share the pre-identity slot between two identities", () => {
    const client = makeQueryClient();

    // A query mounted before the shell's identity hydrates still RESOLVES with
    // real data — `useApiClient` awaits auth inside the request rather than
    // gating the query — and `CollaborationProviderWrapper` mounts two such
    // reads (`["users","current"]`, the org member list) above every gate. So
    // the pre-identity slot holds one identity's rows, and it must not be the
    // same slot the next identity reads during its own pre-identity window.
    setQueryCacheScope(client, null);
    client.setQueryData(DOCUMENTS_LIST_KEY, "user-1-rows");

    setQueryCacheScope(client, ORG_A);
    setQueryCacheScope(client, null);

    expect(client.getQueryData(DOCUMENTS_LIST_KEY)).toBeUndefined();
  });

  it("keeps one pre-identity window reading its own writes", () => {
    const client = makeQueryClient();

    // The counterweight to the case above: a fresh slot per RENDER rather than
    // per identity transition would mean no pre-identity read could ever hit
    // its own write, turning every first paint into a permanent miss.
    setQueryCacheScope(client, null);
    client.setQueryData(DOCUMENTS_LIST_KEY, "pre-identity-rows");
    setQueryCacheScope(client, null);

    expect(client.getQueryData(DOCUMENTS_LIST_KEY)).toBe("pre-identity-rows");
  });

  it("stops serving an organization's entries once the identity is dropped", () => {
    const client = makeQueryClient();

    setQueryCacheScope(client, ORG_A);
    client.setQueryData(DOCUMENTS_LIST_KEY, "org-a-documents");

    // Signing out clears the identity. Treating `null` as "leave the previous
    // scope in place" would keep the signed-out shell reading the last
    // organization's cache.
    setQueryCacheScope(client, null);
    expect(client.getQueryData(DOCUMENTS_LIST_KEY)).toBeUndefined();
  });
});
