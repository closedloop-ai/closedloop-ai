/**
 * Maps the cloud `CatalogItemDto` / `DistributionDto` onto the shared `PackView`
 * the unified Packs UX renders on the web-admin surface. Team-usage and
 * performance blocks are layered on separately by their dedicated hooks; this
 * mapper covers the catalog identity + admin distribution state.
 */

import {
  type CatalogItemDto,
  CatalogItemSource,
  type DistributionDto,
} from "@repo/api/src/types/distribution";
import {
  type PackContentEntry,
  type PackDistribution,
  type PackDistributionTarget,
  type PackView,
  toPackContentKind,
} from "./pack-view";

const INSTALLED_STATUSES = new Set(["installed", "enabled"]);
const PENDING_STATUSES = new Set(["pending", "opted_in"]);

/** Fold a distribution's per-target rows into the admin distribution summary. */
export function distributionToPackDistribution(
  dist: DistributionDto
): PackDistribution {
  const targets: PackDistributionTarget[] = dist.targetStatuses.map(
    (status) => ({
      id: status.id,
      computeTargetId: status.computeTargetId,
      computeTargetName: status.computeTargetId,
      status: status.status,
      installedVersion: status.installedVersion,
      failureReason: status.failureReason,
    })
  );

  const installedCount = targets.filter((t) =>
    INSTALLED_STATUSES.has(t.status)
  ).length;
  const pendingCount = targets.filter((t) =>
    PENDING_STATUSES.has(t.status)
  ).length;
  const failedCount = targets.filter((t) => t.status === "failed").length;

  return {
    id: dist.id,
    mode: dist.mode,
    targetingType: dist.targetingType,
    desiredEnabled: dist.desiredEnabled,
    targetCount: Math.max(dist.targetingEntries.length, targets.length),
    installedCount,
    pendingCount,
    failedCount,
    targets: targets.length > 0 ? targets : undefined,
  };
}

/**
 * Build a `PackView` from a catalog item + its (optional) distribution.
 *
 * Until the curated-metadata fields land on `CatalogItem` (publisher / stars /
 * verified / harnesses / githubUrl), these are derived from the item's source:
 * curated items read as ClosedLoop-published and verified.
 */
export function catalogItemToPackView(
  item: CatalogItemDto,
  distribution?: DistributionDto | null
): PackView {
  const curated = item.source === CatalogItemSource.Curated;
  return {
    id: item.id,
    name: item.name,
    publisher: curated ? "ClosedLoop" : "Your organization",
    // Group the discovery grid by kind until a real category field exists.
    category: item.targetKind,
    description: item.description,
    githubUrl: null,
    marketplaceUrl: null,
    stars: null,
    starHistory: [],
    verified: curated,
    harnesses: [],
    installedHarnesses: [],
    installedByMe: false,
    usageCount: null,
    // A Pack's authored child components (populated on the detail read) become
    // its contents; empty on list responses.
    contents: item.components.map(
      (child): PackContentEntry => ({
        name: child.name,
        kind: toPackContentKind(child.targetKind),
        description: child.description,
      })
    ),
    teamUsage: null,
    activity: null,
    performance: null,
    distribution: distribution
      ? distributionToPackDistribution(distribution)
      : null,
  };
}
