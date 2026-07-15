import {
  type CatalogItemDto,
  CatalogItemScope,
  CatalogItemSource,
} from "@repo/api/src/types/distribution";
import type { PackView } from "@repo/app/packs/lib/pack-view";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogDashboard } from "../catalog-dashboard";

const mocks = vi.hoisted(() => ({
  useAdminPackViews: vi.fn(),
  useCatalogItems: vi.fn(),
  useCatalogItem: vi.fn(),
  useArchiveCatalogItem: vi.fn(),
  useDistribution: vi.fn(),
  useCurrentUser: vi.fn(),
  useFeatureFlagEnabled: vi.fn(),
  usePackAnalytics: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@repo/app/packs/hooks/use-admin-pack-views", () => ({
  useAdminPackViews: mocks.useAdminPackViews,
}));

vi.mock("@repo/app/agents/hooks/use-catalog", () => ({
  catalogKeys: {
    detail: (id: string) => ["catalog", "detail", id] as const,
  },
  useArchiveCatalogItem: mocks.useArchiveCatalogItem,
  useCatalogItem: mocks.useCatalogItem,
  useCatalogItems: mocks.useCatalogItems,
}));

vi.mock("@repo/app/agents/hooks/use-distributions", () => ({
  useDistribution: mocks.useDistribution,
}));

vi.mock("@repo/app/packs/hooks/use-pack-analytics", () => ({
  usePackAnalytics: mocks.usePackAnalytics,
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: mocks.useCurrentUser,
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: mocks.useFeatureFlagEnabled,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("@repo/app/packs/components/packs-workspace", () => ({
  PacksWorkspace: ({
    detailContentsSlot,
    detailHeaderActions,
    detailPack,
    onManageDistribution,
    onSelectPack,
    packs,
    toolbarSlot,
  }: {
    detailContentsSlot?: ReactNode;
    detailHeaderActions?: ReactNode;
    detailPack?: PackView | null;
    onManageDistribution?: (packId: string) => void;
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
          <div data-testid="detail-actions">{detailHeaderActions}</div>
          {onManageDistribution ? (
            <button
              onClick={() => onManageDistribution(detailPack.id)}
              type="button"
            >
              Manage distribution
            </button>
          ) : null}
          {detailContentsSlot}
        </section>
      ) : null}
    </div>
  ),
}));

vi.mock("../pack-components-panel", () => ({
  PackComponentsPanel: ({
    canCreateComponents,
    canEditComponent,
    components,
    onAdd,
    onEdit,
  }: {
    canCreateComponents: boolean;
    canEditComponent: (component: CatalogItemDto) => boolean;
    components: CatalogItemDto[];
    onAdd: () => void;
    onEdit: (component: CatalogItemDto) => void;
  }) => (
    <div data-testid="components-panel">
      {canCreateComponents ? (
        <>
          <button onClick={onAdd} type="button">
            Add component
          </button>
          <button type="button">Import from zip</button>
        </>
      ) : null}
      {components.map((component) =>
        canEditComponent(component) ? (
          <button
            key={component.id}
            onClick={() => onEdit(component)}
            type="button"
          >
            Edit {component.name}
          </button>
        ) : null
      )}
    </div>
  ),
}));

vi.mock("../component-editor-dialog", () => ({
  ComponentEditorDialog: ({
    existing,
    open,
    parentPackId,
  }: {
    existing?: CatalogItemDto | null;
    open: boolean;
    parentPackId?: string;
  }) =>
    open ? (
      <div
        data-existing-id={existing?.id ?? ""}
        data-parent-pack-id={parentPackId ?? ""}
        data-testid="editor-dialog"
      />
    ) : null,
}));

vi.mock("../create-pack-dialog", () => ({
  CreatePackDialog: () => null,
}));

vi.mock("../create-distribution-modal", () => ({
  CreateDistributionModal: () => null,
}));

describe("CatalogDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useFeatureFlagEnabled.mockReturnValue(true);
    mocks.useArchiveCatalogItem.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn().mockResolvedValue({}),
    });
    mocks.useDistribution.mockReturnValue({ data: null });
    mocks.usePackAnalytics.mockReturnValue({ data: null });
  });

  it("lets a non-admin owner edit a selected custom item without admin controls", () => {
    const pack = makeCatalogItem({ createdById: "owner-1" });
    setupDashboard({
      currentUserId: "owner-1",
      items: [pack],
      detailById: { [pack.id]: pack },
    });

    render(<CatalogDashboard isAdmin={false} />);

    expect(mocks.useAdminPackViews).toHaveBeenCalledWith({
      includeDistributions: false,
    });
    expect(mocks.useCurrentUser).toHaveBeenCalledWith({ enabled: true });
    expect(screen.queryByRole("button", { name: "New Pack" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Select Custom Pack" }));

    const detail = screen.getByLabelText("detail");
    expect(within(detail).getByRole("button", { name: "Edit" })).toBeDefined();
    expect(
      within(detail).queryByRole("button", { name: "Archive" })
    ).toBeNull();
    expect(
      within(detail).queryByRole("button", { name: "Manage distribution" })
    ).toBeNull();
    expect(
      within(detail).queryByRole("button", { name: "Add component" })
    ).toBeNull();

    fireEvent.click(within(detail).getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("editor-dialog")).toHaveAttribute(
      "data-existing-id",
      pack.id
    );
  });

  it("hides edit for a non-admin non-owner", () => {
    const pack = makeCatalogItem({ createdById: "owner-1" });
    setupDashboard({
      currentUserId: "different-user",
      items: [pack],
      detailById: { [pack.id]: pack },
    });

    render(<CatalogDashboard isAdmin={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Select Custom Pack" }));

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByTestId("editor-dialog")).toBeNull();
  });

  it("keeps catalog management controls available for admins", () => {
    const component = makeCatalogItem({
      id: "component-1",
      name: "Owned Agent",
      parentPackId: "pack-1",
      targetKind: "agent",
      createdById: "component-owner",
    });
    const pack = makeCatalogItem({
      id: "pack-1",
      createdById: null,
      components: [component],
    });
    setupDashboard({
      currentUserId: null,
      items: [pack],
      detailById: { [pack.id]: pack },
    });

    render(<CatalogDashboard isAdmin />);

    expect(mocks.useAdminPackViews).toHaveBeenCalledWith({
      includeDistributions: true,
    });
    expect(mocks.useCurrentUser).toHaveBeenCalledWith({ enabled: false });
    expect(screen.getByRole("button", { name: "New Pack" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Select Custom Pack" }));

    expect(screen.getByRole("button", { name: "Edit" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Archive" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Manage distribution" })
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Add component" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Edit Owned Agent" })
    ).toBeDefined();
  });

  it("allows non-admin owners to edit their child components without add/import controls", () => {
    const ownedComponent = makeCatalogItem({
      id: "component-owned",
      name: "Owned Agent",
      parentPackId: "pack-1",
      targetKind: "agent",
      createdById: "owner-1",
    });
    const otherComponent = makeCatalogItem({
      id: "component-other",
      name: "Other Agent",
      parentPackId: "pack-1",
      targetKind: "agent",
      createdById: "other-user",
    });
    const pack = makeCatalogItem({
      id: "pack-1",
      createdById: "other-user",
      components: [ownedComponent, otherComponent],
    });
    setupDashboard({
      currentUserId: "owner-1",
      items: [pack],
      detailById: { [pack.id]: pack },
    });

    render(<CatalogDashboard isAdmin={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Select Custom Pack" }));

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add component" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit Owned Agent" })
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Edit Other Agent" })
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit Owned Agent" }));
    expect(screen.getByTestId("editor-dialog")).toHaveAttribute(
      "data-existing-id",
      ownedComponent.id
    );
  });

  it("hides child edit controls under an archived pack", () => {
    renderNonEditableParent({ archived: true });

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit Owned Agent" })
    ).toBeNull();
    expect(screen.queryByTestId("editor-dialog")).toBeNull();
  });

  it("hides child edit controls under a curated pack", () => {
    renderNonEditableParent({
      scope: CatalogItemScope.Global,
      source: CatalogItemSource.Curated,
    });

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit Owned Agent" })
    ).toBeNull();
    expect(screen.queryByTestId("editor-dialog")).toBeNull();
  });
});

function setupDashboard({
  currentUserId,
  detailById,
  items,
}: {
  currentUserId: string | null;
  detailById: Record<string, CatalogItemDto>;
  items: CatalogItemDto[];
}) {
  mocks.useAdminPackViews.mockReturnValue({
    packViews: items.map(catalogItemToPackViewFixture),
    distributionByCatalogId: new Map(),
    isLoading: false,
    error: null,
  });
  mocks.useCatalogItems.mockReturnValue({ data: items });
  mocks.useCatalogItem.mockImplementation((id: string) => ({
    data: detailById[id] ?? null,
  }));
  mocks.useCurrentUser.mockReturnValue({
    data: currentUserId ? { id: currentUserId } : null,
  });
}

function makeCatalogItem(
  overrides: Partial<CatalogItemDto> = {}
): CatalogItemDto {
  return {
    id: "pack-1",
    organizationId: "org-1",
    targetKind: "pack",
    source: CatalogItemSource.OrgCustom,
    scope: CatalogItemScope.Org,
    name: "Custom Pack",
    description: "Custom description",
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

function catalogItemToPackViewFixture(item: CatalogItemDto): PackView {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    verified: item.source === CatalogItemSource.Curated,
    harnesses: [],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
  };
}

function renderNonEditableParent(packOverrides: Partial<CatalogItemDto>) {
  const ownedComponent = makeCatalogItem({
    id: "component-owned",
    name: "Owned Agent",
    parentPackId: "pack-1",
    targetKind: "agent",
    createdById: "owner-1",
  });
  const pack = makeCatalogItem({
    id: "pack-1",
    createdById: "owner-1",
    components: [ownedComponent],
    ...packOverrides,
  });
  setupDashboard({
    currentUserId: "owner-1",
    items: [pack],
    detailById: { [pack.id]: pack },
  });

  render(<CatalogDashboard isAdmin={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Select Custom Pack" }));
}
