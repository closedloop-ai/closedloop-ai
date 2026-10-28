/**
 * @file use-admin-pack-views.test.tsx
 * @description Behavioral coverage for the admin catalog/distribution composer
 * (ISS-6701). It produces the `distributedRows` that `admin-view.test.tsx`
 * consumes — but that suite builds its rows itself from a hand-made `PackView[]`
 * fixture, so a bug in THIS producer is invisible there.
 *
 * The load-bearing fixture is the TWO-DISTRIBUTION catalog item. The summary
 * fold (first distribution per catalog item) and the unfolded row list are
 * byte-identical in behavior when every item carries exactly one distribution,
 * which is what every other fixture in this slice uses — so a single-
 * distribution fixture proves nothing about the fold that would drop rows.
 */

import {
  type CatalogItemDto,
  CatalogItemScope,
  CatalogItemSource,
  type DistributionDto,
  DistributionMode,
  DistributionTargetingType,
} from "@repo/api/src/types/distribution";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAdminPackViews } from "../use-admin-pack-views";

const useCatalogItems = vi.fn();
const useDistributions = vi.fn();

vi.mock("../../../agents/hooks/use-catalog", () => ({
  useCatalogItems: (...args: unknown[]) => useCatalogItems(...args),
}));
vi.mock("../../../agents/hooks/use-distributions", () => ({
  useDistributions: (...args: unknown[]) => useDistributions(...args),
}));

type QueryStub = {
  data?: unknown;
  isLoading?: boolean;
  error?: Error | null;
};

function stub(overrides: QueryStub = {}) {
  return { data: undefined, isLoading: false, error: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  useCatalogItems.mockReturnValue(stub());
  useDistributions.mockReturnValue(stub());
});

describe("useAdminPackViews (ISS-6701)", () => {
  it("keeps every distribution as its own row while the summary map folds to the first", () => {
    useCatalogItems.mockReturnValue(
      stub({ data: [catalogItem({ id: "cat-1", name: "Security Baseline" })] })
    );
    useDistributions.mockReturnValue(
      stub({
        data: [
          distribution({ id: "dist-1", catalogItemId: "cat-1" }),
          distribution({
            id: "dist-2",
            catalogItemId: "cat-1",
            mode: DistributionMode.OptIn,
          }),
        ],
      })
    );

    const { result } = renderHook(() => useAdminPackViews());

    // One row per distribution — folding here would silently drop dist-2 from
    // the manage-first table, which is the only place an admin can act on it.
    expect(result.current.distributedRows.map((row) => row.id)).toEqual([
      "dist-1",
      "dist-2",
    ]);
    // The summary map is deliberately the OTHER shape: first distribution only.
    expect(result.current.distributionByCatalogId.size).toBe(1);
    expect(result.current.distributionByCatalogId.get("cat-1")?.id).toBe(
      "dist-1"
    );
    // The pack view is fed by the PLURAL map. The two maps differ by one letter
    // (`distributionByCatalogId` vs `distributionsByCatalogId`), and swapping
    // them silently reverts the member projection to a single folded
    // distribution — the exact FEA-4166 loss `allDistributions` exists to stop.
    expect(
      result.current.packViews[0]?.allDistributions?.map((dist) => dist.id)
    ).toEqual(["dist-1", "dist-2"]);
  });

  it("disables the admin-only distributions query and yields no rows for a member-visible read", () => {
    useCatalogItems.mockReturnValue(stub({ data: [catalogItem()] }));
    // Seeded with real data AND an error so the assertions cannot be satisfied
    // by an empty/failed query — only by the `includeDistributions` guards.
    useDistributions.mockReturnValue(
      stub({
        data: [distribution({ id: "dist-1", catalogItemId: "cat-1" })],
        error: new Error("admin-only"),
      })
    );

    const { result } = renderHook(() =>
      useAdminPackViews({ includeDistributions: false })
    );

    expect(useDistributions).toHaveBeenCalledWith({ enabled: false });
    expect(result.current.distributedRows).toEqual([]);
    expect(result.current.distributionByCatalogId.size).toBe(0);
    expect(result.current.error).toBeNull();
    // The catalog still composes — this is a narrowing, not a failure.
    expect(result.current.packViews).toHaveLength(1);
  });

  it("propagates an error from either underlying query", () => {
    const catalogError = new Error("catalog unreachable");
    useCatalogItems.mockReturnValue(stub({ error: catalogError }));
    const first = renderHook(() => useAdminPackViews());
    expect(first.result.current.error).toBe(catalogError);

    const distributionsError = new Error("distributions unreachable");
    useCatalogItems.mockReturnValue(stub({ data: [] }));
    useDistributions.mockReturnValue(stub({ error: distributionsError }));
    const second = renderHook(() => useAdminPackViews());
    expect(second.result.current.error).toBe(distributionsError);
  });
});

function catalogItem(overrides: Partial<CatalogItemDto> = {}): CatalogItemDto {
  return {
    id: "cat-1",
    organizationId: "org-1",
    targetKind: "pack",
    source: CatalogItemSource.OrgCustom,
    scope: CatalogItemScope.Org,
    name: "Content Pack",
    description: null,
    version: "1.0.0",
    sortOrder: 0,
    enabled: true,
    archived: false,
    coaching: false,
    coachingConfig: null,
    parentPackId: null,
    componentUuid: null,
    content: null,
    components: [],
    agentSlug: null,
    logoUrl: null,
    createdById: "user-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function distribution(
  overrides: Partial<DistributionDto> = {}
): DistributionDto {
  return {
    id: "dist-1",
    organizationId: "org-1",
    catalogItemId: "cat-1",
    catalogItem: {
      id: "cat-1",
      name: "Content Pack",
      targetKind: "pack",
      source: CatalogItemSource.OrgCustom,
    },
    mode: DistributionMode.AutoInstall,
    targetingType: DistributionTargetingType.All,
    desiredEnabled: true,
    targetingEntries: [],
    targetStatuses: [],
    assetDownloadUrl: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}
