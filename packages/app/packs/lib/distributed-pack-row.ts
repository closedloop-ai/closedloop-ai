/**
 * View-model for the admin manage-first "Packs you distribute" table
 * (FEA-4088). Derives one honest row per active distribution from the canonical
 * `PackView[]` the admin surface already loads (`useAdminPackViews` →
 * catalog + distributions), keeping the mapping pure so it is unit-testable
 * without a render.
 *
 * The overriding rule is the FEA-4088 Parker principle: the UI must not lie.
 * Adoption and usage are shown as real numbers or as an explicit "unavailable",
 * never a confident fake.
 *
 * Adoption honesty (PLN-1497 OQ4). The `GET /distributions` list read does NOT
 * populate per-device `targetStatuses` (see `distributionsService.listForOrg`),
 * so on the list an installed/target count cannot be computed. Rather than show
 * a fabricated "0 installed" for every row, an adoption summary is present only
 * when the per-target statuses were actually loaded (the detail read, or a
 * future org-wide adoption-summary aggregate over `distribution_target_status`
 * — the noted follow-up). Absent that, adoption reads "Not available", not 0.
 *
 * Usage (30d invocations) is likewise not carried on the distribution/catalog
 * read yet, so it renders "Not reported" until a usage source is wired — never
 * a fake zero.
 */

import {
  type CatalogItemDto,
  CatalogItemSource,
  type DistributionDto,
  type DistributionMode,
} from "@repo/api/src/types/distribution";
import { distributionToPackDistribution } from "./catalog-item-to-pack-view";
import type { PackDistribution, PackView } from "./pack-view";

/**
 * Real adoption for a distributed pack: how many targeted devices/members have
 * the pack installed, out of how many were targeted. Present only when the
 * per-target statuses were loaded (see module doc); `null` on the row means
 * adoption is genuinely unavailable, not zero.
 */
export type PackAdoption = {
  installed: number;
  target: number;
  /** Targets whose push failed to install — the strand an admin acts on. */
  failed: number;
};

/** One row in the "Packs you distribute" table. */
export type DistributedPackRow = {
  /** Distribution id — the stable row identity (a pack can be distributed once). */
  id: string;
  catalogItemId: string;
  name: string;
  publisher: string;
  version: string;
  mode: DistributionMode;
  /** Real adoption, or `null` when it hasn't been computed for this row yet. */
  adoption: PackAdoption | null;
  /** 30d invocations, or `null` when usage telemetry isn't reporting yet. */
  invocations30d: number | null;
};

/** The sortable dimensions of the distribute table. */
export const DistributedPackSortKey = {
  Name: "name",
  Version: "version",
  Mode: "mode",
  Adoption: "adoption",
  Usage: "usage",
} as const;
export type DistributedPackSortKey =
  (typeof DistributedPackSortKey)[keyof typeof DistributedPackSortKey];

/**
 * True when a distribution's per-target statuses were loaded, so an
 * installed/target count is real. Reads the explicit `adoptionLoaded` flag the
 * mapper sets — NOT `targets !== undefined`, because a genuinely loaded-but-
 * empty distribution drops `targets` to `undefined` and would otherwise be
 * misread as "unavailable".
 */
function hasLoadedAdoption(dist: PackDistribution): boolean {
  return dist.adoptionLoaded;
}

/**
 * Adoption percentage as a rounded 0–100 integer. Rounded here so the ARIA
 * value and the visible percent are the one same number.
 *
 * ISS-5115: the range is now enforced rather than merely documented. `installed`
 * can exceed `target` when the targeted group shrinks under an install count
 * that already landed, and an unclamped overshoot reached `Progress`, which
 * treats a value above `max` as indeterminate — so the cell rendered a
 * we-don't-know sweeping bar next to a label reading "120%". The visible
 * `installed of target` fraction next to it keeps the overshoot legible, so
 * capping the derived percentage hides nothing.
 */
export function adoptionPercent(adoption: PackAdoption): number {
  if (adoption.target <= 0) {
    return 0;
  }
  const pct = Math.round((adoption.installed / adoption.target) * 100);
  if (!Number.isFinite(pct)) {
    return 0;
  }
  return Math.min(100, Math.max(0, pct));
}

/**
 * Build the distribute-table rows from the admin `PackView`s. Only packs with
 * an active distribution appear — a catalog item nobody is distributing isn't
 * "distributed". Ordered by name so the default view is stable before the user
 * sorts.
 */
export function toDistributedPackRows(
  packs: readonly PackView[]
): DistributedPackRow[] {
  const rows: DistributedPackRow[] = [];
  for (const pack of packs) {
    const dist = pack.distribution;
    if (!dist) {
      continue;
    }
    rows.push(
      buildRow(dist, {
        catalogItemId: pack.id,
        name: pack.name,
        publisher: pack.publisher ?? "Your organization",
        version: pack.version ?? "—",
      })
    );
  }
  return rows;
}

/**
 * Build the distribute-table rows from the FULL distribution list joined to
 * catalog metadata by id — one row per distribution, not one per catalog item.
 *
 * A catalog item can carry more than one active distribution (the schema has no
 * `(organizationId, catalogItemId)` uniqueness constraint and the create path
 * doesn't enforce it), so folding to the first distribution per catalog id
 * silently drops the rest. The row identity is already the distribution id, so
 * emitting a row per distribution is the honest, lossless mapping. Distributions
 * whose catalog item isn't in the lookup are skipped (they can't be labeled).
 */
export function toDistributedPackRowsFromDistributions(
  distributions: readonly DistributionDto[],
  catalogById: ReadonlyMap<string, CatalogItemDto>
): DistributedPackRow[] {
  const rows: DistributedPackRow[] = [];
  for (const dto of distributions) {
    const item = catalogById.get(dto.catalogItemId);
    if (!item) {
      continue;
    }
    const curated = item.source === CatalogItemSource.Curated;
    rows.push(
      buildRow(distributionToPackDistribution(dto), {
        catalogItemId: item.id,
        name: item.name,
        publisher: curated ? "ClosedLoop" : "Your organization",
        version: item.version ?? "—",
      })
    );
  }
  return rows;
}

type RowIdentity = {
  catalogItemId: string;
  name: string;
  publisher: string;
  version: string;
};

/** Shape one `DistributedPackRow` from a distribution + its catalog identity. */
function buildRow(
  dist: PackDistribution,
  identity: RowIdentity
): DistributedPackRow {
  return {
    id: dist.id,
    catalogItemId: identity.catalogItemId,
    name: identity.name,
    publisher: identity.publisher,
    version: identity.version,
    mode: dist.mode,
    adoption: hasLoadedAdoption(dist)
      ? {
          installed: dist.installedCount,
          target: dist.targetCount,
          failed: dist.failedCount,
        }
      : null,
    // A windowed 30-day usage metric isn't carried on the catalog/distribution
    // read yet. `PackPerformance.invocations` is the ALL-TIME org-wide total,
    // not a 30-day window, so surfacing it under a "Usage (30d)" column would
    // mislabel the number — the FEA-4088 principle bans a wrong number as much
    // as a fake one. Stays null ("Not reported") until a real 30-day source is
    // wired.
    invocations30d: null,
  };
}

/**
 * A stable comparator for one sort key + direction. Unavailable (null)
 * adoption/usage rows always sink to the bottom in BOTH directions — an unknown
 * value is neither the largest nor the smallest real value, so it is never
 * allowed to float to the top of an ascending sort. The direction multiplier is
 * applied only to the real-value comparison; the null-sentinel ordering is kept
 * out of the flip so a null never masquerades as the smallest value.
 */
export function compareDistributedPackRows(
  a: DistributedPackRow,
  b: DistributedPackRow,
  sortKey: DistributedPackSortKey,
  direction: "asc" | "desc"
): number {
  if (sortKey === DistributedPackSortKey.Adoption) {
    return compareNullableNumber(
      a.adoption ? adoptionPercent(a.adoption) : null,
      b.adoption ? adoptionPercent(b.adoption) : null,
      direction
    );
  }
  if (sortKey === DistributedPackSortKey.Usage) {
    return compareNullableNumber(a.invocations30d, b.invocations30d, direction);
  }
  const sign = direction === "asc" ? 1 : -1;
  return sign * compareByKey(a, b, sortKey);
}

function compareByKey(
  a: DistributedPackRow,
  b: DistributedPackRow,
  sortKey: DistributedPackSortKey
): number {
  if (sortKey === DistributedPackSortKey.Version) {
    return a.version.localeCompare(b.version, undefined, { numeric: true });
  }
  if (sortKey === DistributedPackSortKey.Mode) {
    return a.mode.localeCompare(b.mode);
  }
  return a.name.localeCompare(b.name);
}

/**
 * Compare two nullable numbers with nulls parked last in BOTH sort directions.
 * The direction only orders the real values against each other; a null is always
 * "after" a real value regardless of asc/desc, so unavailable rows never lead an
 * ascending sort.
 */
function compareNullableNumber(
  a: number | null,
  b: number | null,
  direction: "asc" | "desc"
): number {
  if (a === null && b === null) {
    return 0;
  }
  // Nulls always sink, independent of direction.
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  const sign = direction === "asc" ? 1 : -1;
  return sign * (a - b);
}
