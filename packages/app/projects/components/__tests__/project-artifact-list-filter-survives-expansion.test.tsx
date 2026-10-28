import { ARTIFACT_STATUS_DETAIL } from "@repo/api/src/types/artifact-status";
import { HIERARCHY_EXPANDED_PARAM } from "@repo/app/shared/lib/hierarchy-expanded-param";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { createLaggingNavigation } from "../../../shared/test-fixtures/lagging-navigation";
import {
  artifact,
  childArtifact,
  currentProjectArtifactListView as currentView,
  firstId,
  mountProjectArtifactList as mount,
  projectArtifactListMocks,
  projectId,
  resetProjectArtifactListMocks,
  secondId,
  tree,
} from "./support/project-artifact-list-live-harness";

const mocks = projectArtifactListMocks();
// Each case drives Radix menus through a full list mount, which runs past the 5s
// default on a loaded box.
const UI_TEST_TIMEOUT_MS = 30_000;
const STATUS_OPTION = /^(To Do|Todo)/;

const hierarchyTree = {
  ...tree,
  hierarchy: {
    contractVersion: 1,
    capabilities: {
      childPaging: false,
      exactPlacement: true,
      maxVisibleLevels: 4,
      mutationVersion: "version-from-rendered-tree",
    },
    diagnostics: [],
    diagnosticsComplete: true,
  },
};

function lastReplacedParams(replacedHrefs: readonly string[]) {
  return new URL(replacedHrefs.at(-1) ?? "", "http://localhost").searchParams;
}

beforeEach(resetProjectArtifactListMocks);

describe("Project Detail artifact list filters and linked hierarchy expansion", {
  timeout: UI_TEST_TIMEOUT_MS,
}, () => {
  it("AC-1: Applying a filter facet value on Project Detail's artifact list keeps the filter applied and present in the URL", () => {
    mocks.flagEnabled = true;
    const navigation = mountLagging("group=none", hierarchyTree);

    act(() => {
      currentView().controller.setFilters({
        ...currentView().controller.filters,
        owners: ["ada"],
      });
    });
    act(() => {
      currentView().controller.hierarchyView.toggleExpanded(firstId);
    });
    act(() => navigation.landReplaces());

    const last = lastReplacedParams(navigation.replacedHrefs);
    expect(last.get("owners")).toBe("ada");
    expect(last.getAll(HIERARCHY_EXPANDED_PARAM)).toEqual([firstId]);
    expect(currentView().controller.filters.owners).toEqual(["ada"]);
  });

  it("AC-1: Picking a Status filter through the Filters menu survives the automatic expansion of the matching path, in the URL and in the list", async () => {
    mocks.flagEnabled = true;
    mocks.realView = true;
    const childId = "88888888-8888-4888-8888-888888888888";
    const nestedTree = {
      ...hierarchyTree,
      nodes: [
        {
          root: artifact(firstId, "First"),
          children: [childArtifact(childId, "Child", firstId, 1)],
        },
        {
          root: { ...artifact(secondId, "Second"), status: "IN_PROGRESS" },
          children: [],
        },
      ],
    };
    const navigation = mountLagging("group=none", nestedTree);
    const user = userEvent.setup();

    await user.click(screen.getAllByRole("button", { name: "Filters" })[0]);
    await user.click(await screen.findByRole("menuitem", { name: "Status" }));
    await user.click(
      await screen.findByRole("menuitem", { name: STATUS_OPTION })
    );
    await user.keyboard("{Escape}{Escape}");
    act(() => navigation.landReplaces());

    await waitFor(() =>
      expect(currentView().controller.filters.statuses).toHaveLength(1)
    );
    const last = lastReplacedParams(navigation.replacedHrefs);
    expect(last.get("statuses")).not.toBeNull();
    expect(last.getAll(HIERARCHY_EXPANDED_PARAM)).toEqual([firstId]);
    expect(currentView().controller.filters.statuses).toHaveLength(1);
  });

  it("AC-4: Collapsing a parent while a filter keeps it open settles instead of re-rendering without end, while the router reflects each write late", async () => {
    mocks.flagEnabled = true;
    mocks.realView = true;
    const childId = "88888888-8888-4888-8888-888888888888";
    const nestedTree = {
      ...hierarchyTree,
      nodes: [
        {
          root: artifact(firstId, "First"),
          children: [childArtifact(childId, "Child", firstId, 1)],
        },
        {
          root: { ...artifact(secondId, "Second"), status: "IN_PROGRESS" },
          children: [],
        },
      ],
    };
    const navigation = mountLagging("group=none&statuses=todo", nestedTree);
    const landing = setInterval(() => act(() => navigation.landReplaces()), 2);
    const row = screen.getAllByText("First")[0]?.closest("[data-grid-row]");

    try {
      await userEvent.setup().click(
        within(row as HTMLElement).getByRole("button", {
          name: "Collapse row",
        })
      );
      await waitFor(() =>
        expect(navigation.replacedHrefs.length).toBeGreaterThan(1)
      );
    } finally {
      clearInterval(landing);
    }

    expect(navigation.replacedHrefs.length).toBeLessThan(10);
    expect(
      lastReplacedParams(navigation.replacedHrefs).get("statuses")
    ).not.toBeNull();
  });

  it("AC-1: After a Status filter and its automatic expansion, switching to the Board layout still writes layout to the URL and keeps the filter and the expansion", async () => {
    mocks.flagEnabled = true;
    mocks.realView = true;
    const childId = "88888888-8888-4888-8888-888888888888";
    const nestedTree = {
      ...hierarchyTree,
      nodes: [
        {
          root: artifact(firstId, "First"),
          children: [childArtifact(childId, "Child", firstId, 1)],
        },
        {
          root: { ...artifact(secondId, "Second"), status: "IN_PROGRESS" },
          children: [],
        },
      ],
    };
    const navigation = mountLagging("group=none", nestedTree);
    const landing = setInterval(() => act(() => navigation.landReplaces()), 3);
    const user = userEvent.setup();

    try {
      await user.click(screen.getAllByRole("button", { name: "Filters" })[0]);
      await user.click(await screen.findByRole("menuitem", { name: "Status" }));
      await user.click(
        await screen.findByRole("menuitem", { name: STATUS_OPTION })
      );
      await user.keyboard("{Escape}{Escape}");
      await waitFor(() =>
        expect(
          new URLSearchParams(navigation.getCurrentHref().split("?")[1]).getAll(
            HIERARCHY_EXPANDED_PARAM
          )
        ).toEqual([firstId])
      );
      await user.click(screen.getAllByRole("radio", { name: "Board view" })[0]);
      await waitFor(() =>
        expect(
          new URLSearchParams(navigation.getCurrentHref().split("?")[1]).get(
            "layout"
          )
        ).toBe("board")
      );
    } finally {
      clearInterval(landing);
    }

    const landed = new URLSearchParams(
      navigation.getCurrentHref().split("?")[1]
    );
    expect(landed.get("statuses")).not.toBeNull();
    expect(landed.getAll(HIERARCHY_EXPANDED_PARAM)).toEqual([firstId]);
    expect(currentView().controller.filters.statuses).toHaveLength(1);
  });

  it("R16: An outside navigation to another Status filter is applied and never overwritten with the previous filter", async () => {
    mocks.flagEnabled = true;
    const mounted = ARTIFACT_STATUS_DETAIL.DocumentDrafting;
    const navigated = ARTIFACT_STATUS_DETAIL.DocumentApproved;
    const navigation = mountLagging(
      `group=none&statuses=${mounted}`,
      hierarchyTree
    );
    await waitFor(() =>
      expect(currentView().controller.filters.statuses).toEqual([mounted])
    );
    const replacedBefore = navigation.replacedHrefs.length;

    act(() =>
      navigation.navigate(
        `/teams/team/projects/${projectId}?group=none&statuses=${navigated}`
      )
    );
    await waitFor(() =>
      expect(currentView().controller.filters.statuses).toEqual([navigated])
    );
    act(() => navigation.landReplaces());

    expect(currentView().controller.filters.statuses).toEqual([navigated]);
    for (const href of navigation.replacedHrefs.slice(replacedBefore)) {
      expect(new URLSearchParams(href.split("?")[1]).get("statuses")).not.toBe(
        mounted
      );
    }
  });
});

function mountLagging(
  query: string,
  source: Parameters<typeof mount>[1]
): ReturnType<typeof createLaggingNavigation> {
  let lagging: ReturnType<typeof createLaggingNavigation> | undefined;
  mount(query, source, "all", (initialPath) => {
    lagging = createLaggingNavigation(initialPath);
    return lagging;
  });
  if (!lagging) {
    throw new Error("The lagging navigation was not created");
  }
  return lagging;
}
