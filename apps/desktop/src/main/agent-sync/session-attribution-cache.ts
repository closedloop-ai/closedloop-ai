/**
 * @file session-attribution-cache.ts
 * @description ISS-8611 — the bounded {@link SessionAttributionResolverCache}
 * for owners that OUTLIVE one request.
 *
 * Deliberately its OWN module rather than a function beside the type in
 * `agent-session-attribution.ts`, for the same reason `lifecycle/migration-refusal.ts`
 * sits outside `database/`: `AgentSessionSyncService` is on the boot graph, and
 * `agent-session-attribution.ts` reaches `attribution-path-memo.ts` and through
 * it `database/db-host/`, which `scripts/dependency-cruiser.config.cjs`'s
 * `boot-no-design-system-runtime` rule forbids a boot file from reaching. The
 * service already held the cache TYPE, which that gate drops
 * (`tsPreCompilationDeps: false`); a VALUE import of a factory declared there
 * would have promoted the same edge into the graph and failed the gate. Keeping
 * the factory in a leaf whose only value import is `BoundedMap` — which imports
 * nothing — lets both the boot-graph service and the db-host importer construct
 * one.
 */
import { BoundedMap } from "@repo/lib/bounded-map";
import type { SessionAttributionResolverCache } from "./agent-session-attribution.js";

/**
 * Entry cap for each map of a LONG-LIVED {@link SessionAttributionResolverCache}
 * (ISS-8611).
 *
 * Sized from the same reference corpus as `ATTRIBUTION_MEMO_MAX_ENTRIES` — 4,336
 * sessions over 1,238 distinct cwds — so a real install never evicts, and kept a
 * separate knob because the two caches are tuned for different things: that one
 * bounds a process-wide git-remote memo shared by every consumer, this one
 * bounds one owner's per-cwd attribution memo.
 *
 * Eviction here degrades to a re-resolve on the next miss, never to a wrong
 * answer — for THE RESOLVER FAMILY, which is what the two owners below use:
 * `resolveSessionAttribution`, `resolveSessionAttributionWithSourceAsync`, and
 * the revalidation write in `sync-attribution-resolution.ts`. Within that family
 * an entry is a re-derivation of the path it is keyed by, so an eviction costs
 * one re-resolve.
 *
 * It is NOT true of `attributionByCwd` in general, and the difference matters
 * because it decides which owners may be handed one of these (marisolashgrove,
 * PR #6771). The existence-probe writers — `database/repository-facet.ts` and
 * `database/session-usage-aggregate.ts` — write a `null` SENTINEL for a cwd that
 * is gone, where the resolvers write a TRUTHY attribution for that same key:
 * `buildAttribution` keeps any record whose fields are not all falsy, and
 * `worktreePath` is the non-empty cwd, so a cwd that does not exist still
 * resolves. Two writers, two answers for one key. Evicting a sentinel therefore
 * FLIPS an answer rather than costing a re-resolve. Those two callers are handed
 * per-request plain `Map`s and are safe today; do not hand either one a cache
 * from this factory without first reconciling the two writers.
 *
 * The write-through property the async resolver relies on (one cwd cannot split
 * into two repo identities inside one fold) survives at this cap for the same
 * reason it survives `clearSourceDerivedState`'s existing mid-life clear — a fold
 * is orders of magnitude narrower than 4,096 distinct paths.
 */
export const SESSION_ATTRIBUTION_CACHE_MAX_ENTRIES = 4096;

/**
 * Build an attribution cache for an owner that OUTLIVES one request — the sync
 * service's per-identity cache and the SQLite importer's per-database cache.
 *
 * Per-request callers keep plain `Map`s: a cache that dies with its request is
 * already bounded by that request, and capping one would buy nothing while
 * putting an eviction inside a single fold.
 */
export function createLongLivedSessionAttributionCache(): SessionAttributionResolverCache {
  return {
    attributionByCwd: new BoundedMap(SESSION_ATTRIBUTION_CACHE_MAX_ENTRIES),
    launchMetadataRootByCwd: new BoundedMap(
      SESSION_ATTRIBUTION_CACHE_MAX_ENTRIES
    ),
    repoFullNameByPath: new BoundedMap(SESSION_ATTRIBUTION_CACHE_MAX_ENTRIES),
  };
}
