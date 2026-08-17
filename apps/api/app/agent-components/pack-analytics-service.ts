import "server-only";

import {
  AGENT_COMPONENT_INVENTORY_CAP,
  AgentComponentKind,
  isLocPerDollarVerifiableKind,
} from "@repo/api/src/types/agent-component";
import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
import { legacyKlocPerDollarFromLoc } from "@repo/api/src/utils/loc-per-dollar";
import { withDb } from "@repo/database";
import { displayUserName } from "@/lib/user-display-name";
import { computeCohortPerformance } from "./cohort-performance";
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
        computeTarget: {
          select: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
      // Deterministic order to match every other bounded query in this area.
      orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
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
    const locCost = await loadSessionLocCost(db, organizationId, sessionIds);
    const locPerDollar = locPerDollarForKind(
      AgentComponentKind.Plugin,
      sessionIds,
      locCost
    );

    // Comparison-based delivery metrics (success rate, token efficiency,
    // merged PRs, deltas vs. a bounded baseline, + hidden quality) over the
    // same pack cohort — the shared, bounded computation both surfaces use.
    const cohortMetrics = await computeCohortPerformance(
      db,
      organizationId,
      sessionIds
    );

    const ownerIds = new Set<string>();
    const owners: string[] = [];
    const deviceIds = new Set<string>();
    for (const row of inventory) {
      deviceIds.add(row.computeTargetId);
      const user = row.computeTarget?.user;
      if (user && !ownerIds.has(user.id)) {
        ownerIds.add(user.id);
        owners.push(displayUserName(user));
      }
    }

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
      deviceCount: deviceIds.size,
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
