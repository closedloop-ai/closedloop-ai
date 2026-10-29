import "server-only";

import {
  AGENT_COMPONENT_INVENTORY_CAP,
  AgentComponentKind,
  isLocPerDollarVerifiableKind,
} from "@repo/api/src/types/agent-component";
import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
import { legacyKlocPerDollarFromLoc } from "@repo/api/src/utils/loc-per-dollar";
import { Prisma, withDb } from "@repo/database";
import { computeCohortPerformance } from "./cohort-performance";
import {
  namesForUserIds,
  resolveOwnerFallbackByUserId,
} from "./component-authors";
import { installerUserIdsOf } from "./installer-roster";
import { loadSessionLocCost, locPerDollarForKind } from "./loc-per-dollar";
import { loadChildUsageByPackId } from "./plugin-child-usage";

// ---------------------------------------------------------------------------
// Pack analytics (desktop-team overlay)
//
// Extracted from `service.ts` (FEA-4144 review, root AGENTS.md shrink-only
// rule): the per-pack org-wide rollup is a cohesive, single-responsibility
// surface, so it lives here rather than growing the ~3,200-line service.
// ---------------------------------------------------------------------------

// Bounded like every other inventory read: a pack distributed to thousands of
// devices would otherwise return one row per install. Shares the same
// `AGENT_COMPONENT_INVENTORY_CAP` as the org inventory reads in `service.ts`.
const MAX_PACK_INVENTORY_ROWS = AGENT_COMPONENT_INVENTORY_CAP;

/**
 * Per-pack org-wide analytics rollup for the desktop-team overlay: usage +
 * sessions + LOC/$ over the pack's child components, plus owner/device
 * adoption. Joined to the desktop's local pack by the shared `packId`. Returns
 * null when the org has neither usage nor inventory for the pack.
 */
function getPackAnalytics(
  organizationId: string,
  packId: string
): Promise<PackAnalyticsResponse | null> {
  return withDb(async (db) => {
    const byPack = await loadChildUsageByPackId(db, [packId], organizationId);
    const bucket = byPack.get(packId);

    const inventory = await db.agentComponent.findMany({
      // ISS-6180: the same live-inventory scope the child-usage rollup above now
      // applies, so the two halves of this response describe the same install
      // population. Without it a pack uninstalled everywhere reports zero
      // invocations beside a nonzero device/owner count.
      where: { organizationId, packId, uninstalledAt: null },
      select: {
        computeTargetId: true,
        computeTarget: { select: { userId: true } },
      },
      // Deterministic order to match every other bounded query in this area.
      // `lastSeenAt` is nullable and PostgreSQL sorts nulls FIRST on a
      // descending sort, so without `nulls: "last"` a legacy row that never
      // recorded one would lead the roster ahead of genuinely recent installs.
      orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      take: MAX_PACK_INVENTORY_ROWS,
    });

    if (!bucket && inventory.length === 0) {
      return null;
    }

    const sessionIds = bucket ? [...bucket.sessionIds] : [];
    // FEA-4144: a pack is the `Plugin` kind, whose rolled-up child usage carries
    // no per-component attribution, so it is NOT LOC/$-verifiable (`Plugin` is
    // not in `LOC_PER_DOLLAR_VERIFIABLE_KINDS`). BOTH LOC-efficiency signals the overlay
    // would otherwise surface — the headline `locPerDollar` AND the `locDelta`
    // vs. the baseline — are that same session-level (misattributed) number the
    // pack's own inventory + detail rows hide, so the SAME verifiability gate
    // must null both. Keeping the LOC/cost load makes this forward-compatible:
    // if `Plugin` is ever marked verifiable, both light up from already-loaded
    // data with no further change here.
    const locVerifiable = isLocPerDollarVerifiableKind(
      AgentComponentKind.Plugin
    );
    // Comparison-based delivery metrics (success rate, token efficiency,
    // merged PRs, deltas vs. a bounded baseline, + hidden quality) over the
    // same pack cohort — the shared, bounded computation both surfaces use.
    // ISS-9114 batches it with the independent LOC/cost load; the two stay
    // separate reads for the reasons spelled out at the sibling call site in
    // `service/detail-read.ts`.
    const [locCost, cohortMetrics] = await Promise.all([
      loadSessionLocCost(db, organizationId, sessionIds),
      // ISS-9853: `loadChildUsageByPackId` carries no `take` (ISS-6891), so
      // this id set IS the pack's cohort, not a sample of it.
      computeCohortPerformance(db, organizationId, sessionIds, {
        cohortSampled: false,
      }),
    ]);
    const locPerDollar = locPerDollarForKind(
      AgentComponentKind.Plugin,
      sessionIds,
      locCost
    );

    // ISS-6768: the shared roster fold — the component detail read emits the
    // SAME set as `AgentComponentDetail.installers`, so the web Packs detail and
    // this desktop overlay answer "Used by" from one producer. Names resolve
    // through the org-scoped `User` read rather than a nested
    // `computeTarget.user` join, which would surface whatever user a stale
    // cross-org target link points at.
    const ownerUserIds = installerUserIdsOf(inventory);
    const owners = namesForUserIds(
      ownerUserIds,
      await resolveOwnerFallbackByUserId(db, organizationId, ownerUserIds)
    );

    // ISS-9854: exact counts from a rowless aggregate so adoption metrics are
    // not bounded by MAX_PACK_INVENTORY_ROWS. The cloud-authored sentinel
    // exclusion mirrors `isCloudAuthoredRow` (identity.ts:778). Installers are
    // counted through the org-scoped `users` join for the same reason `owners`
    // resolves through `resolveOwnerFallbackByUserId`: `ComputeTarget` carries
    // its own org foreign key, so a stale cross-org target link would otherwise
    // count a user this tenant cannot see and report more installers than the
    // roster names.
    type PackInstallAggregate = {
      deviceCount: number;
      installerCount: number;
    };
    const [aggregate] = await db.$queryRaw<PackInstallAggregate[]>(Prisma.sql`
      SELECT
        COUNT(DISTINCT ac."compute_target_id")::int AS "deviceCount",
        COUNT(DISTINCT CASE
          WHEN NOT (ac."metadata" IS NOT NULL
                    AND ac."metadata" @> '{"cloudAuthored":true}'::jsonb)
          THEN u."id"
        END)::int AS "installerCount"
      FROM "agent_components" ac
      JOIN "compute_targets" ct ON ct."id" = ac."compute_target_id"
      LEFT JOIN "users" u
        ON u."id" = ct."user_id"
       AND u."organization_id" = ${organizationId}::uuid
      WHERE ac."organization_id" = ${organizationId}::uuid
        AND ac."pack_id" = ${packId}
        AND ac."uninstalled_at" IS NULL
    `);

    // ISS-4667 version skew (emit side): the cloud deploys ahead of the Desktop
    // builds installed on people's machines. A pre-ISS-4667 desktop's
    // `packAnalyticsSchema` REQUIRED `klocPerDollar`, so if the cloud omits it the
    // whole pack-analytics overlay blanks (its Zod parse fails and the reader
    // returns its null sentinel) — not just this metric. Keep emitting the
    // renamed fields as compatibility aliases until a human approves removing the
    // shim (AGENTS.md Cross-Repo Compatibility). `klocPerDollar` is LOC/$ ÷ 1000;
    // `klocDelta` is a unit-free percentage lift, so it carries the SAME number as
    // `locDelta` (no scaling). Both stay `null` when the canonical value is null.
    const emittedLocDelta = locVerifiable ? cohortMetrics.locDelta : null;
    return {
      packId,
      invocations: bucket?.invocations ?? 0,
      sessions: bucket?.sessionIds.size ?? 0,
      locPerDollar,
      klocPerDollar: legacyKlocPerDollarFromLoc(locPerDollar),
      owners,
      deviceCount: aggregate?.deviceCount ?? 0,
      installerCount: aggregate?.installerCount ?? 0,
      ...cohortMetrics,
      // FEA-4144: override the spread `locDelta`. The LOC/$ delta is the same
      // unverifiable Plugin signal as the gated headline, and the overlay
      // (`pack-detail.tsx`) renders the delta even when the headline is hidden,
      // so a pack with a baseline must not expose it. Placed AFTER the spread so
      // it always wins.
      locDelta: emittedLocDelta,
      klocDelta: emittedLocDelta,
    };
  });
}

export const packAnalyticsService = {
  getPackAnalytics,
};
