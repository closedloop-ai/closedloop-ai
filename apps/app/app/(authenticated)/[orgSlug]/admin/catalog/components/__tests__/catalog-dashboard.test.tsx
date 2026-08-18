import {
  type CatalogItemDto,
  CatalogItemScope,
  CatalogItemSource,
} from "@repo/api/src/types/distribution";
import type { MemberTargetsInstall } from "@repo/app/packs/components/member-targets-block";
import type { PackView } from "@repo/app/packs/lib/pack-view";
import { ApiError } from "@repo/app/shared/api/api-error";
import {
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
} from "@repo/app/shared/api/api-timeout";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogDashboard } from "../catalog-dashboard";

/** The bare unstyled paragraph ISS-5002 replaced with the real skeleton. */
const LEGACY_LOADING_TEXT = /Loading Packs…/;

/**
 * Marks that a non-null `memberTargetsInstall` reached PacksWorkspace. Read at
 * render time (not when the `vi.mock` factory is evaluated), so the hoisted
 * factory below can reference it safely.
 */
const INSTALL_MARKER = "wired";

/** A stand-in for the hook's return value; identity is what gets asserted. */
const installStub: MemberTargetsInstall = { onInstall: vi.fn() };

const mocks = vi.hoisted(() => ({
  refetchQueries: vi.fn(),
  useAdminPackViews: vi.fn(),
  useCatalogItems: vi.fn(),
  useCatalogItem: vi.fn(),
  useArchiveCatalogItem: vi.fn(),
  useDistribution: vi.fn(),
  useWithdrawDistribution: vi.fn(),
  useCurrentUser: vi.fn(),
  useFeatureFlagEnabled: vi.fn(),
  useMemberTargetsInstall: vi.fn(),
  usePackAnalytics: vi.fn(),
  useComputeTargets: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@/hooks/queries/use-compute-targets", () => ({
  useComputeTargets: mocks.useComputeTargets,
}));

// ISS-5125. The real hook's own behaviour (per-cell pending set, pack-scoped
// outcomes, dispatch copy) is covered by
// packages/app/packs/hooks/__tests__/use-member-targets-install.test.tsx. What
// this suite owns is the DASHBOARD's half of the contract: the arguments it
// computes for the hook, and that it hands the result to PacksWorkspace.
vi.mock("@repo/app/packs/hooks/use-member-targets-install", () => ({
  useMemberTargetsInstall: mocks.useMemberTargetsInstall,
}));

vi.mock("@repo/app/packs/hooks/use-admin-pack-views", () => ({
  useAdminPackViews: mocks.useAdminPackViews,
}));

vi.mock("@repo/app/agents/hooks/use-catalog", () => ({
  catalogKeys: {
    all: ["catalog"] as const,
    detail: (id: string) => ["catalog", "detail", id] as const,
  },
  useArchiveCatalogItem: mocks.useArchiveCatalogItem,
  useCatalogItem: mocks.useCatalogItem,
  useCatalogItems: mocks.useCatalogItems,
}));

vi.mock("@repo/app/agents/hooks/use-distributions", () => ({
  distributionKeys: { all: ["distributions"] as const },
  useDistribution: mocks.useDistribution,
  useWithdrawDistribution: mocks.useWithdrawDistribution,
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
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueries,
    refetchQueries: mocks.refetchQueries,
  }),
}));

vi.mock("@repo/app/packs/components/packs-workspace", () => ({
  PacksWorkspace: ({
    detailContentsSlot,
    detailHeaderActions,
    detailPack,
    memberTargetsError,
    memberTargetsInstall,
    memberTargetsLoading,
    onManageDistribution,
    onSelectPack,
    packs,
    toolbarSlot,
  }: {
    detailContentsSlot?: ReactNode;
    detailHeaderActions?: ReactNode;
    detailPack?: PackView | null;
    memberTargetsError?: boolean;
    memberTargetsInstall?: MemberTargetsInstall | null;
    memberTargetsLoading?: boolean;
    onManageDistribution?: (packId: string) => void;
    onSelectPack?: (packId: string | null) => void;
    packs: PackView[];
    toolbarSlot?: ReactNode;
  }) => (
    <div>
      <div
        data-member-targets-error={String(Boolean(memberTargetsError))}
        data-member-targets-install={
          memberTargetsInstall ? INSTALL_MARKER : "none"
        }
        data-member-targets-loading={String(Boolean(memberTargetsLoading))}
        data-testid="member-targets-state"
      />
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
    mocks.useMemberTargetsInstall.mockReturnValue(null);
    mocks.useArchiveCatalogItem.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn().mockResolvedValue({}),
    });
    mocks.useDistribution.mockReturnValue({ data: null });
    mocks.useWithdrawDistribution.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn().mockResolvedValue({}),
    });
    mocks.usePackAnalytics.mockReturnValue({ data: null });
    mocks.useComputeTargets.mockReturnValue({
      data: [],
      error: null,
      isLoading: false,
    });
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

  it("arms member install for the selected pack and threads it to the workspace", () => {
    const pack = makeCatalogItem({ createdById: "owner-1" });
    setupDashboard({
      currentUserId: "owner-1",
      items: [pack],
      detailById: { [pack.id]: pack },
    });
    mocks.useMemberTargetsInstall.mockReturnValue(installStub);

    render(<CatalogDashboard isAdmin={false} />);

    expect(mocks.useFeatureFlagEnabled).toHaveBeenCalledWith(
      "member-self-service-install"
    );
    // Nothing selected yet: armed, but with no pack to install.
    expect(mocks.useMemberTargetsInstall).toHaveBeenLastCalledWith({
      packId: null,
      enabled: true,
    });
    expect(screen.getByTestId("member-targets-state")).toHaveAttribute(
      "data-member-targets-install",
      INSTALL_MARKER
    );

    fireEvent.click(screen.getByRole("button", { name: "Select Custom Pack" }));

    expect(mocks.useMemberTargetsInstall).toHaveBeenLastCalledWith({
      packId: pack.id,
      enabled: true,
    });
  });

  it("leaves member install disarmed for an admin and behind a closed flag", () => {
    const pack = makeCatalogItem({ createdById: null });
    setupDashboard({
      currentUserId: null,
      items: [pack],
      detailById: { [pack.id]: pack },
    });

    render(<CatalogDashboard isAdmin />);

    expect(mocks.useMemberTargetsInstall).toHaveBeenLastCalledWith({
      packId: null,
      enabled: false,
    });

    // Same negative on the member surface when the flag is closed — the arm
    // above proves this selector reports `wired` when the hook does return one.
    mocks.useFeatureFlagEnabled.mockReturnValue(false);
    setupDashboard({
      currentUserId: "owner-1",
      items: [pack],
      detailById: { [pack.id]: pack },
    });

    render(<CatalogDashboard isAdmin={false} />);

    expect(mocks.useMemberTargetsInstall).toHaveBeenLastCalledWith({
      packId: null,
      enabled: false,
    });
    for (const node of screen.getAllByTestId("member-targets-state")) {
      expect(node).toHaveAttribute("data-member-targets-install", "none");
    }
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

  it("surfaces the member-targets error when the current-user query fails", () => {
    const pack = makeCatalogItem({ createdById: "owner-1" });
    setupDashboard({
      currentUserId: null,
      items: [pack],
      detailById: { [pack.id]: pack },
    });
    // /me fails on initial load (no cached data): the block must show an error,
    // not a false "no machines" empty.
    mocks.useCurrentUser.mockReturnValue({
      data: undefined,
      error: new Error("me failed"),
      isLoading: false,
    });

    render(<CatalogDashboard isAdmin={false} />);

    const state = screen.getByTestId("member-targets-state");
    expect(state.getAttribute("data-member-targets-error")).toBe("true");
  });

  it("keeps cached machines visible when a background refetch fails", () => {
    const pack = makeCatalogItem({ createdById: "owner-1" });
    setupDashboard({
      currentUserId: "owner-1",
      items: [pack],
      detailById: { [pack.id]: pack },
    });
    // Compute-targets refetch failed, but TanStack retains the last data: the
    // block must keep the cached rows, not discard them for the error state.
    mocks.useComputeTargets.mockReturnValue({
      data: [],
      error: new Error("refetch failed"),
      isLoading: false,
    });

    render(<CatalogDashboard isAdmin={false} />);

    const state = screen.getByTestId("member-targets-state");
    expect(state.getAttribute("data-member-targets-error")).toBe("false");
  });

  it("keeps member-targets loading while the current-user query is pending", () => {
    const pack = makeCatalogItem({ createdById: "owner-1" });
    setupDashboard({
      currentUserId: null,
      items: [pack],
      detailById: { [pack.id]: pack },
    });
    // /me still loading while compute targets resolved: must not flash empty.
    mocks.useComputeTargets.mockReturnValue({
      data: [],
      error: null,
      isLoading: false,
    });
    mocks.useCurrentUser.mockReturnValue({
      data: null,
      error: null,
      isLoading: true,
    });

    render(<CatalogDashboard isAdmin={false} />);

    const state = screen.getByTestId("member-targets-state");
    expect(state.getAttribute("data-member-targets-loading")).toBe("true");
  });

  // ISS-5002: the surface used to render a bare unstyled "Loading Packs…"
  // paragraph forever, while the purpose-built skeleton went unused and a
  // request that never returned produced no error state at all.
  it("renders the purpose-built skeleton while Packs load, not a bare paragraph", () => {
    setupLoadingDashboard();

    render(<CatalogDashboard isAdmin={true} />);

    expect(screen.getByTestId("packs-workspace-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(LEGACY_LOADING_TEXT)).not.toBeInTheDocument();
    // The heading is known ahead of the fetch and holds its place, so the grid
    // does not shift when the catalog lands.
    expect(screen.getByRole("heading", { name: "Packs" })).toBeInTheDocument();
  });

  it("states a timed-out Packs read as a timeout with a retry, not as a server rejection", () => {
    setupFailedDashboard(
      new ApiError(API_TIMEOUT_ERROR_MESSAGE, 0, {
        code: API_TIMEOUT_ERROR_CODE,
      })
    );

    render(<CatalogDashboard isAdmin={true} />);

    // The user is told we stopped waiting — never left on a permanent skeleton,
    // and never told the server rejected something it never answered.
    expect(screen.getByText("Packs took too long to load")).toBeInTheDocument();
    expect(
      screen.queryByTestId("packs-workspace-skeleton")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(mocks.refetchQueries).toHaveBeenCalledWith({
      queryKey: ["catalog"],
    });
    expect(mocks.refetchQueries).toHaveBeenCalledWith({
      queryKey: ["distributions"],
    });
  });

  it("states a server-answered failure distinctly from a timeout", () => {
    setupFailedDashboard(new ApiError("Catalog is unavailable", 500));

    render(<CatalogDashboard isAdmin={true} />);

    expect(screen.getByText("Couldn't load packs")).toBeInTheDocument();
    expect(
      screen.queryByText("Packs took too long to load")
    ).not.toBeInTheDocument();
    // A raw transport message is never rendered to a customer.
    expect(
      screen.queryByText("Catalog is unavailable")
    ).not.toBeInTheDocument();
  });

  it("keeps the Packs heading above a failed read, matching the headed skeleton", () => {
    // The loading branch already renders CatalogHeading, so dropping it here
    // swapped the whole page for one centered card with no page identity the
    // instant the fetch failed.
    setupFailedDashboard(new ApiError("Catalog is unavailable", 500));

    render(<CatalogDashboard isAdmin={true} />);

    expect(screen.getByRole("heading", { name: "Packs" })).toBeInTheDocument();
    expect(screen.getByText("Couldn't load packs")).toBeInTheDocument();
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

/** Packs surface with both underlying reads still in flight. */
function setupLoadingDashboard() {
  mocks.useAdminPackViews.mockReturnValue({
    packViews: [],
    distributionByCatalogId: new Map(),
    isLoading: true,
    error: null,
  });
  mocks.useCatalogItems.mockReturnValue({ data: undefined });
  mocks.useCurrentUser.mockReturnValue({ data: null });
}

/** Packs surface whose underlying read failed with `error`. */
function setupFailedDashboard(error: Error) {
  mocks.useAdminPackViews.mockReturnValue({
    packViews: [],
    distributionByCatalogId: new Map(),
    isLoading: false,
    error,
  });
  mocks.useCatalogItems.mockReturnValue({ data: undefined });
  mocks.useCurrentUser.mockReturnValue({ data: null });
}
