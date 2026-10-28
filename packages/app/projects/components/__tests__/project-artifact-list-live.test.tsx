import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
} from "@repo/api/src/types/project-artifact-placement";
import { TagColor } from "@repo/api/src/types/tag";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifact,
  type BoardProps,
  childArtifact,
  currentProjectArtifactListView as currentView,
  firstId,
  type ListViewProps,
  mountProjectArtifactList as mount,
  project,
  projectArtifactListMocks,
  projectId,
  resetProjectArtifactListMocks,
  secondId,
  tree,
} from "./support/project-artifact-list-live-harness";

const mocks = projectArtifactListMocks();

beforeEach(resetProjectArtifactListMocks);

// The kind icon `GenericArtifactLead` draws before every title.
const KIND_ICON_SELECTOR = 'svg[class*="size-3.5"]';

describe("ProjectArtifactList production wiring", () => {
  it("moves a flag-off selected set in one hierarchy transaction, not the gated placement route", async () => {
    mount();
    act(() =>
      currentView().controller.setSelectedArtifactIds(
        new Set([firstId, secondId])
      )
    );
    const actions = currentView().host.bulkActions;
    if (
      !isValidElement<{ onMove: (projectId: string) => Promise<unknown> }>(
        actions
      )
    ) {
      throw new Error("Expected bulk move actions");
    }
    expect(
      render(actions).getByRole("button", { name: "Move to project" })
    ).toBeEnabled();
    const targetProjectId = "66666666-6666-4666-8666-666666666666";

    await act(() => actions.props.onMove(targetProjectId));

    expect(mocks.hierarchyTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.hierarchyTransaction).toHaveBeenCalledWith({
      artifactIds: [firstId, secondId],
      targetProjectId,
      placement: "end",
      source: ProjectArtifactPlacementSource.Api,
      sourceRevision: "hierarchy-from-rendered-tree",
    });
    expect(mocks.placement).not.toHaveBeenCalled();
    expect(currentView().controller.selectedArtifactIds.size).toBe(0);
  });

  it("mounts the PRD-724 board on the portable path when manual ordering is on", () => {
    mocks.flagEnabled = true;
    mocks.realView = true;
    mount("group=status&layout=board");
    expect(screen.getByTestId("project-artifact-board")).toBeInTheDocument();
    expect(
      screen.getAllByRole("radiogroup", { name: "Artifact layout" })
    ).toHaveLength(2);
    expect(screen.getAllByRole("radio", { name: "Board view" })).toHaveLength(
      2
    );
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Options" })).toBeInTheDocument();
    expect(mocks.portableBoard).toHaveBeenCalledWith(
      expect.objectContaining({ project, teamId: "team" })
    );
    // ISS-12929 724-F4: the board's card fields follow the list's Options.
    const boardProps = mocks.portableBoard.mock.calls.at(-1)?.[0] as {
      toolbar?: { filters?: unknown; search?: string };
      visibleColumnIds?: ReadonlySet<string>;
    };
    // ISS-12929: and the board reads the list's own filters and search.
    expect(boardProps.toolbar).toEqual(
      expect.objectContaining({
        filters: expect.objectContaining({ kinds: [], owners: [] }),
        search: "",
      })
    );
    expect([...(boardProps.visibleColumnIds ?? [])]).toEqual(
      expect.arrayContaining([
        "collaborators",
        "comments",
        "currentVersion",
        "relatedSessions",
      ])
    );
    expect(mocks.board).not.toHaveBeenCalled();
  });

  it("preserves a tag group target in the atomic placement request", () => {
    mocks.flagEnabled = true;
    const blueTagId = "77777777-7777-4777-8777-777777777777";
    const source = {
      ...tree,
      nodes: [
        tree.nodes[0]!,
        {
          ...tree.nodes[1]!,
          root: {
            ...tree.nodes[1]!.root,
            tags: [{ id: blueTagId, name: "Blue", color: TagColor.Blue }],
          },
        },
      ],
    };
    mount("group=tags", source);

    act(() => currentView().controller.applyGroupDrop(firstId, "tags", "Blue"));

    expect(mocks.placement).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceArtifactIds: [firstId],
        rootUpdates: { tagIds: [blueTagId] },
      })
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("writes a flag-off tag group move and its requested edge in one hierarchy transaction", () => {
    const redTagId = "77777777-7777-4777-8777-777777777777";
    const blueTagId = "88888888-8888-4888-8888-888888888888";
    mount("group=tags", {
      ...tree,
      nodes: [
        {
          ...tree.nodes[0]!,
          root: {
            ...tree.nodes[0]!.root,
            tags: [{ id: redTagId, name: "Red", color: TagColor.Red }],
          },
        },
        {
          ...tree.nodes[1]!,
          root: {
            ...tree.nodes[1]!.root,
            tags: [{ id: blueTagId, name: "Blue", color: TagColor.Blue }],
          },
        },
      ],
    });

    act(() =>
      currentView().controller.applyGroupDrop(
        firstId,
        "tags",
        "Blue",
        undefined,
        undefined,
        "start"
      )
    );
    expect(mocks.hierarchyTransaction).toHaveBeenCalledWith({
      artifactIds: [firstId],
      placement: "start",
      rootUpdates: { tagIds: [blueTagId] },
      source: ProjectArtifactPlacementSource.Pointer,
      sourceRevision: "hierarchy-from-rendered-tree",
    });
    expect(mocks.applyTag).not.toHaveBeenCalled();
    expect(mocks.removeTag).not.toHaveBeenCalled();
    expect(mocks.placement).not.toHaveBeenCalled();
  });

  it("retains the main summary, inline-create, selection, and hierarchy host while the flag is off", () => {
    mount();

    const view = mocks.view.mock.lastCall?.[0] as ListViewProps;
    expect(view.host.search).toBeTruthy();
    expect(view.host.summary).toBeTruthy();
    expect(view.controller.inlineCreate?.enabled).toBe(true);
    expect(view.controller.hierarchyView.enabled).toBe(true);
    expect(view.controller.manualOrderingActive).toBe(false);
    expect(mocks.capability).toHaveBeenCalledWith(projectId);
    act(() => view.controller.setSelectedArtifactIds(new Set([firstId])));
    const selectedView = mocks.view.mock.lastCall?.[0] as
      | ListViewProps
      | undefined;
    expect(selectedView?.host.bulkActions).toBeTruthy();
  });

  it("starts the manual Project Detail tree collapsed and expands its child", async () => {
    mocks.flagEnabled = true;
    mocks.realView = true;
    mount("group=none", {
      ...tree,
      nodes: [
        {
          root: artifact(firstId, "Parent"),
          children: [
            {
              ...artifact(secondId, "Child"),
              parentId: firstId,
              linkType: LinkType.Produces,
              depth: 1,
            },
          ],
        },
      ],
    });

    // The row names its artifact twice (ID and title); either text finds it.
    const parent = screen
      .getAllByText("Parent")[0]
      ?.closest<HTMLElement>("[data-grid-row]");
    if (!parent) {
      throw new Error("Expected the parent treegrid row");
    }
    expect(screen.queryByText("Child")).not.toBeInTheDocument();
    expect(parent).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(parent).getByRole("button", { name: "Expand row" }));
    await waitFor(() => expect(screen.getAllByText("Child")[0]).toBeVisible());
  });

  it("mounts exactly one polite selection region, the shell's", async () => {
    mocks.realView = true;
    mount("group=none");
    expect(
      await screen.findByPlaceholderText("Filter items...")
    ).toBeInTheDocument();

    expect(
      document.querySelectorAll('output[aria-live="polite"]')
    ).toHaveLength(1);
  });

  it("states the card identity once while retaining the editable title", async () => {
    mocks.realView = true;
    const first = tree.nodes[0]!;
    mount("group=status&layout=board", {
      ...tree,
      nodes: [
        {
          ...first,
          root: { ...first.root, name: "First issue", slug: "ISS-1" },
        },
      ],
    });
    expect(mocks.board).toHaveBeenCalled();
    const board = mocks.board.mock.lastCall?.[0] as BoardProps;
    const row = board.groups.flatMap((group) => group.items)[0];
    expect(row?.title).toBe("First issue");
    expect(row && board.onOpenHref?.(row)).toContain("ISS-1");
    expect(
      await screen.findByRole("link", { name: "First issue" })
    ).toBeInTheDocument();
    expect(screen.getAllByText("ISS-1")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Edit artifact name for ISS-1" })
    ).toBeInTheDocument();
  });

  it("shows only the root Board card and lane count after collapsing the list hierarchy", async () => {
    mocks.realView = true;
    mount("group=status&layout=board", {
      ...tree,
      nodes: [
        {
          root: artifact(firstId, "Parent"),
          children: [
            {
              ...artifact(secondId, "Child"),
              parentId: firstId,
              linkType: LinkType.Produces,
              depth: 1,
            },
          ],
        },
      ],
    });
    const controller = () => {
      const view = mocks.view.mock.lastCall?.[0] as ListViewProps | undefined;
      if (!view) {
        throw new Error("Expected the project artifact list view");
      }
      return view.controller;
    };
    await waitFor(() =>
      expect(controller().hierarchyView.isExpanded(firstId)).toBe(true)
    );
    act(() => controller().hierarchyView.toggleExpanded(firstId));
    await waitFor(() =>
      expect(controller().hierarchyView.isExpanded(firstId)).toBe(false)
    );
    const board = mocks.board.mock.lastCall?.[0] as BoardProps;
    expect(
      board.groups.flatMap((group) => group.items.map((row) => row.id))
    ).toEqual([firstId]);
    expect(
      board.groups.reduce((count, group) => count + group.items.length, 0)
    ).toBe(1);
  });

  it("routes manual-ordering Board mode to the roots-only portable board", () => {
    mocks.realView = true;
    mocks.flagEnabled = true;
    mount("group=status&layout=board", {
      ...tree,
      nodes: [
        {
          root: artifact(firstId, "Parent"),
          children: [
            {
              ...artifact(secondId, "Child"),
              parentId: firstId,
              linkType: LinkType.Produces,
              depth: 1,
            },
          ],
        },
      ],
    });
    expect(mocks.portableBoard).toHaveBeenCalledWith(
      expect.objectContaining({ project, teamId: "team" })
    );
    expect(screen.getByTestId("project-artifact-board")).toBeInTheDocument();
    expect(mocks.board).not.toHaveBeenCalled();
  });

  it("shows only roots in category Board cards and lane counts", () => {
    mocks.realView = true;
    mount(
      "group=status&layout=board",
      {
        ...tree,
        nodes: [
          {
            root: artifact(firstId, "Parent"),
            children: [
              {
                ...artifact(secondId, "Child"),
                parentId: firstId,
                linkType: LinkType.Produces,
                depth: 1,
              },
            ],
          },
        ],
      },
      "issues"
    );
    const board = mocks.board.mock.lastCall?.[0] as BoardProps;
    expect(
      board.groups.flatMap((group) => group.items.map((row) => row.id))
    ).toEqual([firstId]);
    expect(
      board.groups.reduce((count, group) => count + group.items.length, 0)
    ).toBe(1);
  });

  it("attributes a board lane status drop to the Board surface", () => {
    mocks.realView = true;
    mount("group=status&layout=board");
    const board = mocks.board.mock.lastCall?.[0] as BoardProps;
    board.onGroupDrop(firstId, "status", ARTIFACT_STATUS_ROOT.Done);
    expect(mocks.hierarchyTransaction).toHaveBeenCalledWith({
      artifactIds: [firstId],
      placement: "end",
      rootUpdates: { status: IssueStatus.Done },
      surface: ArtifactStatusEditSurface.Board,
      source: ProjectArtifactPlacementSource.Pointer,
      sourceRevision: "hierarchy-from-rendered-tree",
    });
  });

  it("does not attribute a list section status move to the Board", () => {
    mount("group=status", { ...tree, projectVersion: undefined });
    const view = mocks.view.mock.lastCall?.[0] as ListViewProps;
    act(() =>
      view.controller.applyGroupDrop(
        firstId,
        "status",
        ARTIFACT_STATUS_ROOT.Done
      )
    );
    expect(mocks.hierarchyTransaction).toHaveBeenCalledWith({
      artifactIds: [firstId],
      placement: "end",
      rootUpdates: { status: IssueStatus.Done },
      source: ProjectArtifactPlacementSource.Pointer,
      sourceRevision: "hierarchy-from-rendered-tree",
    });
  });

  it("retains one document identity when post-create placement is retried", async () => {
    mocks.flagEnabled = true;
    mocks.create.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
    });
    mocks.placement
      .mockRejectedValueOnce(new Error("Conflict"))
      .mockResolvedValueOnce({ placed: true });
    mount();
    const view = currentView();
    await act(async () => {
      await expect(
        view.controller.createInlineArtifact(
          "New follow up",
          undefined,
          firstId
        )
      ).rejects.toThrow("Conflict");
    });
    await act(async () => {
      await view.controller.createInlineArtifact(
        "New follow up",
        undefined,
        firstId
      );
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.placement).toHaveBeenCalledTimes(2);
    expect(mocks.placement).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceArtifactIds: ["44444444-4444-4444-8444-444444444444"],
        targetArtifactId: firstId,
        expectedProjectVersions: { [projectId]: tree.projectVersion },
      })
    );
  });

  it("creates from a status-group inline row without sending a placement request", async () => {
    mocks.flagEnabled = true;
    mocks.realView = true;
    const createdId = "77777777-7777-4777-8777-777777777777";
    mocks.create.mockResolvedValue({ id: createdId });
    mount("group=status");

    const view = currentView();
    expect(view.controller.groupBy).toBe("status");
    const group = view.controller.groupedArtifacts?.find((candidate) =>
      candidate.items.some((item) => item.id === firstId)
    );
    if (!group) {
      throw new Error("Expected a status group for the first issue");
    }
    act(() =>
      view.controller.setInlineDraftContext({
        afterArtifactId: firstId,
        groupKey: group.key,
      })
    );
    const input = await screen.findByRole("textbox", {
      name: "Add issue name",
    });
    fireEvent.change(input, { target: { value: "New status issue" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(currentView().controller.inlineDraftContext?.afterArtifactId).toBe(
        createdId
      )
    );
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "New status issue" })
    );
    expect(mocks.placement).not.toHaveBeenCalled();
  });

  it("filters related sessions before computing the matching metrics cohort", () => {
    const sessionId = "66666666-6666-4666-8666-666666666666";
    mount(
      `group=none&extensionFilters=${encodeURIComponent(JSON.stringify({ relatedSessions: { selectedValues: [sessionId] } }))}`
    );
    expect(mocks.matches).toHaveBeenCalledWith(
      [firstId, secondId],
      [sessionId],
      true
    );
    const view = mocks.view.mock.lastCall?.[0] as ListViewProps;
    expect(view.controller.matchingArtifacts.map((row) => row.id)).toEqual([
      secondId,
    ]);
    const summary = view.host.summary;
    expect(
      isValidElement<{ matchingArtifacts: { id: string }[] }>(summary)
    ).toBe(true);
    if (!isValidElement<{ matchingArtifacts: { id: string }[] }>(summary)) {
      throw new Error("Expected project summary");
    }
    expect(summary.props.matchingArtifacts.map((row) => row.id)).toEqual([
      secondId,
    ]);
  });

  it("keeps an active Tags filter unavailable when its source enrichment is omitted", async () => {
    mocks.realView = true;
    mount("group=none&tags=missing-tag");
    expect(
      await screen.findByRole("button", { name: "Try again" })
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Filter items...")).toBeInTheDocument();
    expect(screen.queryByText("First")).not.toBeInTheDocument();
  });

  it("routes flag-on keyboard ordering through placement with the acted-on project version", async () => {
    mocks.flagEnabled = true;
    mount();
    expect(mocks.capability).toHaveBeenCalledWith(projectId);

    const view = currentView();
    const row = view.controller.matchingArtifacts[0];
    if (!row) {
      throw new Error("Expected a rendered project artifact");
    }
    const lead = render(
      view.host.renderLead?.(row, { isNarrowList: false }) ?? null
    );
    expect(
      lead.getByRole("button", { name: `Drag to reorder ${row.slug}` })
    ).toBeInTheDocument();
    act(() => view.controller.moveArtifactManually(secondId, "up"));

    await waitFor(() =>
      expect(mocks.placement).toHaveBeenCalledWith({
        sourceArtifactIds: [secondId],
        destinationProjectId: projectId,
        position: ProjectArtifactPlacementPosition.Before,
        targetArtifactId: firstId,
        expectedProjectVersions: {
          [projectId]: "version-from-rendered-tree",
        },
        source: ProjectArtifactPlacementSource.Keyboard,
      })
    );
  });

  it("silently refuses a fifth-level keyboard nest and inside drop", () => {
    mocks.flagEnabled = true;
    const levelTwoId = "66666666-6666-4666-8666-666666666666";
    const targetId = "77777777-7777-4777-8777-777777777777";
    const sourceId = "88888888-8888-4888-8888-888888888888";
    mount("group=none", {
      ...tree,
      nodes: [
        {
          root: artifact(firstId, "Root"),
          children: [
            childArtifact(secondId, "Level two", firstId, 1),
            childArtifact(levelTwoId, "Level three", secondId, 2),
            childArtifact(targetId, "Target", levelTwoId, 3),
            childArtifact(sourceId, "Source", levelTwoId, 3),
          ],
        },
      ],
    });

    act(() => currentView().controller.hierarchyView.toggleExpanded(firstId));
    act(() => currentView().controller.hierarchyView.toggleExpanded(secondId));
    act(() =>
      currentView().controller.hierarchyView.toggleExpanded(levelTwoId)
    );
    const view = currentView();
    expect(
      view.controller.hierarchyView.rows.map((row) => row.artifact.id)
    ).toContain(sourceId);
    const source = view.controller.hierarchyView.rows.find(
      (row) => row.artifact.id === sourceId
    )?.artifact;
    const target = view.controller.hierarchyView.rows.find(
      (row) => row.artifact.id === targetId
    )?.artifact;
    if (!(source && target)) {
      throw new Error("Expected visible fourth-level rows");
    }
    expect(view.host.canHierarchyDrop?.(source, target, "inside")).toBe(false);
    act(() => view.host.onHierarchyDrop?.(source, target, "inside"));
    act(() => view.controller.moveArtifactManually(sourceId, "in"));
    expect(mocks.placement).not.toHaveBeenCalled();
  });

  it("opens the keyboard Inside target only after placement succeeds", async () => {
    mocks.flagEnabled = true;
    let completePlacement: (() => void) | undefined;
    mocks.placement.mockImplementation(
      () =>
        new Promise((resolve) => {
          completePlacement = () => resolve({ placed: true });
        })
    );
    mount();
    const view = () => mocks.view.mock.lastCall?.[0] as ListViewProps;
    expect(view().controller.hierarchyView.isExpanded(firstId)).toBe(false);

    act(() => view().controller.moveArtifactManually(secondId, "in"));
    await waitFor(() =>
      expect(mocks.placement).toHaveBeenCalledWith(
        expect.objectContaining({
          position: ProjectArtifactPlacementPosition.Inside,
          targetArtifactId: firstId,
          source: ProjectArtifactPlacementSource.Keyboard,
        })
      )
    );
    expect(view().controller.hierarchyView.isExpanded(firstId)).toBe(false);
    const finish = completePlacement;
    if (!finish) {
      throw new Error("Expected the pending placement request");
    }
    await act(async () => finish());
    await waitFor(() =>
      expect(view().controller.hierarchyView.isExpanded(firstId)).toBe(true)
    );
  });

  it("names a live manual reorder handle from the title when an artifact has no slug", () => {
    mocks.flagEnabled = true;
    const first = tree.nodes[0];
    if (!first) {
      throw new Error("Expected a root artifact");
    }
    mount("group=none", {
      ...tree,
      nodes: [{ ...first, root: { ...first.root, slug: null } }],
    });

    const view = currentView();
    const row = view.controller.matchingArtifacts[0];
    if (!row) {
      throw new Error("Expected a rendered project artifact");
    }
    const lead = render(
      view.host.renderLead?.(row, { isNarrowList: false }) ?? null
    );
    expect(row.slug).toBe("");
    expect(
      lead.getByRole("button", { name: "Drag to reorder First" })
    ).toBeInTheDocument();
  });

  it("keeps portable manual placement unavailable until the server grants capability", () => {
    mocks.flagEnabled = true;
    mocks.capability.mockReturnValue(false);
    mount("group=none");

    const view = currentView();
    const row = view.controller.matchingArtifacts[0];
    if (!row) {
      throw new Error("Expected a rendered project artifact");
    }
    const lead = render(
      view.host.renderLead?.(row, { isNarrowList: false }) ?? null
    );
    expect(mocks.capability).toHaveBeenCalledWith(projectId);
    expect(view.controller.manualOrderingActive).toBe(false);
    expect(
      lead.queryByRole("button", { name: `Drag to reorder ${row.slug}` })
    ).toBeNull();
    expect(
      view.host.canGroupDrop?.(row, "status", ARTIFACT_STATUS_ROOT.Done)
    ).toBe(false);
    act(() => view.controller.moveArtifactManually(secondId, "up"));
    act(() =>
      view.controller.applyGroupDrop(
        firstId,
        "status",
        ARTIFACT_STATUS_ROOT.Done
      )
    );
    act(() => view.controller.setSelectedArtifactIds(new Set([firstId])));
    const actions = currentView().host.bulkActions;
    if (
      !isValidElement<{ onMove: (projectId: string) => Promise<unknown> }>(
        actions
      )
    ) {
      throw new Error("Expected bulk move actions");
    }
    expect(
      render(actions).getByRole("button", { name: "Move to project" })
    ).toBeDisabled();
    expect(mocks.placement).not.toHaveBeenCalled();
    expect(mocks.hierarchyTransaction).not.toHaveBeenCalled();
  });

  it("disables portable status-group ordering without a handle or placement request", () => {
    mocks.flagEnabled = true;
    mount("group=status");

    const view = currentView();
    expect(view.controller.groupBy).toBe("status");
    const row = view.controller.matchingArtifacts[0];
    if (!row) {
      throw new Error("Expected a rendered project artifact");
    }
    const lead = render(
      view.host.renderLead?.(row, { isNarrowList: false }) ?? null
    );
    expect(view.controller.manualOrderingActive).toBe(false);
    expect(
      lead.queryByRole("button", { name: `Drag to reorder ${row.slug}` })
    ).toBeNull();
    expect(
      view.host.canGroupDrop?.(row, "status", ARTIFACT_STATUS_ROOT.Done)
    ).toBe(false);
    act(() => view.controller.moveArtifactManually(secondId, "up"));
    act(() =>
      view.controller.applyGroupDrop(
        firstId,
        "status",
        ARTIFACT_STATUS_ROOT.Done
      )
    );
    expect(mocks.placement).not.toHaveBeenCalled();
    expect(mocks.hierarchyTransaction).not.toHaveBeenCalled();
  });

  it("keeps the wide-grid row drag wiring when a non-status group is active", async () => {
    mocks.flagEnabled = true;
    mocks.realView = true;
    mount("group=priority");

    const handle = await screen.findByRole("button", {
      name: "Drag to reorder First",
    });
    expect(handle).toHaveAttribute("data-grid-row-drag-handle");
    expect(
      handle.closest(
        '[data-grid-row-id="22222222-2222-4222-8222-222222222222"]'
      )
    ).toHaveAttribute("draggable", "true");
  });

  it("submits a pointer row drop through manual placement on the live portable list", async () => {
    mocks.flagEnabled = true;
    mocks.realView = true;
    mount("group=none");

    const handle = await screen.findByRole("button", {
      name: "Drag to reorder First",
    });
    const target = screen
      .getByRole("button", { name: "Drag to reorder Second" })
      .closest<HTMLElement>(`[data-grid-row-id="${secondId}"]`);
    if (!target) {
      throw new Error("Expected the destination grid row");
    }
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 40 })
    );
    const values = new Map<string, string>();
    const dataTransfer = {
      dropEffect: "none",
      effectAllowed: "none",
      getData: (type: string) => values.get(type) ?? "",
      setData: (type: string, value: string) => values.set(type, value),
      types: [] as string[],
    };

    fireEvent.dragStart(handle, { clientX: 0, dataTransfer });
    fireEvent.dragOver(target, { clientX: 0, clientY: 30, dataTransfer });
    fireEvent.drop(target, { clientX: 0, clientY: 30, dataTransfer });

    await waitFor(() => expect(mocks.placement).toHaveBeenCalledTimes(1));
    expect(mocks.placement).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceArtifactIds: [firstId],
        position: ProjectArtifactPlacementPosition.After,
        source: ProjectArtifactPlacementSource.Pointer,
        targetArtifactId: secondId,
      })
    );
    expect(mocks.hierarchyTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["owner", true],
    ["owner", false],
    ["status", true],
    ["status", false],
  ])(
    "renders real %s group headers on Project Detail with manual ordering %s (ISS-13007)",
    async (group, manualOrdering) => {
      mocks.portableSurfaceEnabled = true;
      mocks.flagEnabled = manualOrdering;
      mocks.realView = true;
      mount(`group=${group}`);

      await waitFor(() =>
        expect(
          document.querySelectorAll("[data-grid-group-header]").length
        ).toBeGreaterThan(0)
      );
      expect(screen.queryByTestId("project-hierarchy-host")).toBeNull();
    }
  );

  it("opens on the hierarchy tree with Group None when manual ordering is on (ISS-13007)", async () => {
    mocks.portableSurfaceEnabled = true;
    mocks.flagEnabled = true;
    mocks.realView = true;
    mount("");

    await screen.findByTestId("project-hierarchy-host");
    expect(currentView().controller.groupBy).toBe("none");
    expect(document.querySelector("[data-grid-group-header]")).toBeNull();
  });

  it("opens on the Status-grouped grid when manual ordering is off (ISS-13007)", async () => {
    mocks.portableSurfaceEnabled = true;
    mocks.flagEnabled = false;
    mocks.realView = true;
    mount("");

    await waitFor(() =>
      expect(
        document.querySelectorAll("[data-grid-group-header]").length
      ).toBeGreaterThan(0)
    );
    expect(currentView().controller.groupBy).toBe("status");
    expect(screen.queryByTestId("project-hierarchy-host")).toBeNull();
  });

  it("lets an explicit group in the URL win over the manual-ordering default", async () => {
    mocks.portableSurfaceEnabled = true;
    mocks.flagEnabled = true;
    mocks.realView = true;
    mount("group=status");

    await waitFor(() =>
      expect(
        document.querySelectorAll("[data-grid-group-header]").length
      ).toBeGreaterThan(0)
    );
    expect(currentView().controller.groupBy).toBe("status");
  });

  it.each([
    ["grouped grid lead", "group=status", false],
    ["manual-ordering grid lead", "group=none", true],
  ])(
    "draws the kind icon before a branch title as before a document title in the %s (ISS-13007)",
    (_name, search, manualOrdering) => {
      mocks.portableSurfaceEnabled = true;
      mocks.flagEnabled = manualOrdering;
      const first = tree.nodes[0]!;
      const second = tree.nodes[1]!;
      mount(search, {
        ...tree,
        nodes: [
          first,
          {
            ...second,
            root: {
              ...second.root,
              type: ArtifactType.Branch,
              subtype: null,
              slug: "BR-4410",
              name: "branch-trace",
            },
          },
        ],
      });
      const view = currentView();
      const documentRow = view.controller.matchingArtifacts.find(
        (row) => row.id === firstId
      );
      const branchRow = view.controller.matchingArtifacts.find(
        (row) => row.id === secondId
      );
      if (!(documentRow && branchRow)) {
        throw new Error("Expected document and branch rows");
      }
      const navigation = createMemoryNavigation({
        initialPath: `/teams/team/projects/${projectId}`,
        orgSlug: "org",
      });
      const renderLead = (row: typeof documentRow) =>
        render(
          <NavigationProvider adapter={navigation.adapter}>
            {view.host.renderLead?.(row, { isNarrowList: false })}
          </NavigationProvider>
        );
      for (const row of [documentRow, branchRow]) {
        const lead = renderLead(row);
        expect(lead.container.querySelector(KIND_ICON_SELECTOR)).not.toBeNull();
        lead.unmount();
      }
    }
  );

  it("renders a 390px portable treegrid with separate reorder and navigation controls", async () => {
    const restoreWidth = stubContainerWidthPx(390);
    try {
      mocks.portableSurfaceEnabled = true;
      mocks.flagEnabled = true;
      mocks.realView = true;
      const navigation = mount("group=none");

      const handle = await screen.findByRole("button", {
        name: "Drag to reorder First",
      });
      const row = handle.closest<HTMLElement>("[data-grid-row]");
      expect(row).not.toBeNull();
      expect(handle.closest('[data-slot="card"]')).toBeNull();
      if (!row) {
        throw new Error("Expected the first treegrid row");
      }
      // ISS-13007 R-IDENTICAL-LISTS: no persistent row checkbox, as Documents.
      expect(within(row).queryByRole("checkbox")).toBeNull();
      const link = row.querySelector("a");
      expect(link).toBeInTheDocument();
      if (!link) {
        throw new Error("Expected an independent treegrid lead link");
      }
      expect(handle).toHaveAttribute("data-grid-row-drag-handle");
      expect(handle).toHaveClass("touch-none");
      fireEvent.keyDown(
        screen.getByRole("button", { name: "Drag to reorder Second" }),
        { key: "ArrowUp", ctrlKey: true }
      );
      await waitFor(() => expect(mocks.placement).toHaveBeenCalledTimes(1));
      fireEvent.click(link);
      expect(
        new URL(navigation.getCurrentHref(), "https://example.test").pathname
      ).toBe("/org/documents/First");
    } finally {
      restoreWidth();
    }
  });

  it("keeps a branch slug and the same hierarchy title slot as a document", () => {
    mocks.flagEnabled = true;
    const first = tree.nodes[0]!;
    const second = tree.nodes[1]!;
    mount("group=none", {
      ...tree,
      nodes: [
        first,
        {
          ...second,
          root: {
            ...second.root,
            type: ArtifactType.Branch,
            subtype: null,
            slug: "BR-4410",
            name: "branch-trace",
          },
        },
      ],
    });

    const view = currentView();
    const documentRow = view.controller.matchingArtifacts.find(
      (row) => row.id === firstId
    );
    const branchRow = view.controller.matchingArtifacts.find(
      (row) => row.id === secondId
    );
    if (!(documentRow && branchRow)) {
      throw new Error("Expected document and branch rows");
    }
    const navigation = createMemoryNavigation({
      initialPath: `/teams/team/projects/${projectId}`,
      orgSlug: "org",
    });
    const renderLead = (row: typeof documentRow) =>
      render(
        <NavigationProvider adapter={navigation.adapter}>
          {view.host.renderLead?.(row, { isNarrowList: false })}
        </NavigationProvider>
      );
    const documentLead = renderLead(documentRow);
    const branchLead = renderLead(branchRow);
    expect(branchLead.getByText("BR-4410")).toBeInTheDocument();
    for (const lead of [documentLead, branchLead]) {
      expect(
        lead.container.querySelector("div[class*='first-of-type']")
      ).not.toBeNull();
    }
  });
});
