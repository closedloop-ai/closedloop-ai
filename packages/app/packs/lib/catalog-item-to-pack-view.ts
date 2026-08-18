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
  type DistributionTargetStatusValue,
  DistributionTargetStatusValue as TargetStatus,
} from "@repo/api/src/types/distribution";
import {
  buildComponentInstallMatrix,
  type InstallMatrixTarget,
  type PackComponentInstallMatrix,
} from "./pack-install-matrix";
import {
  type PackContentEntry,
  type PackDistribution,
  type PackDistributionTarget,
  type PackView,
  toPackContentKind,
} from "./pack-view";

const INSTALLED_STATUSES: ReadonlySet<DistributionTargetStatusValue> = new Set([
  TargetStatus.Installed,
  TargetStatus.Enabled,
]);
const PENDING_STATUSES: ReadonlySet<DistributionTargetStatusValue> = new Set([
  TargetStatus.Pending,
  TargetStatus.OptedIn,
]);

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
  const failedCount = targets.filter(
    (t) => t.status === TargetStatus.Failed
  ).length;

  // `targetStatuses` is populated only on the detail read (empty on the list —
  // see DistributionDto). Treat a non-empty `targetStatuses` as "adoption was
  // loaded" and set the flag explicitly so downstream row-building reads this
  // signal rather than inferring from `targets`, which drops to `undefined`
  // when the loaded set is empty. (A genuinely loaded-but-zero-target detail is
  // indistinguishable from the list at the DTO level — that's an API-shape
  // limitation, not something this mapper can resolve; it errs toward "not
  // available" rather than a fabricated 0, per FEA-4088.)
  const adoptionLoaded = dist.targetStatuses.length > 0;

  return {
    id: dist.id,
    mode: dist.mode,
    targetingType: dist.targetingType,
    desiredEnabled: dist.desiredEnabled,
    // Carried through so a member surface can check whether THIS member is in a
    // `specific` distribution's targeted cohort (FEA-4089 review). Present on
    // both the list and detail read.
    targetingEntries: dist.targetingEntries,
    targetCount: Math.max(dist.targetingEntries.length, targets.length),
    installedCount,
    pendingCount,
    failedCount,
    targets: targets.length > 0 ? targets : undefined,
    adoptionLoaded,
  };
}

/**
 * Build the per-(compute target × harness × component) install matrix for a
 * pack, when both its distribution status rows and the org's resolved compute
 * targets are available (FEA-4072a). Returns `null` when either is missing so
 * the field stays absent on surfaces that haven't loaded the multi-target
 * axis — keeping the model additive and back-compat.
 *
 * The component dimension here is the pack's own CatalogItem; child-component
 * matrices need each child's own distribution and are layered on by a caller
 * that has loaded them (deferred to the manage-across-targets UX, FEA-4072b).
 */
function buildPackInstallMatrix(
  item: CatalogItemDto,
  distribution: DistributionDto | null | undefined,
  targets: readonly InstallMatrixTarget[] | null | undefined
): PackComponentInstallMatrix[] | null {
  if (!(distribution && targets) || targets.length === 0) {
    return null;
  }
  return [
    buildComponentInstallMatrix(
      { id: item.id, name: item.name, version: item.version },
      distribution.targetStatuses,
      targets
    ),
  ];
}

/**
 * Build a `PackView` from a catalog item + its (optional) distribution.
 *
 * Until the curated-metadata fields land on `CatalogItem` (publisher / stars /
 * verified / harnesses / githubUrl), these are derived from the item's source:
 * curated items read as ClosedLoop-published and verified.
 *
 * `targets` (FEA-4072a) is the org's resolved compute targets; when supplied
 * alongside a distribution, the per-(target × harness) `installMatrix` is
 * populated. Omitting it (the default) leaves `installMatrix` null — the field
 * is additive, so existing callers are unaffected.
 *
 * `allDistributions` (FEA-4166 review) is every distribution the org has for
 * this catalog item, not just the summary `distribution`. It feeds the member
 * projection, which must consider all applicable distributions (a required
 * `all` distribution must win even when a newer `specific` distribution targets
 * someone else). Optional and additive: when omitted it defaults to the single
 * `distribution` (or empty), so existing callers are unaffected.
 */
export function catalogItemToPackView(
  item: CatalogItemDto,
  distribution?: DistributionDto | null,
  targets?: readonly InstallMatrixTarget[] | null,
  allDistributions?: readonly DistributionDto[] | null
): PackView {
  const curated = item.source === CatalogItemSource.Curated;
  const foldedDistributions = resolveAllPackDistributions(
    distribution,
    allDistributions
  );
  return {
    id: item.id,
    name: item.name,
    publisher: curated ? "ClosedLoop" : "Your organization",
    version: item.version,
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
        content: child.content,
      })
    ),
    teamUsage: null,
    activity: null,
    performance: null,
    distribution: distribution
      ? distributionToPackDistribution(distribution)
      : null,
    allDistributions: foldedDistributions,
    installMatrix: buildPackInstallMatrix(item, distribution, targets),
  };
}

/**
 * Fold every distribution the org has for a catalog item into `PackDistribution`
 * summaries for the member projection. Prefers the explicit `allDistributions`
 * list (FEA-4166 review); falls back to the single `distribution` so callers
 * that only pass the summary still get a one-element list, and returns `null`
 * when neither is supplied (nothing to project).
 */
function resolveAllPackDistributions(
  distribution: DistributionDto | null | undefined,
  allDistributions: readonly DistributionDto[] | null | undefined
): PackDistribution[] | null {
  if (allDistributions && allDistributions.length > 0) {
    return allDistributions.map(distributionToPackDistribution);
  }
  if (distribution) {
    return [distributionToPackDistribution(distribution)];
  }
  return null;
}
