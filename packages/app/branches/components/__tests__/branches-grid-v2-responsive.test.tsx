import {
  BranchDataState,
  BranchTagAvailability,
} from "@repo/api/src/types/branch";
import { TagColor } from "@repo/api/src/types/tag";
import { ApiAdapterProvider } from "@repo/app/shared/api/provider";
import type { ProductGridFavoriteController } from "@repo/app/shared/components/product-grid-table-v2";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import {
  BRANCHES_COLUMN_REGISTRY_FEATURE_FLAG_KEY,
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { PRODUCT_GRID_FAVORITE_COLUMN_LABEL } from "@repo/app/shared/lib/product-grid-favorites";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import {
  type ResponsiveNarrowViewportStub,
  stubResponsiveNarrowViewport,
} from "@repo/app/test/mocks/responsive-narrow-viewport";
import { PINNED_LEAD_UTILITY_TRACK_WIDTH } from "@repo/design-system/lib/grid-table-pin";
import type { GridTableV2Group } from "@repo/design-system/lib/grid-table-v2-types";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { branchColumnLabel } from "../../lib/branch-column-view-model";
import { type BranchRow, BranchRowStatus } from "../../lib/branch-row";
import { APPROVED_BRANCH_COLUMN_SPECS } from "../approved-branches-grid-adapter";
import { BranchesGridV2 } from "../branches-grid-v2";

const ROW: BranchRow = {
  additions: null,
  ahead: null,
  baseBranch: "main",
  behind: null,
  branchName: "feature/responsive-card",
  checksPassed: null,
  checksStatus: null,
  checksTotal: null,
  collaborators: [],
  commentCount: null,
  deletions: null,
  id: "acme%2Fapp::feature-responsive-card",
  lastActivityLabel: "Unavailable",
  owner: "Ada Lovelace",
  prNumber: null,
  prState: null,
  prTitle: null,
  prUrl: null,
  repo: "acme/app",
  sessionCount: 0,
  status: BranchRowStatus.Open,
  tags: [],
};

const useBranchFavoritesControllerMock = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/use-branch-favorites-controller", () => ({
  useBranchFavoritesController: useBranchFavoritesControllerMock,
}));

const ALL_VISIBLE_COLUMNS = new Set(
  APPROVED_BRANCH_COLUMN_SPECS.map((column) => column.id)
);
const RE_ROW_LINK = /feature\/responsive-card$/;
const RE_REFRESHED_ROW_LINK = /feature\/refreshed$/;
const RE_SYNCING_ROW_LINK = /Syncing branch data\.\s*feature\/responsive-card/;
const CARD_WIDTH_PX = 767;
const STATUS_LABEL = "Open";
const EMPTY_FIELD_COLUMNS = new Set([
  "owner",
  "collaborators",
  "sessions",
  "status",
  "pr",
  "tags",
]);

let viewportStub: ResponsiveNarrowViewportStub | null = null;
let restoreContainerWidth: (() => void) | null = null;

afterEach(() => {
  cleanup();
  useBranchFavoritesControllerMock.mockReset();
  viewportStub?.restore();
  viewportStub = null;
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe.each([
  ["hand-built layout", []],
  ["registry layout", [BRANCHES_COLUMN_REGISTRY_FEATURE_FLAG_KEY]],
])(
  "[DT-01][DT-16] BranchesGridV2 responsive projection on the %s",
  (_label, enabledFlags) => {
    it("renders the one-column narrow list below 768px and preserves the wide grid at 768px", () => {
      viewportStub = stubResponsiveNarrowViewport(true);
      renderGrid({ enabledFlags });

      expect(screen.getByRole("grid")).toHaveClass("min-w-0");
      expect(screen.getAllByRole("columnheader")).toHaveLength(1);
      expect(screen.getByRole("columnheader")).toHaveTextContent("Name");
      const narrowLink = screen.getByRole("link", {
        name: ROW.branchName,
      });
      expect(narrowLink).toBeVisible();
      expect(within(narrowLink).queryByRole("img")).toBeNull();
      expect(within(screen.getByRole("grid")).getByRole("img")).toBeVisible();
      expect(document.querySelectorAll("dl")).toHaveLength(0);

      act(() => {
        viewportStub?.setNarrow(false);
      });

      expect(screen.getByRole("grid")).toHaveClass("min-w-fit");
      expect(screen.getAllByRole("columnheader").length).toBeGreaterThan(1);
      expect(document.querySelectorAll("dl")).toHaveLength(0);
      expect(
        screen
          .getByRole("grid")
          .querySelector<HTMLDivElement>("[data-grid-row]")
          ?.style.gridTemplateColumns.startsWith(
            `${PINNED_LEAD_UTILITY_TRACK_WIDTH} `
          )
      ).toBe(false);

      act(() => {
        viewportStub?.setNarrow(true);
      });

      expect(screen.getByRole("grid")).toHaveClass("min-w-0");
      expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    });
  }
);

it("places the persistent Branch favorite before the grouped lead and toggles it", async () => {
  viewportStub = stubResponsiveNarrowViewport(false);
  const user = userEvent.setup();
  const item = { ...ROW, artifactId: "branch-artifact-id" };
  const onChange = vi.fn();
  const favorites: ProductGridFavoriteController<BranchRow> = {
    favoriteIds: new Set<string>(),
    getArtifactId: (row) => row.artifactId,
    getItemLabel: (row) => row.branchName,
    onChange,
  };
  const groups = [{ key: "ada", label: "Ada", items: [item] }];
  const result = renderGrid({ favorites, groups, items: [], mode: "expanded" });
  const row = result.container.querySelector<HTMLDivElement>(
    `[data-grid-row-id="${item.id}"]`
  );
  expect(
    row?.style.gridTemplateColumns.startsWith(
      `${PINNED_LEAD_UTILITY_TRACK_WIDTH} `
    )
  ).toBe(true);
  expect(row?.querySelector('[role="gridcell"]')).toHaveAttribute(
    "aria-colindex",
    "1"
  );
  await user.click(
    screen.getByRole("button", {
      name: `Add ${item.branchName} to favorites`,
    })
  );
  expect(onChange).toHaveBeenCalledWith(item, true);

  result.rerender(
    withFlags(
      <Grid
        favorites={{ ...favorites, favoriteIds: new Set([item.artifactId]) }}
        groups={groups}
        items={[]}
        mode="expanded"
      />
    )
  );
  await user.click(
    screen.getByRole("button", {
      name: `Remove ${item.branchName} from favorites`,
    })
  );
  expect(onChange).toHaveBeenLastCalledWith(item, false);
});

it("loads connected favorites for nested grouped rows with no flat items", () => {
  viewportStub = stubResponsiveNarrowViewport(false);
  const item = { ...ROW, artifactId: "branch-artifact" };
  const favorites: ProductGridFavoriteController<BranchRow> = {
    favoriteIds: new Set<string>(),
    getArtifactId: (row) => row.artifactId,
    getItemLabel: (row) => row.branchName,
    onChange: vi.fn(),
  };
  useBranchFavoritesControllerMock.mockReturnValue(favorites);
  const groups = [
    {
      key: "repository",
      label: "Repository",
      items: [],
      subgroups: [{ key: "owner", label: "Owner", items: [item] }],
    },
  ];
  const result = render(
    withFlags(
      <ApiAdapterProvider
        adapter={{ resolveApiOrigin: () => "http://localhost:3002" }}
      >
        <Grid groups={groups} items={[]} mode="expanded" />
      </ApiAdapterProvider>
    )
  );

  expect(useBranchFavoritesControllerMock).toHaveBeenCalled();
  const row = result.container.querySelector(`[data-grid-row-id="${item.id}"]`);
  expect(row).not.toBeNull();
  expect(
    within(row as HTMLElement).getByRole("button", {
      name: `Add ${item.branchName} to favorites`,
    })
  ).toBeVisible();
});

it("keeps the favorite column on a page with no artifact ids", () => {
  viewportStub = stubResponsiveNarrowViewport(false);
  useBranchFavoritesControllerMock.mockReturnValue({
    favoriteIds: new Set<string>(),
    getArtifactId: (row: BranchRow) => row.artifactId,
    getItemLabel: (row: BranchRow) => row.branchName,
    onChange: vi.fn(),
  });
  const legacy = { ...ROW, artifactId: undefined };
  const result = render(
    withFlags(
      <ApiAdapterProvider
        adapter={{ resolveApiOrigin: () => "http://localhost:3002" }}
      >
        <Grid items={[legacy]} mode="expanded" />
      </ApiAdapterProvider>
    )
  );

  expect(
    result.getByRole("columnheader", {
      name: PRODUCT_GRID_FAVORITE_COLUMN_LABEL,
    })
  ).toBeInTheDocument();
  expect(
    result.queryByRole("button", {
      name: `Add ${legacy.branchName} to favorites`,
    })
  ).toBeNull();
});

describe("[DT-02][DT-07][DT-16] BranchesGridV2 narrow list", () => {
  it("lets the outer surface mode override a disagreeing inner measurement", () => {
    viewportStub = stubResponsiveNarrowViewport(true);
    renderGrid({ mode: "expanded" });
    expect(screen.getByRole("grid")).toHaveClass("min-w-fit");
    expect(screen.getAllByRole("columnheader").length).toBeGreaterThan(1);

    cleanup();
    viewportStub.setNarrow(false);
    renderGrid({ mode: "compact" });
    expect(screen.getByRole("grid")).toHaveClass("min-w-0");
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
    expect(document.querySelectorAll("dl")).toHaveLength(0);
  });

  it("keeps the narrow projection through a data refresh", () => {
    viewportStub = stubResponsiveNarrowViewport(true);
    const view = renderGrid();

    view.rerender(
      withFlags(
        <Grid
          items={[
            {
              ...ROW,
              branchName: "feature/refreshed",
              id: "acme%2Fapp::feature-refreshed",
            },
          ]}
        />
      )
    );

    expect(
      screen.getByRole("link", { name: RE_REFRESHED_ROW_LINK })
    ).toBeVisible();
    expect(screen.getByRole("grid")).toHaveClass("min-w-0");
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
  });

  it("keeps selected empty fields in saved order and states Status once with the rollout off", () => {
    restoreContainerWidth = stubContainerWidthPx(CARD_WIDTH_PX);
    render(
      withFlags(
        <Grid
          columnOrder={[
            "pr",
            "owner",
            "collaborators",
            "sessions",
            "status",
            "tags",
          ]}
          mode="compact"
          visibleColumns={EMPTY_FIELD_COLUMNS}
        />,
        [],
        false
      )
    );

    const terms = Array.from(document.querySelectorAll("dt")).map(
      (term) => term.textContent
    );
    expect(terms).toEqual([
      "Pull request",
      "Owner",
      "Collaborators",
      "Linked sessions",
      "Tags",
    ]);
    expect(
      document.querySelectorAll('[data-slot="grid-empty-value"]')
    ).toHaveLength(4);
    expect(screen.getAllByText(STATUS_LABEL)).toHaveLength(1);
    expect(
      screen.queryByText(branchColumnLabel("status"))
    ).not.toBeInTheDocument();
  });

  it("does not resurrect Status when the reader hides it with the rollout off", () => {
    restoreContainerWidth = stubContainerWidthPx(CARD_WIDTH_PX);
    render(
      withFlags(
        <Grid
          mode="compact"
          visibleColumns={new Set(["owner", "collaborators", "sessions", "pr"])}
        />,
        [],
        false
      )
    );

    expect(screen.queryByText(STATUS_LABEL)).not.toBeInTheDocument();
    expect(
      screen.queryByText(branchColumnLabel("status"))
    ).not.toBeInTheDocument();
  });

  it("preserves the original flags-off card header structure and spacing", () => {
    restoreContainerWidth = stubContainerWidthPx(CARD_WIDTH_PX);
    const view = render(withFlags(<Grid mode="compact" />, [], false));

    const visibleStatusHeader = document.querySelector(
      '[data-slot="card-header"] > div'
    );
    expect(visibleStatusHeader?.children).toHaveLength(2);
    expect(visibleStatusHeader?.lastElementChild).toHaveClass("shrink-0");
    expect(visibleStatusHeader?.lastElementChild).not.toHaveClass("flex");

    view.rerender(
      withFlags(
        <Grid mode="compact" visibleColumns={new Set(["owner", "pr"])} />,
        [],
        false
      )
    );

    const hiddenStatusHeader = document.querySelector(
      '[data-slot="card-header"] > div'
    );
    expect(hiddenStatusHeader?.children).toHaveLength(1);
  });

  it("keeps cards through a data refresh without mounting the grid when rollout off", () => {
    restoreContainerWidth = stubContainerWidthPx(CARD_WIDTH_PX);
    const view = render(withFlags(<Grid mode="compact" />, [], false));

    view.rerender(
      withFlags(
        <Grid
          items={[
            {
              ...ROW,
              branchName: "feature/refreshed",
              id: "acme%2Fapp::feature-refreshed",
            },
          ]}
          mode="compact"
        />,
        [],
        false
      )
    );

    expect(
      screen.getByRole("link", { name: RE_REFRESHED_ROW_LINK })
    ).toBeVisible();
    expect(screen.queryByRole("grid")).toBeNull();
    expect(document.querySelectorAll("dl")).toHaveLength(1);
  });

  it("preserves grouped disclosure and collapse behavior", async () => {
    viewportStub = stubResponsiveNarrowViewport(true);
    const user = userEvent.setup();
    renderGrid({
      groups: [{ key: "ada", label: "Ada", items: [ROW] }],
      items: [],
    });

    const disclosure = screen.getByRole("button", {
      expanded: true,
      name: "Ada",
    });
    expect(screen.getByRole("link", { name: RE_ROW_LINK })).toBeInTheDocument();

    await user.click(disclosure);

    expect(
      screen.getByRole("button", { expanded: false, name: "Ada" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: RE_ROW_LINK })
    ).not.toBeInTheDocument();

    act(() => {
      viewportStub?.setNarrow(false);
    });

    expect(screen.getByRole("grid")).toHaveClass("min-w-fit");
    expect(
      screen.getByRole("button", { expanded: false, name: "Ada" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: RE_ROW_LINK })
    ).not.toBeInTheDocument();

    act(() => {
      viewportStub?.setNarrow(true);
    });

    expect(screen.getByRole("grid")).toHaveClass("min-w-0");
    expect(
      screen.getByRole("button", { expanded: false, name: "Ada" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: ROW.branchName })
    ).not.toBeInTheDocument();
  });

  it("keeps the mainline wide layout while the rollout flag is off", () => {
    viewportStub = stubResponsiveNarrowViewport(true);
    render(withFlags(<Grid mode="compact" />, [], false));

    expect(screen.queryByRole("grid")).toBeNull();
    expect(document.querySelectorAll("[data-grid-card-id]")).toHaveLength(1);
    expect(document.querySelectorAll("dl")).toHaveLength(1);
  });

  it("keeps the captured-main cards without a feature-flag provider", () => {
    viewportStub = stubResponsiveNarrowViewport(true);
    render(withNavigation(<Grid mode="compact" />));

    expect(screen.queryByRole("grid")).toBeNull();
    expect(document.querySelectorAll("[data-grid-card-id]")).toHaveLength(1);
    expect(screen.getByRole("link", { name: RE_ROW_LINK })).toBeVisible();
  });

  it("keeps the AwaitingSync spinner ahead of lifecycle status in the flag-on narrow row", () => {
    viewportStub = stubResponsiveNarrowViewport(true);
    const awaiting = {
      ...ROW,
      dataState: BranchDataState.AwaitingSync,
    };
    renderGrid({ items: [awaiting] });

    const link = screen.getByRole("link", {
      name: RE_SYNCING_ROW_LINK,
    });
    expect(link.querySelector("svg.animate-spin")).toHaveAttribute(
      "aria-hidden",
      "true"
    );
    expect(link.querySelectorAll("svg")).toHaveLength(1);
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
  });

  // ISS-12959 (2026-10-19 operator Asana observation): the narrow row is the
  // status icon and title; Tags stay in the wide view only.
  it("renders no tag text in the flag-on narrow row", () => {
    viewportStub = stubResponsiveNarrowViewport(true);
    renderGrid({
      items: [
        {
          ...ROW,
          tagAvailability: BranchTagAvailability.Available,
          tags: [{ color: TagColor.Blue, id: "tag-1", name: "compact-tag" }],
        },
      ],
    });

    expect(screen.queryByText("compact-tag")).toBeNull();
    expect(screen.getAllByRole("columnheader")).toHaveLength(1);
  });
});

function renderGrid({
  columnOrder,
  enabledFlags = [],
  favorites,
  groups,
  items = [ROW],
  mode,
  visibleColumns = ALL_VISIBLE_COLUMNS,
}: {
  columnOrder?: readonly string[];
  enabledFlags?: readonly string[];
  favorites?: ProductGridFavoriteController<BranchRow>;
  groups?: GridTableV2Group<BranchRow>[];
  items?: BranchRow[];
  mode?: "compact" | "expanded";
  visibleColumns?: Set<string>;
} = {}) {
  return render(
    withFlags(
      <Grid
        columnOrder={columnOrder}
        favorites={favorites}
        groups={groups}
        items={items}
        mode={mode}
        visibleColumns={visibleColumns}
      />,
      enabledFlags
    )
  );
}

function withFlags(
  child: ReactNode,
  enabledFlags: readonly string[] = [],
  responsiveNarrowEnabled = true
) {
  const flags = responsiveNarrowEnabled
    ? [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY, ...enabledFlags]
    : [...enabledFlags];
  return (
    <NavigationProvider adapter={createMemoryNavigation().adapter}>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: flags,
        })}
      >
        {child}
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
}

function withNavigation(child: ReactNode) {
  return (
    <NavigationProvider adapter={createMemoryNavigation().adapter}>
      {child}
    </NavigationProvider>
  );
}

function Grid({
  columnOrder,
  favorites,
  groups,
  items = [ROW],
  mode,
  visibleColumns = ALL_VISIBLE_COLUMNS,
}: {
  columnOrder?: readonly string[];
  favorites?: ProductGridFavoriteController<BranchRow>;
  groups?: GridTableV2Group<BranchRow>[];
  items?: BranchRow[];
  mode?: "compact" | "expanded";
  visibleColumns?: Set<string>;
}) {
  return (
    <BranchesGridV2
      allRows={groups ? groups.flatMap((group) => group.items) : items}
      columnOrder={columnOrder}
      columnSpecs={APPROVED_BRANCH_COLUMN_SPECS}
      favorites={favorites}
      getBranchHref={(item) => `/branches/${item.id}`}
      groups={groups}
      items={items}
      mode={mode}
      onSort={() => undefined}
      sortBy="lastActivity"
      sortDir="desc"
      tagsReadOnly
      visibleColumns={visibleColumns}
    />
  );
}
