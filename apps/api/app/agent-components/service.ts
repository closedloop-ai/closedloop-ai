import "server-only";

import type {
  AgentComponent,
  AgentComponentDetail,
  AgentComponentKind,
  AgentComponentListResponse,
  SourceOccurrence,
} from "@repo/api/src/types/agent-component";
import { shortFingerprint } from "@repo/api/src/types/agent-component-analytics";
import type { SourceOccurrenceListResponse } from "@repo/api/src/types/component-resolution";
import { emitLocPerDollarWithLegacy } from "@repo/api/src/utils/loc-per-dollar";
import { withDb } from "@repo/database";
import {
  getSourceOccurrences as registryGetSourceOccurrences,
  getSourceOccurrencesPage as registryGetSourceOccurrencesPage,
} from "../definition-registry/service";
import {
  authorsWithFallback,
  type Collaborator,
  collaboratorsOf,
  resolveCollaboratorsByDefinitionHash,
  resolveOwnerFallbackByUserId,
} from "./component-authors";
import {
  authorFingerprintsOf,
  collapseToCanonicalFamilies,
} from "./family-collapse";
import { resolveComponentHarness } from "./harness-attribution";
import {
  resolveMergedHonestSource,
  resolveMergedSource,
  resolveMergedSourceType,
} from "./identity";
import { sortAndPaginate } from "./list-sort";
import { loadLocCostForMerged, locPerDollarForKind } from "./loc-per-dollar";
import { buildOrgComponentPopulation } from "./org-population";
import { emitPackIdentity, type UsageWindow } from "./plugin-child-usage";
import { getDetailForOrg as getDetailForOrgRead } from "./service/detail-read";
import { ownerCompat } from "./service/owner-compat";
import type { AgentComponentListQuery } from "./validators";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The org-level identity slug codec (`${kind}::${normalizedKey}`) is the shared
// SSOT `encodeComponentSlug`/`decodeComponentSlug` in
// `@repo/api/src/types/agent-component-analytics`. This cloud consumer keys the
// same identity space the desktop encodes into, so it must use the SSOT rather
// than a local copy — otherwise the two drift silently (FEA-3039 / FEA-3117).
//
// ISS-4635: the inventory read, the version-bucket seeding, the FK-linked usage
// fold, the ORPHAN (null-FK) usage fold, the plugin child-usage rollup, the
// windowed zero-usage drop, and the `MAX_ORG_INVENTORY_ROWS` cap all live in
// `buildOrgComponentPopulation` (`./org-population`) — the ONE shared org
// population both this catalog list and the usage ranking leaderboard consume,
// so the two endpoints can never count a different population for the same org.

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const agentComponentsService = {
  /**
   * List org-level deduplicated agent components with aggregated org-wide usage.
   *
   * - Queries all `AgentComponent` rows for the org (via computeTarget.organizationId)
   * - Dedupes across compute targets by (componentKind, normalized componentKey/name)
   * - LEFT JOINs `AgentComponentSessionUsage` through `SessionDetail.organizationId`
   *   for org-scoped usage aggregation
   *
   * Usage (invocations/sessions) is sourced solely from
   * `AgentComponentSessionUsage`. hook/config-kind components have a thin/no
   * invocation signal and are intentionally NOT materialized into that table, so
   * they honestly report `invocations=0`/`sessions=0` here (empty usage is real
   * data, per the reconciled SSOT — the component still appears via the
   * inventory lane). There is deliberately no `AgentSessionEvent` on-read
   * derivation: events carry no reliable component-identity key to attribute a
   * hook/config invocation to, so any such derivation would be a fabricated
   * count. If the product later materializes hook/config usage, it must be
   * written into `AgentComponentSessionUsage` like every other kind.
   */
  listForOrg(
    organizationId: string,
    query: AgentComponentListQuery
  ): Promise<AgentComponentListResponse> {
    const {
      kinds,
      search,
      collaborator,
      source,
      harness,
      limit,
      offset,
      sortBy,
      sortDir,
      startDate,
      endDate,
    } = query;

    // FEA-3160 / FEA-3178: when a time window is requested, every USAGE lane is
    // scoped to `lastInvokedAt >= windowStart` (and `<= windowEnd` when the
    // upper bound is supplied) and components with zero in-window usage are
    // dropped. `startDate`/`endDate` are validated upstream as parseable date
    // strings (full ISO datetime OR bare `YYYY-MM-DD`, matching the sibling
    // agent-sessions endpoint); `new Date` handles both. Parse them once. Both
    // absent ⇒ all-time inventory view, byte-identical to before. `endDate` is
    // paired with `startDate` to fetch the PRECEDING equivalent window for the
    // period-over-period delta on the summary cards.
    const window: UsageWindow = {
      start: startDate ? new Date(startDate) : undefined,
      end: endDate ? new Date(endDate) : undefined,
    };

    return withDb(async (db) => {
      // ISS-4635: ONE shared org population. The inventory read, the version
      // bucket seeding, the FK-linked usage fold, the ORPHAN (null-FK) usage
      // fold, the plugin child-usage rollup, and the windowed zero-usage drop
      // all live in `buildOrgComponentPopulation`, which the ranking
      // leaderboard calls too — so the two endpoints can never again count a
      // different population or a different usage total for the same org.
      const mergedMap = await buildOrgComponentPopulation(db, {
        organizationId,
        kinds,
        search,
        window,
      });

      // 2d. Load per-session local-git LOC + cost for every session referenced
      // by the merged set, so the DTO can carry a real LOC/$ efficiency metric
      // (FEA-2923 follow-up; ISS-4667 unit reconciliation). Sourced from
      // `SessionDetail` (lines_added + lines_removed, estimated_cost) — the
      // desktop's local-git enrichment, available BEFORE any GitHub connection
      // (LOC/$ is never gated on GitHub).
      const locCostBySession = await loadLocCostForMerged(
        db,
        organizationId,
        mergedMap
      );

      // 2e. FEA-4098 (Slice 3): resolve the AUTHORS people-set (discoverer +
      // editors) from the `DefinitionVersionEditor` lineage, keyed by each
      // bucket's `versionFingerprint` (its `definitionHash` when linked). Buckets
      // keyed on a coarse `contentHash` (unlinked/legacy) resolve to no lineage →
      // an empty authors set (skew-safe). Replaces the former inventory-provenance
      // `owner`/`collaborators` (compute-target user).
      //
      // wongk (N+1 / working-set): the lineage read is only resolved over the
      // WHOLE ~5k working set when a `?collaborator=` filter is active (the filter
      // must see every entry's authors to include/exclude it). With no such
      // filter, the read is deferred until AFTER sort+paginate and scoped to just
      // the requested page's fingerprints (see step 4b), so a limit-50 request
      // reads lineage for 50 rows, not 5000.
      let collaboratorsByHash = new Map<string, Collaborator[]>();
      // wongk (FEA-4247): the `?collaborator=` filter must match the SAME
      // people-set the row DISPLAYS — lineage authors, else the owner fallback.
      // Filtering on `collaboratorsOf` (lineage only) let a fallback-only row
      // show "Alice" yet vanish when the user filtered for Alice, and undercounted
      // the filtered `total`. When the facet is active we resolve the owner
      // fallback over the whole working set here (bounded `IN` query) and reuse it
      // for the page below, so filter and display agree.
      let ownerNameByUserId = new Map<string, string>();

      // 3. FEA-4267: collapse the version-keyed merge map into ONE canonical row
      // per component FAMILY (the org-level `slug`) BEFORE filtering, sorting, and
      // paginating — so the catalog shows one row per logical component (the
      // `cl-produce` skill is one row, not five), the COMPONENTS `total` counts
      // canonical families, and pagination pages over families. All three (row
      // list, count, aggregates) come from this ONE grouping pass so they cannot
      // drift. Per-version data stays on the detail page; usage/provenance
      // aggregate across the family's versions and a multi-version family carries
      // every version's fingerprint in `familyFingerprints` so its authors union
      // across the whole family. (`applyPluginChildUsageRollup` above already
      // mutated `mergedMap` in place, so plugin attribution flows into the
      // collapsed rows.)
      let entries = collapseToCanonicalFamilies(mergedMap);
      // Apply collaborators + source filters (post-collapse).
      if (collaborator) {
        collaboratorsByHash = await resolveCollaboratorsByDefinitionHash(
          db,
          organizationId,
          entries.flatMap(authorFingerprintsOf)
        );
        ownerNameByUserId = await resolveOwnerFallbackByUserId(
          db,
          organizationId,
          entries.flatMap((e) => e.computeTargetUserIds)
        );
        const collaboratorLower = collaborator.toLowerCase();
        entries = entries.filter((e) =>
          authorsWithFallback(
            collaboratorsOf(e, collaboratorsByHash),
            e.computeTargetUserIds,
            ownerNameByUserId
          ).some((n) => n.toLowerCase().includes(collaboratorLower))
        );
      }
      // FEA-3249: `source` was declared by the validator and honored by the
      // desktop reader but silently dropped here, so the same `?source=` query
      // returned a filtered list on desktop and an unfiltered one on web. This
      // restores the filter TECHNIQUE parity — exact equality against the label
      // each surface derives + shows, so `?source=` can never match a value the
      // client was never shown. FEA-4335 (shafty023): the emitted `source` is now
      // the pack-first `resolveMergedSource` (a Pack row shows its pack id, not
      // the repo URL `displaySource` returns), so the filter MUST compare against
      // that same derived value or a `?source=<packId>` on a shown Pack row would
      // match nothing. Applied before `sortAndPaginate` so `total`/`hasMore` count
      // the filtered set.
      if (source) {
        entries = entries.filter((e) => resolveMergedSource(e) === source);
      }
      // FEA-3758: filter on the DISPLAYED harness (derived from the sessions the
      // component ran in) rather than the raw inventory-row harness, so
      // `?harness=codex` returns exactly the components shown as `codex` — a
      // subagent whose inventory row is harness-less but ran only in Codex is
      // included, and one whose inventory says `claude` but ran only in Codex is
      // not excluded. Applied post-fold (like owner/source) so `total` counts the
      // filtered set. `both` is matched by an explicit `?harness=both`.
      if (harness) {
        entries = entries.filter(
          (e) =>
            resolveComponentHarness(e.usageHarnesses, e.harness) === harness
        );
      }

      // 4. Sort and paginate
      const { page, total } = sortAndPaginate(
        entries,
        sortBy,
        sortDir,
        limit,
        offset,
        // ISS-4944: `sortBy=metric` orders on the same LOC/$ the response emits,
        // so the sorter needs the per-session LOC/cost loaded in step 2d.
        locCostBySession
      );

      // 4b. wongk (N+1 / working-set): when no `?collaborator=` filter forced the
      // full-set resolve above, resolve the authors lineage only now, scoped to
      // the fingerprints on the RETURNED page — so the lineage read scales with
      // the response limit (e.g. 50 rows), not the ~5k working set.
      if (!collaborator) {
        collaboratorsByHash = await resolveCollaboratorsByDefinitionHash(
          db,
          organizationId,
          page.flatMap(authorFingerprintsOf)
        );
      }

      // 4c. FEA-4247: resolve the read-time owner FALLBACK for the returned page
      // — the display names of the compute-target users that observed each row —
      // in one bounded query over the page's deduped user ids. Used only for rows
      // whose lineage authors set is empty (the FEA-4098 regression that blanked
      // Owner); lineage always wins. Scoped to the page, not the working set —
      // unless the `?collaborator=` filter already resolved it over the working
      // set above (to keep filter and display in agreement), in which case that
      // map already covers the page and is reused rather than re-queried.
      if (!collaborator) {
        ownerNameByUserId = await resolveOwnerFallbackByUserId(
          db,
          organizationId,
          page.flatMap((e) => e.computeTargetUserIds)
        );
      }

      // 5. Map to response shape
      const items: AgentComponent[] = page.map((e) => {
        // FEA-4247: lineage authors when present, else the observing compute-
        // target owner(s) — restoring Owner for legacy/unlinked rows without a
        // backfill. Computed once so `collaborators` and the `owner` compat alias
        // stay consistent.
        const authors = authorsWithFallback(
          collaboratorsOf(e, collaboratorsByHash),
          e.computeTargetUserIds,
          ownerNameByUserId
        );
        return {
          id: e.id,
          // FEA-4335: the emitted `slug` is the content-hash routable key
          // (`${kind}::${fingerprint}`, or the name-level slug when the row has
          // no captured fingerprint), NOT the name-level family key. Two
          // materially-different components that normalize to the same name emit
          // DISTINCT slugs, so their detail URIs no longer collide; byte-identical
          // installs (any name/path) share one. Old name-level links still resolve
          // via the detail route's name fallback.
          slug: e.routableKey,
          name: e.name ?? e.key,
          kind: e.kind as AgentComponentKind,
          // FEA-4374: resolve Server/Pack from the merged identity's provenance
          // (a folded `packId` ⇒ Pack) instead of hardcoding Repo, so a
          // pack-sourced list row is correctly installable; non-pack rows keep
          // the prior Repo default (this resolver deliberately ignores the
          // scope/projectPath the fold now carries — see `honestSource` below).
          sourceType: resolveMergedSourceType(e),
          // FEA-4374: pack-first `source` (mirrors the desktop reader) so a
          // Pack row's Install `normalizePackId(source)` resolves the right pack.
          source: resolveMergedSource(e),
          // ISS-5009: the honest projection, additive beside the two untouched
          // legacy fields above. Says whether `source` is real provenance or the
          // component's own identity key echoed back, so a gated consumer can
          // render an empty Source instead of repeating the Component column.
          honestSource: resolveMergedHonestSource(e),
          // FEA-3758: harness reflects the sessions the component actually ran in
          // (folded from its usage rows), falling back to the inventory harness
          // only when no usage carried one. Fixes subagents (used-only, harness-
          // less inventory row) defaulting to `claude`.
          harness: resolveComponentHarness(e.usageHarnesses, e.harness),
          invocations: e.totalInvocations,
          sessions: e.sessionIds.size,
          ...emitLocPerDollarWithLegacy(
            locPerDollarForKind(e.kind, e.sessionIds, locCostBySession)
          ),
          trend: [],
          // FEA-4098 (Slice 3) + FEA-4247: the authors people-set — the version's
          // `DefinitionVersionEditor` lineage (discoverer + editors) when present,
          // else the observing compute-target owner fallback (FEA-4247) so a
          // legacy/unlinked row shows Owner instead of a blank. `owner` is the
          // additive skew-compat alias (leading author), omitted when empty.
          collaborators: authors,
          ...ownerCompat(authors),
          // ISS-5534 (wongk review): the parent-pack identity, additive and
          // optional. On a plugin row it is the SAME candidate set its rollup
          // summed over, so a consumer can drop a plugin's rolled-up total only
          // when THAT plugin's own children are also in view — instead of
          // zeroing every plugin the moment any child-kind row appears.
          ...emitPackIdentity(e),
          computeTargetIds: e.computeTargetIds,
          // ISS-5577 (wongk review): parity with the detail producers. Both
          // columns are nullable, and substituting the request clock made a row
          // that recorded no observation time claim it was first seen the
          // instant the page loaded — which also lit `isNewlyDiscovered`'s
          // "New" dot on every such row, since an age of ~0ms is inside the
          // 7-day window. `""` is the honest-absent sentinel the whole read
          // surface already emits and every consumer already treats as unknown.
          firstSeenAt: e.firstSeenAt?.toISOString() ?? "",
          lastSeenAt: e.lastSeenAt?.toISOString() ?? "",
          // FEA-3982 (Slice 2): the exact-version fingerprint + short badge. Both
          // omitted (never null) for a hash-less legacy/event-minted row so
          // absence stays skew-safe "unversioned / name-only" on the wire. A
          // multi-version FAMILY row (FEA-4267) reports no single fingerprint, so
          // it omits the badge and instead carries `versionCount` below.
          ...(e.versionFingerprint
            ? {
                versionId: e.versionFingerprint,
                fingerprint:
                  shortFingerprint(e.versionFingerprint) ?? undefined,
              }
            : {}),
          // FEA-4267: the number of distinct version buckets collapsed into this
          // canonical family row. Emitted additively only when the family
          // collapsed MORE THAN ONE version, so the catalog can surface the quiet
          // "N versions" muted signal; omitted (never 1, never null) for a
          // single-version component so absence stays skew-safe on the wire.
          ...(e.versionCount && e.versionCount > 1
            ? { versionCount: e.versionCount }
            : {}),
          // Real last-invocation time (max usage lastInvokedAt); omitted when the
          // component has no usage rows. Consumers key "recently active" off this,
          // never `lastSeenAt` (FEA-3179).
          ...(e.lastInvokedAt
            ? { lastInvokedAt: e.lastInvokedAt.toISOString() }
            : {}),
        };
      });

      return {
        items,
        total,
        hasMore: offset + limit < total,
      };
    });
  },

  /**
   * Fetch full detail for one component by its org-level identity slug.
   * Slug format: `${componentKind}::${normalizedKey}` (URL-encoded on the wire).
   *
   * Returns null when no inventory rows match.
   */
  getDetailForOrg(
    organizationId: string,
    slug: string
  ): Promise<AgentComponentDetail | null> {
    return getDetailForOrgRead(organizationId, slug);
  },

  /**
   * F1 (FEA-3290 / PRD-527, Slice 6 · AC-019/AC-5): the provenance occurrences
   * ("where was this exact version seen") for one `DefinitionVersion`, org-scoped.
   *
   * Delegates to the definition-registry read, which filters on BOTH the caller's
   * `organizationId` AND the `definitionVersionId` — so a caller can NEVER read
   * another org's occurrences even with a leaked foreign version id (the org
   * filter simply excludes it, returning `[]`). Occurrences carry provenance
   * only — never a definition body — and preserve each occurrence's `accessState`
   * so an `inaccessible` provenance is surfaced as itself, never collapsed into
   * "missing" (AC-5).
   */
  getSourceOccurrencesForOrg(
    organizationId: string,
    definitionVersionId: string
  ): Promise<SourceOccurrence[]> {
    return withDb((db) =>
      registryGetSourceOccurrences(db, organizationId, definitionVersionId)
    );
  },

  /**
   * FEA-3704: the PAGINATED, org-scoped provenance read behind
   * `GET /agent-components/source-occurrences`. Thin wrapper — the org-scoping,
   * counting, and paging all live in the definition-registry service
   * (`getSourceOccurrencesPage`), which filters on BOTH `organizationId` AND
   * `definitionVersionId` so a leaked foreign version id yields an empty page and
   * `total = 0` (never a cross-org leak). Returns the shared
   * {@link SourceOccurrenceListResponse} shape (items + total + hasMore) both
   * surfaces consume.
   */
  async getSourceOccurrencePageForOrg(
    organizationId: string,
    definitionVersionId: string,
    offset: number,
    limit: number
  ): Promise<SourceOccurrenceListResponse> {
    const { items, total } = await withDb((db) =>
      registryGetSourceOccurrencesPage(
        db,
        organizationId,
        definitionVersionId,
        offset,
        limit
      )
    );
    return { items, total, hasMore: offset + items.length < total };
  },
};
