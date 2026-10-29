import type {
  CatalogItemDto,
  DistributionDto,
} from "@repo/api/src/types/distribution";
import { usePackDashboardSelection } from "@repo/app/packs/hooks/use-pack-dashboard-selection";
import type { PackView } from "@repo/app/packs/lib/pack-view";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyticsData: undefined as unknown,
  catalogDetail: undefined as CatalogItemDto | undefined,
  analytics: vi.fn(),
  catalogItemToPackView: vi.fn(),
  memberInstallMatrix: vi.fn(),
  toAnalytics: vi.fn(),
  useCatalogItem: vi.fn(),
}));

vi.mock("@repo/app/agents/hooks/use-catalog", () => ({
  useCatalogItem: (id: string) => mocks.useCatalogItem(id),
}));

vi.mock("@repo/app/packs/hooks/use-pack-analytics", () => ({
  usePackAnalytics: (slug: string | null) => mocks.analytics(slug),
}));

vi.mock("@repo/app/packs/lib/catalog-item-to-pack-view", () => ({
  catalogItemToPackView: (
    item: CatalogItemDto,
    distribution: DistributionDto | null
  ) => mocks.catalogItemToPackView(item, distribution),
}));

vi.mock("@repo/app/packs/lib/member-targets", () => ({
  memberInstallMatrix: (...args: unknown[]) =>
    mocks.memberInstallMatrix(...args),
}));

vi.mock("@repo/app/packs/lib/agent-component-to-analytics", () => ({
  agentComponentToPackAnalytics: (data: unknown) => mocks.toAnalytics(data),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.analyticsData = undefined;
  mocks.catalogDetail = undefined;
  mocks.useCatalogItem.mockImplementation(() => ({
    data: mocks.catalogDetail,
  }));
  mocks.analytics.mockImplementation(() => ({ data: mocks.analyticsData }));
  mocks.catalogItemToPackView.mockImplementation((item: CatalogItemDto) =>
    makePack(item.id)
  );
  mocks.memberInstallMatrix.mockReturnValue([{ componentId: "member-matrix" }]);
  mocks.toAnalytics.mockReturnValue({
    teamUsage: { installTrend: [1, 2] },
    performance: { sessions: 4 },
  });
});

describe("usePackDashboardSelection", () => {
  test("returns no detail when selection cannot be resolved", () => {
    const { result } = renderHook(() =>
      usePackDashboardSelection({ items: undefined, selectedId: null })
    );

    expect(mocks.useCatalogItem).toHaveBeenCalledWith("");
    expect(mocks.analytics).toHaveBeenCalledWith(null);
    expect(result.current).toEqual({
      selectedItem: null,
      detailPack: null,
      detailPending: false,
      detailFailed: false,
    });
  });

  test("falls back to the list snapshot and can disable analytics", () => {
    const item = makeCatalogItem("pack-1", "helper");
    const { result } = renderHook(() =>
      usePackDashboardSelection({
        items: [item],
        selectedId: "pack-1",
        analyticsEnabled: false,
      })
    );

    expect(result.current.selectedItem).toBe(item);
    expect(mocks.analytics).toHaveBeenCalledWith(null);
    expect(mocks.catalogItemToPackView).toHaveBeenCalledWith(item, null);
    expect(result.current.detailPack).toEqual(makePack("pack-1"));
    expect(mocks.memberInstallMatrix).not.toHaveBeenCalled();
  });

  test("prefers hydrated detail and layers member matrix plus analytics", () => {
    const listItem = makeCatalogItem("pack-1", "list-slug");
    const detailItem = makeCatalogItem("pack-1", "detail-slug");
    const distribution = {
      targetStatuses: [{ id: "status-1" }],
    } as unknown as DistributionDto;
    const memberTargets = [
      {
        id: "target-1",
        machineName: "Mac",
        selectedHarness: "codex",
        isOnline: true,
      },
    ] as const;
    mocks.catalogDetail = detailItem;
    mocks.analyticsData = { sessions: 4 };

    const { result } = renderHook(() =>
      usePackDashboardSelection({
        items: [listItem],
        selectedId: "pack-1",
        distribution,
        memberTargets,
      })
    );

    expect(result.current.selectedItem).toBe(detailItem);
    expect(mocks.analytics).toHaveBeenCalledWith(
      expect.stringContaining("detail-slug")
    );
    expect(mocks.memberInstallMatrix).toHaveBeenCalledWith(
      detailItem,
      memberTargets,
      distribution.targetStatuses
    );
    expect(mocks.toAnalytics).toHaveBeenCalledWith({ sessions: 4 });
    expect(result.current.detailPack).toEqual({
      ...makePack("pack-1"),
      installMatrix: [{ componentId: "member-matrix" }],
      teamUsage: { installTrend: [1, 2] },
      performance: { sessions: 4 },
    });
  });

  test("an empty member target list still produces an honest empty matrix", () => {
    const item = makeCatalogItem("pack-1", null);
    mocks.memberInstallMatrix.mockReturnValue([]);
    const { result } = renderHook(() =>
      usePackDashboardSelection({
        items: [item],
        selectedId: "pack-1",
        memberTargets: [],
      })
    );

    expect(mocks.analytics).toHaveBeenCalledWith(null);
    expect(mocks.memberInstallMatrix).toHaveBeenCalledWith(item, [], []);
    expect(result.current.detailPack?.installMatrix).toEqual([]);
  });
});

function makeCatalogItem(id: string, agentSlug: string | null): CatalogItemDto {
  return { id, agentSlug } as unknown as CatalogItemDto;
}

function makePack(id: string): PackView {
  return {
    id,
    name: id,
    verified: false,
    harnesses: [],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
  };
}
