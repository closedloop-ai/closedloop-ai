import { batchItemApplied } from "@repo/api/src/types/batch-mutation-result";
import { BatchMutationRoute } from "@repo/api/src/types/batch-mutation-routes";
import {
  type BranchAnalytics,
  type BranchListResponse,
  type BranchUsageSummary,
  BranchViewerScope,
  type BranchRow as WireBranchRow,
} from "@repo/api/src/types/branch";
import {
  BranchListCapability,
  BranchListFacetAvailability,
  BranchListPageMode,
  type BranchListServerPageSize,
  isBranchListServerPageSize,
} from "@repo/api/src/types/branch-list-contract";
import { unavailableBranchTraceResult } from "@repo/api/src/types/branch-trace";
import { BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY } from "@repo/api/src/types/branches-linked-session-chips-flag";
import { RELATED_SESSIONS_BATCH_ROUTE } from "@repo/api/src/types/related-session";
import {
  ArtifactTagAvailability,
  TagColor,
  TagEntityType,
} from "@repo/api/src/types/tag";
import {
  makeBranchAnalytics,
  makeBranchListMetrics,
} from "@repo/app/branches/components/branch-analytics-fixtures";
import type {
  BranchesDataSource,
  BranchListOptions,
} from "@repo/app/branches/data-source/branches-data-source";
import { canonicalBranchProjectionFixture } from "@repo/app/branches/test-fixtures/canonical-branch-projection";
import type { ApiRequestOptions } from "@repo/app/shared/api/api-timeout";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { createFixtureFetch } from "@repo/app/shared/storybook/fixture-fetch";
import { BULK_TAG_ACTION_LABEL } from "@repo/app/tags/lib/bulk-tag-labels";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inertApiAdapter, renderView, wireRow } from "./test-helpers";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};

const { beginSignInMock, openGitHubConnectMock, useDesktopAuthMock } =
  vi.hoisted(() => ({
    beginSignInMock: vi.fn(),
    openGitHubConnectMock: vi.fn(),
    useDesktopAuthMock: vi.fn(),
  }));
const { setSharedDateRangeMock } = vi.hoisted(() => ({
  setSharedDateRangeMock: vi.fn(),
}));
const { summaryCardsPropsMock } = vi.hoisted(() => ({
  summaryCardsPropsMock: vi.fn(),
}));
/** Every approved Branches column, shown — the shipped default this view resets to. */
const { DEFAULT_VISIBLE_COLUMN_IDS } = vi.hoisted(() => ({
  DEFAULT_VISIBLE_COLUMN_IDS: [
    "owner",
    "collaborators",
    "sessions",
    "changes",
    "status",
    "pr",
    "lastActivity",
    "repo",
    "tags",
  ],
}));

vi.mock("@repo/app/branches/components/branches-summary-cards", () => ({
  BranchesSummaryCards: (props: unknown) => {
    summaryCardsPropsMock(props);
    return null;
  },
}));
vi.mock("@repo/app/branches/hooks/use-branch-saved-views", () => ({
  // The view now restores the collection one hook earlier so the read gate can
  // see it (ISS-9447 review).
  useBranchSavedViewsStore: () => ({ isArrangementSettled: true }),
  useBranchSavedViews: () => ({
    activeViewId: null,
    isArrangementSettled: true,
    modified: false,
    onCreateView: vi.fn(),
    onDeleteView: vi.fn(),
    onRenameView: vi.fn(),
    onSelectView: vi.fn(),
    onUpdateView: vi.fn(),
    views: [],
  }),
}));
vi.mock("@repo/app/branches/data-source/branches-live-bridge", () => ({
  BranchesLiveBridge: () => null,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: useDesktopAuthMock,
}));
vi.mock("@repo/app/shared/hooks/use-shared-date-range", () => ({
  useSharedDateRange: () => ({
    dateRange: "all",
    setDateRange: setSharedDateRangeMock,
  }),
}));
// Only the HOOK is stood in for. The rest of the module is spread back through
// because the v2 toolbar reads the real toggleable-column tables from it
// (ISS-9225), and a stand-in that dropped them would fail the import rather
// than the behaviour under test.
vi.mock("@repo/app/branches/hooks/use-branch-view-state", async (original) => {
  const { useCallback, useState } = await import("react");
  return {
    ...(await original<
      typeof import("@repo/app/branches/hooks/use-branch-view-state")
    >()),
    useBranchViewState: () => {
      // Column visibility is REAL state, not a spy: the toolbar this view now
      // composes reports a toggle and the table has to lose the column, which
      // a `vi.fn()` cannot show. Everything else stays a stand-in.
      const [visibleColumns, setVisibleColumns] = useState(
        () => new Set(DEFAULT_VISIBLE_COLUMN_IDS)
      );
      const toggleColumn = useCallback((id: string) => {
        setVisibleColumns((previous) => {
          const next = new Set(previous);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        });
      }, []);
      const resetColumns = useCallback(() => {
        setVisibleColumns(new Set(DEFAULT_VISIBLE_COLUMN_IDS));
      }, []);
      return {
        applyArrangement: vi.fn(),
        columnOrder: [],
        dateRange: "all",
        isViewReady: true,
        resetColumns,
        resetView: resetColumns,
        setCollapsedGroups: vi.fn(),
        setColumnOrder: vi.fn(),
        setDateRange: vi.fn(),
        setGrouping: vi.fn(),
        setSort: vi.fn(),
        sortDir: "desc",
        sortKey: "updated",
        toggleColumn,
        toggleSortDir: vi.fn(),
        visibleColumns,
      };
    },
  };
});
vi.mock("@closedloop-ai/design-system/components/ui/select", () => ({
  Select: ({
    children,
    disabled,
    onValueChange,
    value,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onValueChange: (value: string) => void;
    value: string;
  }) => (
    <select
      disabled={disabled}
      onChange={(event) => onValueChange(event.currentTarget.value)}
      value={value}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

const ROWS_PER_PAGE_100_OPTION = "100 / page";
const ROWS_PER_PAGE_50_OPTION = "50 / page";
const BRANCH_LIST_METRICS = makeBranchListMetrics();
const listMock =
  vi.fn<(filters: BranchListOptions) => Promise<BranchListResponse>>();
const dataSource: BranchesDataSource = {
  analytics: () => new Promise<BranchAnalytics>(() => undefined),
  cohortAnalytics: async (request) => ({
    canonicalMetrics: BRANCH_LIST_METRICS,
    matchedBranchIds: request.branchIds,
  }),
  comments: () => new Promise<never>(() => undefined),
  detail: () => new Promise<never>(() => undefined),
  list: listMock,
  pageData: async (filters) => ({
    analytics: makeBranchAnalytics(),
    list: await listMock(filters),
  }),
  scope: "http",
  supportsSplitPageData: true,
  supportsTags: true,
  trace: () => Promise.resolve(unavailableBranchTraceResult()),
  usage: () => new Promise<BranchUsageSummary>(() => undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
  beginSignInMock.mockResolvedValue({ ok: true });
  openGitHubConnectMock.mockResolvedValue({
    ok: true,
    url: "http://localhost:3000/api/integrations/github?returnTo=%2Fbranches",
  });
  useDesktopAuthMock.mockReturnValue({
    beginSignIn: beginSignInMock,
    state: {
      organizationId: "org-1",
      status: "authenticated",
      userId: "user-1",
    },
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { openGitHubConnect: openGitHubConnectMock },
  });
  listMock.mockImplementation((filters) =>
    Promise.resolve(
      makeServerListResult([wireRow], {
        limit: toServerPageSize(filters.limit),
        offset: filters.offset ?? 0,
        total: 47,
      })
    )
  );
});

describe("PRD-721 AC-5 Desktop Branches Grid Table", () => {
  it("uses v2 page sizes for split-capable cloud sources without adding search", async () => {
    renderView(dataSource, undefined, [], "/branches?page=2");

    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 25,
          offset: 25,
          pageMode: BranchListPageMode.Server,
        })
      )
    );
    // ISS-9216 changed this number, and the old one was wrong: this source
    // answers page 2 with ONE row, and the host-built readout stated the
    // ARITHMETIC bound `min((page + 1) * pageSize, total)` — "26–47 of 47",
    // claiming 22 rows over the one rendered. The surface states its own range
    // now, bounded by the rows actually on screen (`listPageRange`), so a short
    // page reads as the short page it is.
    expect(await screen.findByText("26–26 of 47")).toBeTruthy();
    // ISS-7053, re-derived by #7544: under the v2 list surface the strip must
    // NOT wrap. A wrapped strip is taller, and this band is a non-shrinking flex
    // item beside the sibling `min-h-0` scroll region, so every rank it gains
    // squeezes that region — at 768x800 on the launched shell it squeezed it to
    // zero, and the region then reads as hidden with nothing wrong with the
    // element itself. Pinned here because the only other guard is the Electron
    // e2e, which is far too slow to catch it in the loop.
    //
    // What #7544 changed is the CARD, not the row: `cardClassName` carries
    // `grow` so the fixed rank fills the band instead of stranding its
    // remainder as a dead gutter. The three props are asserted together because
    // any one of them alone is satisfiable by a layout the other two forbid.
    const summaryCardsProps = summaryCardsPropsMock.mock.calls.at(-1)?.[0] as
      | { cardClassName?: string; className?: string; wrapBelow?: boolean }
      | undefined;
    expect(summaryCardsProps?.wrapBelow).toBeFalsy();
    expect(summaryCardsProps?.className).toContain("overflow-x-auto");
    expect(summaryCardsProps?.cardClassName).toBe(STRETCH_CARD_CLASS);
    const scrollRegion = await screen.findByRole("region", {
      name: "Branches",
    });
    expect(scrollRegion.getAttribute("data-testid")).toBe(
      "branches-scroll-container"
    );
    expect(scrollRegion.getAttribute("tabindex")).toBe("0");
    expect(await screen.findByTestId("branches-history-list")).toBeTruthy();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(
      hasNoSearchOrGrouping(listMock.mock.calls.map(([filters]) => filters))
    ).toBe(true);

    const fiftyPerPage = await screen.findByRole("option", {
      name: ROWS_PER_PAGE_50_OPTION,
    });
    const pageSizeSelect = fiftyPerPage.closest("select") as HTMLSelectElement;
    fireEvent.change(pageSizeSelect, { target: { value: "50" } });

    await waitFor(() =>
      expect(
        listMock.mock.calls.some(
          ([filters]) => filters.limit === 50 && filters.offset === 0
        )
      ).toBe(true)
    );

    const hundredPerPage = await screen.findByRole("option", {
      name: ROWS_PER_PAGE_100_OPTION,
    });
    const updatedPageSizeSelect = hundredPerPage.closest(
      "select"
    ) as HTMLSelectElement;
    fireEvent.change(updatedPageSizeSelect, { target: { value: "100" } });

    await waitFor(() =>
      expect(
        listMock.mock.calls.some(
          ([filters]) => filters.limit === 100 && filters.offset === 0
        )
      ).toBe(true)
    );
    expect(
      listMock.mock.calls.some(
        ([filters]) => filters.limit === 100 && filters.offset === 300
      )
    ).toBe(false);
    expect(
      hasNoSearchOrGrouping(listMock.mock.calls.map(([filters]) => filters))
    ).toBe(true);
  });

  // ISS-9225: the DESKTOP host's half of the v2 toolbar contract. This view
  // hands `BranchesListSurfaceV2` one toolbar prop set and the surface composes
  // `BranchesListToolbarV2` from it; mounting the package surface with callback
  // spies cannot tell that apart from a host that builds the props and never
  // reaches the toolbar with them (davetho). The web shell's mirror is
  // `apps/app/app/(authenticated)/[orgSlug]/branches/__tests__/page-v2-toolbar.test.tsx`.
  it("renders wide Options without duplicate toolbar Sort", async () => {
    renderView(dataSource);

    await waitFor(() => expect(repositoryHeader()).not.toBeNull());
    expect(screen.getByRole("button", { name: OPTIONS_LABEL })).toBeTruthy();
    expect(screen.queryByRole("button", { name: VIEW_LABEL })).toBeNull();
    expect(screen.queryByRole("button", { name: RE_SORTED_BY })).toBeNull();
  });

  it("renders the captured-main compact View and Sort from the desktop host with narrow rollout off", async () => {
    const restore = stubContainerWidthPx(767);
    try {
      renderView(
        dataSource,
        undefined,
        [],
        "/branches",
        true,
        createStaticFeatureFlagAdapter({ enabledFlags: [] })
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: VIEW_LABEL })).toBeTruthy()
      );
      expect(screen.queryByRole("grid")).toBeNull();
      expect(screen.queryByRole("button", { name: OPTIONS_LABEL })).toBeNull();
      fireEvent.pointerDown(screen.getByRole("button", { name: VIEW_LABEL }), {
        button: 0,
        ctrlKey: false,
      });
      expect(await screen.findByText("Sorting", { exact: true })).toBeTruthy();
    } finally {
      restore();
    }
  });

  // ISS-10188: this key was documented web-only, on the claim that no
  // `apps/desktop` module renders `GridTableV2`. Branches is the tightest
  // disproof — `branches-view.tsx` imports `BranchesListSurfaceV2` directly and
  // that surface reads this key — so a flip moves the desktop header's keyboard
  // model, and it fails HERE rather than silently.
  //
  // The key is spelled as a LITERAL rather than imported from
  // `@repo/app/shared/lib/feature-flags`, so this cannot agree with a rename
  // that split the desktop and web spellings. Both arms query the SAME locator:
  // the closed arm's `0` means a closed gate only because the open arm is not.
  it("brings the desktop Branches header cells into the roving grid", async () => {
    const headers = () =>
      Array.from(document.body.querySelectorAll('[role="columnheader"]'));
    const navigable = () =>
      headers().filter((header) => header.hasAttribute("data-grid-cell"));

    // ISS-10245 retired `grid-table-v2-navigable-header-cells` ENABLED, so the
    // closed arm that opened this case asserted a header row the grid can no
    // longer render. The header COUNT below is what keeps the remaining
    // assertion honest against a tree that rendered nothing.
    renderView(dataSource);
    await waitFor(() => expect(repositoryHeader()).not.toBeNull());
    expect(headers().length).toBeGreaterThan(0);

    // EVERY header, not merely one: a half-roving header row is worse for a
    // keyboard user than none at all.
    expect(navigable()).toHaveLength(headers().length);
  });

  it("hides a real column from the desktop table and restores it with Reset view", async () => {
    renderView(dataSource);

    await waitFor(() => expect(repositoryHeader()).not.toBeNull());

    openOptionsMenu();
    fireEvent.click(screen.getByRole("menuitem", REPOSITORY_COLUMN));

    // Close the menu BEFORE reading the table. Radix's dropdown is modal and
    // `aria-hidden`s the view behind it, so a columnheader query taken while it
    // is open returns null whether or not the toggle ever reached the table —
    // the assertion below would pass against a toolbar wired to nothing.
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(repositoryHeader()).toBeNull());

    openOptionsMenu();
    fireEvent.click(screen.getByRole("menuitem", RESET_VIEW_ROW));
    await waitFor(() => expect(repositoryHeader()).not.toBeNull());
  });
});

/**
 * ISS-9317 / ISS-10816 — the desktop half of the Branch membership cell.
 * Local legacy rows retain their compatible count, while cloud rows render the
 * canonical qualifying membership count without a second Related Sessions read.
 */
describe("BranchesView Branch membership cell (ISS-9317 / ISS-10816)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks nothing for a local row with no artifact id and keeps its count chip", async () => {
    const fetchSpy = vi.spyOn(inertApiAdapter, "fetch");
    renderView(dataSource, undefined, [BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY]);

    const chip = await screen.findByRole("link", {
      name: LINKED_SESSION_COUNT_NAME,
    });
    expect(chip.textContent).toBe("1");
    await waitFor(() => expect(repositoryHeader()).not.toBeNull());
    expect(legacyRelatedSessionRequests(fetchSpy)).toHaveLength(0);
  });

  it("renders the canonical membership count without a legacy batch read", async () => {
    const fetchSpy = vi.spyOn(inertApiAdapter, "fetch");
    listMock.mockImplementation((filters) =>
      Promise.resolve(
        makeServerListResult(
          [
            {
              ...wireRow,
              artifactId: BRANCH_ARTIFACT_ID,
              canonicalProjection: {
                ...canonicalBranchProjectionFixture,
                common: {
                  ...canonicalBranchProjectionFixture.common,
                  membership: {
                    qualifyingSessionCount: 3,
                    sessionIds: ["s1", "s2", "s3"],
                  },
                },
              },
            },
          ],
          {
            limit: toServerPageSize(filters.limit),
            offset: filters.offset ?? 0,
            total: 1,
          }
        )
      )
    );
    renderView(dataSource, undefined, [BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY]);

    const chip = await screen.findByRole("link", {
      name: LINKED_SESSION_COUNT_NAME,
    });
    expect(chip.textContent).toBe("3");
    await waitFor(() => expect(repositoryHeader()).not.toBeNull());
    expect(legacyRelatedSessionRequests(fetchSpy)).toHaveLength(0);
  });
});

/**
 * Opens the WIDE cluster's Options menu. Radix dropdowns open on pointerdown
 * rather than click, and `GridTableToolbar` renders the wide and folded clusters
 * as sibling slots — CSS hides one, which jsdom does not apply.
 */
function openOptionsMenu(): void {
  const trigger = screen.getByRole("button", { name: OPTIONS_LABEL });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

/**
 * The header cell addressed by COLUMN ID, not accessible name (ISS-6065).
 *
 * Before ISS-11837 the browser composed the resize handle's and column-options
 * button's labels into this cell's accessible name, so a name query for
 * "Repository" resolved to nothing there and the `toBeNull()` assertion would
 * have passed whether or not the toggle ever reached the table, while jsdom
 * rendered the bare label. The column id is the address that holds in both and
 * does not depend on how the header is named.
 */
function repositoryHeader(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(REPOSITORY_HEADER_SELECTOR);
}

/**
 * `SUMMARY_CARD_STRETCH_CLASS`, written out rather than imported so a change to
 * the card's flex rule has to be made deliberately instead of silently agreeing
 * with itself — the convention the sibling strip tests already follow.
 */
const STRETCH_CARD_CLASS = "shrink-0 grow basis-[var(--summary-card-min)]";
const OPTIONS_LABEL = "Options";
const VIEW_LABEL = "View";
const RE_SORTED_BY = /^Sorted by/;
const LINKED_SESSION_COUNT_NAME = /linked session/i;
const BRANCH_ARTIFACT_ID = "5c1c0a2e-6d1a-4f5b-9c3e-8a1d2f3b4c5d";
const REPOSITORY_HEADER_SELECTOR =
  '[role="columnheader"][data-column-id="repo"]';
const REPOSITORY_COLUMN = { name: "Repository" } as const;
const RESET_VIEW_ROW = { name: "Reset view" } as const;

function hasNoSearchOrGrouping(filtersList: BranchListOptions[]): boolean {
  for (const filters of filtersList) {
    if (
      filters.search !== undefined ||
      "groupBy" in filters ||
      "group" in filters ||
      "groups" in filters
    ) {
      return false;
    }
  }
  return true;
}

function makeServerListResult(
  items: WireBranchRow[],
  pageInfo: {
    limit: BranchListServerPageSize;
    offset: number;
    total: number;
  }
): BranchListResponse {
  const emptyFacet = {
    availability: BranchListFacetAvailability.Complete,
    options: [],
  };
  return {
    facets: {
      collaborators: emptyFacet,
      lastActiveRanges: emptyFacet,
      names: emptyFacet,
      owners: emptyFacet,
      pullRequests: emptyFacet,
      repositories: emptyFacet,
      statuses: emptyFacet,
      tags: emptyFacet,
    },
    items,
    pageInfo: {
      capability: BranchListCapability.ServerPaginationV1,
      limit: pageInfo.limit,
      now: "2026-08-18T18:00:00.000Z",
      offset: pageInfo.offset,
      requestedOffset: pageInfo.offset,
    },
    total: pageInfo.total,
    viewerScope: BranchViewerScope.Self,
  };
}

function toServerPageSize(limit: number | undefined): BranchListServerPageSize {
  if (limit === undefined) {
    return 25;
  }
  return isBranchListServerPageSize(limit) ? limit : 25;
}

/** Exact legacy batch reads; unrelated shell bootstrap requests do not count. */
function legacyRelatedSessionRequests(fetchSpy: {
  mock: {
    calls: readonly (readonly [RequestInfo | URL, ApiRequestOptions?])[];
  };
}): unknown[] {
  return fetchSpy.mock.calls.filter(
    ([input, init]) =>
      requestPathname(input) === RELATED_SESSIONS_BATCH_ROUTE &&
      init?.method === "POST"
  );
}

function requestPathname(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.pathname;
  }
  const url = typeof input === "string" ? input : input.url;
  return new URL(url, inertApiAdapter.resolveApiOrigin()).pathname;
}

describe("Desktop Branch online capability wiring (DT-G04/G05/T02)", () => {
  let onlineDescriptor: PropertyDescriptor | undefined;
  let restoreWidth: (() => void) | undefined;

  beforeEach(() => {
    onlineDescriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    restoreWidth = stubContainerWidthPx(1440);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    restoreWidth?.();
    restoreWidth = undefined;
    if (onlineDescriptor) {
      Object.defineProperty(navigator, "onLine", onlineDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "onLine");
    }
  });

  it("withdraws actual host tag actions offline and restores canonical online batch transport", async () => {
    const ids = ["branch-artifact-a", "branch-artifact-b"];
    const rows = ids.map((artifactId, index) => ({
      ...wireRow,
      id: `branch-${index}`,
      artifactId,
      tagAvailability: ArtifactTagAvailability.Available,
      tagPermissions: { canApply: true, canRemove: true },
    }));
    const tag = { id: "tag-a", name: "backend", color: TagColor.Blue };
    const writes: unknown[] = [];
    listMock.mockImplementation((filters) =>
      Promise.resolve(
        makeServerListResult(rows, {
          limit: toServerPageSize(filters.limit),
          offset: filters.offset ?? 0,
          total: rows.length,
        })
      )
    );
    vi.spyOn(inertApiAdapter, "fetch").mockImplementation(
      createFixtureFetch([
        { method: "GET", path: "/tags", respond: () => [tag] },
        {
          method: "POST",
          path: `${BatchMutationRoute.EntityTags}/v2`,
          respond: ({ body }) => {
            writes.push(body);
            return { results: ids.map(batchItemApplied) };
          },
        },
      ])
    );
    const { container } = renderView(dataSource);
    const first = await waitFor(() => {
      const row = container.querySelector<HTMLElement>(
        '[data-grid-row-id="branch-0"]'
      );
      if (!row) {
        throw new Error("Missing first projected Branch row");
      }
      return row;
    });
    const second = container.querySelector<HTMLElement>(
      '[data-grid-row-id="branch-1"]'
    );
    if (!second) {
      throw new Error("Missing second projected Branch row");
    }
    fireEvent.click(first);
    fireEvent.click(second, { ctrlKey: true });
    expect(
      screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL }).isConnected
    ).toBe(true);
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    fireEvent(window, new Event("offline"));
    // The selection is the host's capability, not the connection's: offline
    // keeps it and withholds only the write.
    expect(screen.getByRole("toolbar").isConnected).toBe(true);
    expect(
      screen.queryByRole("button", { name: BULK_TAG_ACTION_LABEL })
    ).toBeNull();
    expect(writes).toEqual([]);
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    fireEvent(window, new Event("online"));
    fireEvent.click(
      screen.getByRole("button", { name: BULK_TAG_ACTION_LABEL })
    );
    fireEvent.click(await screen.findByRole("button", { name: tag.name }));
    await waitFor(() =>
      expect(writes).toEqual([
        { tagId: tag.id, entityType: TagEntityType.Artifact, entityIds: ids },
      ])
    );
    // Operator ruling on the ISS-12305 review (Asana precedent): the picker
    // closes and the selection stays.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: tag.name })).toBeNull()
    );
    expect(screen.getByRole("toolbar").isConnected).toBe(true);
  });
});
