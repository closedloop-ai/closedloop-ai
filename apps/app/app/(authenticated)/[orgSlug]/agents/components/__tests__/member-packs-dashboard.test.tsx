import {
  type CatalogItemDto,
  CatalogItemScope,
  CatalogItemSource,
} from "@repo/api/src/types/distribution";
import type { PackView } from "@repo/app/packs/lib/pack-view";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemberPacksDashboard } from "../member-packs-dashboard";

const SELECT_BUTTON_NAME = /^Select /;

const mocks = vi.hoisted(() => ({
  useCatalogItems: vi.fn(),
  useCatalogItem: vi.fn(),
  useFeatureFlagEnabled: vi.fn(),
  usePackAnalytics: vi.fn(),
}));

vi.mock("@repo/app/agents/hooks/use-catalog", () => ({
  useCatalogItem: mocks.useCatalogItem,
  useCatalogItems: mocks.useCatalogItems,
}));

vi.mock("@repo/app/packs/hooks/use-pack-analytics", () => ({
  usePackAnalytics: mocks.usePackAnalytics,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: mocks.useFeatureFlagEnabled,
}));

vi.mock("@repo/app/packs/components/packs-workspace", () => ({
  PacksWorkspace: ({
    detailPack,
    onSelectPack,
    packs,
    toolbarSlot,
  }: {
    detailPack?: PackView | null;
    onSelectPack?: (packId: string | null) => void;
    packs: PackView[];
    toolbarSlot?: ReactNode;
  }) => (
    <div>
      <div data-testid="toolbar">{toolbarSlot}</div>
      {packs.map((pack) => (
        <button
          key={pack.id}
          onClick={() => onSelectPack?.(pack.id)}
          type="button"
        >
          Select {pack.name}
        </button>
      ))}
      {detailPack ? (
        <section aria-label="detail">
          <span data-testid="detail-name">{detailPack.name}</span>
          <span data-testid="detail-installed-count">
            {detailPack.teamUsage?.installedCount ?? "no-analytics"}
          </span>
        </section>
      ) : null}
    </div>
  ),
}));

describe("MemberPacksDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useFeatureFlagEnabled.mockReturnValue(false);
    mocks.useCatalogItem.mockReturnValue({ data: null });
    mocks.usePackAnalytics.mockReturnValue({ data: null });
  });

  it("renders the loading state while the catalog is fetching", () => {
    mocks.useCatalogItems.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    render(<MemberPacksDashboard />);

    expect(screen.getByText("Loading Packs…")).toBeDefined();
    expect(screen.queryByTestId("toolbar")).toBeNull();
  });

  it("renders the error state when the catalog read fails", () => {
    mocks.useCatalogItems.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
    });

    render(<MemberPacksDashboard />);

    expect(screen.getByText("Failed to load Packs: boom")).toBeDefined();
  });

  it("renders the empty workspace when the org catalog has no packs", () => {
    mocks.useCatalogItems.mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });

    render(<MemberPacksDashboard />);

    expect(screen.getByText("Plugins")).toBeDefined();
    expect(
      screen.getByText("Browse the Packs available to your organization.")
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: SELECT_BUTTON_NAME })
    ).toBeNull();
    expect(screen.queryByLabelText("detail")).toBeNull();
  });

  it("renders the selected pack with the canonical analytics overlay", () => {
    const pack = makeCatalogItem({ agentSlug: "code-reviewer" });
    mocks.useCatalogItems.mockReturnValue({
      data: [pack],
      isLoading: false,
      error: null,
    });
    mocks.useCatalogItem.mockImplementation((id: string) => ({
      data: id === pack.id ? pack : null,
    }));
    mocks.usePackAnalytics.mockReturnValue({
      data: {
        owner: "Ada",
        collaborators: ["Grace"],
        computeTargetIds: ["node-1", "node-2"],
        trend: [],
        klocPerDollar: 1.2,
        invocations: 10,
        sessions: 4,
      },
    });

    render(<MemberPacksDashboard />);

    expect(mocks.usePackAnalytics).toHaveBeenCalledWith(null);

    fireEvent.click(screen.getByRole("button", { name: "Select Member Pack" }));

    const detail = screen.getByLabelText("detail");
    expect(detail).toBeDefined();
    expect(screen.getByTestId("detail-name").textContent).toBe("Member Pack");
    // Owner + one collaborator installed → analytics overlay folded in.
    expect(screen.getByTestId("detail-installed-count").textContent).toBe("2");
    // Analytics fetch is keyed on the selected pack's component slug.
    expect(mocks.usePackAnalytics).toHaveBeenLastCalledWith(
      "subagent::code-reviewer"
    );
  });
});

function makeCatalogItem(
  overrides: Partial<CatalogItemDto> = {}
): CatalogItemDto {
  return {
    id: "pack-1",
    organizationId: "org-1",
    targetKind: "pack",
    source: CatalogItemSource.OrgCustom,
    scope: CatalogItemScope.Org,
    name: "Member Pack",
    description: "Member-readable pack",
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
    createdById: "owner-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}
