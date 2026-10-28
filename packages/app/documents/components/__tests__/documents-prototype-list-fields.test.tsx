// @vitest-environment jsdom

import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import { ArtifactList } from "@repo/app/artifacts/components/artifact-list";
import type {
  ArtifactListHostRendering,
  ArtifactListShellController,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import { ArtifactListToolbar } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-sections";
import { ArtifactKind } from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { render as renderWithNav } from "@repo/app/shared/test-fixtures/render-with-nav";
import type { FilterRangeGroup } from "@repo/design-system/components/ui/table-filters";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  controller: undefined as ArtifactListShellController | undefined,
  host: undefined as ArtifactListHostRendering | undefined,
}));
vi.mock("@repo/app/shared/hooks/use-artifact-collaborators", () => ({
  useArtifactCollaborators: () => ({ data: new Map(), isLoading: false }),
}));
vi.mock("../../hooks/use-favorite-artifact-ids", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../hooks/use-favorite-artifact-ids")
  >()),
  usePendingFavoriteArtifactIds: () => new Set<string>(),
}));
vi.mock("../../hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({
    data: [],
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn() }),
}));
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({
    data: { id: "user-1", firstName: "Ada", lastName: "Lovelace" },
    isPending: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("../../hooks/use-documents", () => ({
  useDocuments: () => ({
    data: [],
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useUpdateDocument: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));
vi.mock("../../hooks/use-related-sessions", () => ({
  useRelatedSessionsPage: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("@repo/app/artifacts/components/artifact-summary", () => ({
  ArtifactSummary: () => null,
}));
vi.mock("../documents-prototype-custom-fields", () => ({
  useDocumentsPrototypeCustomFields: () => ({
    columns: [],
    renderCell: () => undefined,
    renderDialog: () => null,
  }),
  documentCustomFieldCreationValues: () => ({}),
}));
vi.mock("@repo/app/shared/hooks/use-sort-params", () => ({
  useSortParams: () => ({
    sortBy: null,
    sortDir: "asc",
    setSort: vi.fn(),
    clearSort: vi.fn(),
  }),
}));
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => path,
}));
vi.mock(
  "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-shells",
  () => ({
    GenericArtifactListView: ({
      controller,
      host,
    }: {
      controller: ArtifactListShellController;
      host: ArtifactListHostRendering;
    }) => {
      captured.controller = controller;
      captured.host = host;
      return null;
    },
  })
);

// ISS-12641: the toolbar hands its range facets to whichever range submenu the
// `gridview-adoption` flag selects. The filter menu stays real and
// additionally renders that callback for one synthetic range group, so the
// sentinel below shows which family the toolbar chose.
const SENTINEL_RANGE_GROUP: FilterRangeGroup = {
  kind: "range",
  id: "sentinel-range",
  label: "Sentinel range",
  onChange: () => undefined,
};
vi.mock(
  "@repo/design-system/components/ui/filter-popover",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/design-system/components/ui/filter-popover")
      >();
    function FilterPopoverWithRangeProbe(
      props: ComponentProps<typeof actual.FilterPopover>
    ) {
      return (
        <>
          <actual.FilterPopover {...props} />
          {props.renderRangeSubmenu?.(SENTINEL_RANGE_GROUP, "Clear")}
        </>
      );
    }
    return { ...actual, FilterPopover: FilterPopoverWithRangeProbe };
  }
);
vi.mock(
  "@repo/design-system/components/ui/filter-range-submenu",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/design-system/components/ui/filter-range-submenu")
    >()),
    RangeSubmenu: () => <div data-testid="champion-range-submenu" />,
  })
);
vi.mock(
  "@repo/design-system/components/ui/filter-range-submenu-v2",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@repo/design-system/components/ui/filter-range-submenu-v2")
    >()),
    RangeSubmenu: () => <div data-testid="fork-range-submenu" />,
  })
);

const PROTOTYPE_ONLY_COLUMN_IDS = ["approval"];
const FAVORITE_TRACK = /^36px /;
const ADD_FILTER_BUTTON = /^Add filter$/;
const TYPE_MENU_ITEM = /^Type/;
const OWNER_MENU_ITEM = /^Owner/;
const STATUS_BUTTON = /Drafting$/;

function mountController(
  issue = false,
  enabledFlags: readonly string[] = []
): ArtifactListShellController {
  render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <ArtifactList
        artifactKind={issue ? ArtifactKind.Issue : ArtifactKind.Document}
        documents={[
          createMockDocument({
            id: "document-1",
            ...(issue
              ? {
                  type: DocumentType.Feature,
                  slug: "ISS-1",
                  status: IssueStatus.Backlog,
                }
              : {}),
          }),
        ]}
        editHandlers={{}}
        filterText=""
        isError={false}
        isFetching={false}
        isLoading={false}
        isServerPaged={false}
        onFilterTextChange={vi.fn()}
        refetch={vi.fn()}
        searchAppliedUpstream={false}
        searchParams={{}}
        setScrollContainer={vi.fn()}
        sortPersistenceKey={null}
        storageKey={null}
      />
    </FeatureFlagAdapterProvider>
  );
  if (!captured.controller) {
    throw new Error("GenericArtifactListView was not rendered");
  }
  return captured.controller;
}

beforeEach(() => {
  captured.controller = undefined;
  captured.host = undefined;
  localStorage.clear();
});

describe("documents universal list offered fields", () => {
  it("uses the compact editable status control in the narrow production lead", () => {
    const controller = mountController();
    const artifact = controller.artifacts[0];
    if (!(artifact && captured.host?.renderLead)) {
      throw new Error("Document lead was not configured");
    }

    renderWithNav(
      <div>{captured.host.renderLead(artifact, { isNarrowList: true })}</div>
    );

    expect(screen.getByRole("button", { name: STATUS_BUTTON })).toHaveClass(
      "h-7",
      "w-7"
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("link")).toHaveClass("flex-1");
    expect(screen.getByText(artifact.title)).toHaveClass(
      "min-w-0",
      "flex-1",
      "truncate"
    );
  });

  it("offers no column without a backing field on a Document", () => {
    const ids = mountController().configuredColumns.map((column) => column.id);
    for (const id of PROTOTYPE_ONLY_COLUMN_IDS) {
      expect(ids).not.toContain(id);
    }
    expect(ids).toContain("document-type");
  });

  it("presents the document subtype as Type across sort, group and filter", () => {
    const type = mountController().configuredColumns.find(
      (column) => column.id === "document-type"
    );
    expect(type).toMatchObject({
      label: "Type",
      sortable: true,
      groupable: true,
      filterable: true,
    });
  });

  it("withholds the artifact-kind Type facet from the filter menu", () => {
    expect(mountController().filterViewModel.hidePriority).toBe(true);
  });

  it("withholds the artifact-kind Type facet from the active-filter bar's add menu", () => {
    const controller = mountController();
    render(
      <ArtifactListToolbar
        controller={{ ...controller, filtersActive: true }}
      />
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: ADD_FILTER_BUTTON }),
      { button: 0, ctrlKey: false }
    );
    const menu = screen.getByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: OWNER_MENU_ITEM })
    ).toBeInTheDocument();
    // The built-in artifact-kind facet and the subtype facet share the Type
    // label, so the add menu must offer exactly one of them.
    expect(controller.filterViewModel.labels?.priority).toMatch(TYPE_MENU_ITEM);
    expect(
      within(menu).getAllByRole("menuitem", { name: TYPE_MENU_ITEM })
    ).toHaveLength(1);
  }, 30_000);
});

describe("Issue specialization of the Documents list", () => {
  it("defaults to all time, uses Issue status authority, and prunes prototype enumerations", () => {
    const controller = mountController(true);
    expect(controller.dateDimension).toMatchObject({
      present: true,
      range: "all",
    });
    const ids = controller.configuredColumns.map((column) => column.id);
    expect(ids).toContain("priority");
    expect(ids).toContain("project");
    expect(ids).toContain("collaborators");
    expect(controller.columnLayout.gridTemplateColumns).toMatch(FAVORITE_TRACK);
    expect(controller.inlineCreate).toMatchObject({
      enabled: true,
      label: "Add New Issue",
    });
    for (const id of ["sprint", "estimate", "dependencies", "document-type"]) {
      expect(ids).not.toContain(id);
    }
    expect(controller.artifacts[0]).toMatchObject({
      kind: ArtifactKind.Issue,
      statusRaw: IssueStatus.Backlog,
    });
    expect(
      controller.summaryMetricDefinitions.map((metric) => metric.label)
    ).toEqual([
      "Issues",
      "Est. Total",
      "Median token cost",
      "Produced by sessions",
      "Updated this week",
    ]);
  });
});

describe("ISS-12641 gridview-adoption on the artifact list toolbar", () => {
  it.each([
    ["closed", false, "fork"],
    ["open", true, "champion"],
  ] as const)(
    "renders the %s family's range submenu",
    (_name, enabled, family) => {
      const controller = mountController();
      cleanup();
      render(
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({
            enabledFlags: enabled ? [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY] : [],
          })}
        >
          <ArtifactListToolbar controller={controller} />
        </FeatureFlagAdapterProvider>
      );
      const other = family === "fork" ? "champion" : "fork";
      expect(screen.getByTestId(`${family}-range-submenu`)).toBeInTheDocument();
      expect(screen.queryByTestId(`${other}-range-submenu`)).toBeNull();
    }
  );
});

describe("ISS-13035 gridview-adoption gates the shared toolbar on Documents and Issues", () => {
  it.each([
    ["Documents", false],
    ["Issues", true],
  ])(
    "GV-TOOLBAR-1 %s hands the shell no shared toolbar while gridview-adoption is off",
    (_name, issue) => {
      mountController(issue);
      expect(captured.host?.renderSharedToolbar).toBeUndefined();
    }
  );

  it.each([
    ["Documents", false],
    ["Issues", true],
  ])(
    "GV-TOOLBAR-2 %s hands the shell a shared toolbar once gridview-adoption is on",
    (_name, issue) => {
      mountController(issue, [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]);
      expect(captured.host?.renderSharedToolbar).toBeTypeOf("function");
    }
  );

  it("GV-TOOLBAR-3 renders the plain Filter items input and the Filters button while gridview-adoption is off", () => {
    const controller = mountController();
    const host = captured.host;
    cleanup();
    render(<ArtifactListToolbar controller={{ ...controller, host }} />);
    const input = screen.getByRole("textbox", { name: "Filter items" });
    expect(input).toHaveAttribute("placeholder", "Filter items...");
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
  });
});
