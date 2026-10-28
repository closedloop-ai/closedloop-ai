import {
  ArtifactType,
  LinkType,
  normalizeArtifactSubtype,
} from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus } from "@repo/api/src/types/document";
import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import { MovePosition } from "@repo/api/src/types/project-artifact-move";
import type { ProjectArtifactPlacementResponse } from "@repo/api/src/types/project-artifact-placement";
import {
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
} from "@repo/api/src/types/project-artifact-placement";
import { applyPlacementToProjectTree } from "@repo/api/src/types/project-artifact-placement-tree";
import {
  HierarchyAvailability,
  PROJECT_TREE_CHILD_CURSOR_PARAM,
  PROJECT_TREE_CONTRACT_VERSION,
  PROJECT_TREE_MAX_VISIBLE_LEVELS,
  PROJECT_TREE_PARENT_ARTIFACT_ID_PARAM,
  type ProjectTreeResponse,
} from "@repo/api/src/types/project-tree";
import { documentsWindowedPage } from "@repo/app/documents/components/table/documents-windowed-population.fixtures";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { projectTreeKeys } from "@repo/app/projects/hooks/project-tree-keys";
import { projectArtifactPlacementCapabilityKey } from "@repo/app/projects/hooks/use-artifact-placement";
import { applyMoveToTree } from "@repo/app/projects/hooks/use-project-tree";
import { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { groupExpansionKey } from "@repo/app/shared/hooks/use-group-expansion";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  type TableCollapsedGroups,
  tableGroupingAxisKey,
} from "@repo/app/shared/lib/table-collapsed-groups";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import {
  createStoryDataTransfer,
  fireStoryDrag,
  storyRowDropRect,
} from "@repo/app/shared/storybook/story-drag";
import {
  makeArtifact,
  makeFeatureArtifact,
  makePlanArtifact,
  makeRawArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { tagKeys } from "@repo/app/tags/hooks/use-tags";
import { formatGridCardSelectionLabel } from "@repo/design-system/lib/grid-table-aria";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { z } from "zod";
import { DocumentsView } from "./documents-view";
import {
  ClosedBandDocumentsView,
  closedBandGroups,
} from "./documents-view-story-collapsed-band";
import {
  playDocumentsDragging,
  playDocumentsDragOver,
} from "./documents-view-story-drag-preview";
import {
  hierarchyChild,
  hierarchyState,
} from "./documents-view-story-hierarchy-fixtures";
import {
  assertNarrowCardLayout,
  assertPlacementAnnounced,
  assertPlacementControlsHidden,
  columnDividerCount,
  DRAG_REORDER_PATTERN,
  openStoryRow,
  showPlacementFailure,
  storyGridRow,
  storyRowAppearsBefore,
} from "./documents-view-story-interactions";
import {
  PriorityEditingDocumentsView,
  playPriorityEditing,
} from "./documents-view-story-priority-editing";

// The root carries a non-default priority: a page where every row holds the
// default collapses the Priority column (FEA-3946), and these stories show it.
const documents = [
  makeArtifact({
    id: "root",
    priority: Priority.High,
    status: DocumentStatus.InReview,
  }),
  makeFeatureArtifact({ id: "child" }),
  makePlanArtifact({ id: "plan" }),
];
const artifacts = documents.map((document) =>
  makeRawArtifact(ArtifactType.Document, {
    id: document.id,
    subtype: normalizeArtifactSubtype(document.type),
    name: document.title,
    priority: document.priority,
    slug: document.slug,
    status: document.status,
    sortOrder: document.sortOrder,
  })
);
const [root, child, plan] = artifacts;
if (!(root && child && plan)) {
  throw new Error(
    "Documents story requires its existing root, child and plan fixtures"
  );
}
const tree: ProjectTreeResponse = {
  externalParents: [],
  projectVersion: "story-version",
  nodes: [
    {
      root,
      children: [
        { ...child, depth: 1, parentId: root.id, linkType: LinkType.Produces },
      ],
    },
    { root: plan, children: [] },
  ],
};
const hierarchyMetadata = {
  capabilities: {
    childPaging: true,
    exactPlacement: true,
    maxVisibleLevels: PROJECT_TREE_MAX_VISIBLE_LEVELS,
    mutationVersion: "story-hierarchy-version",
    rootPaging: true,
  },
  contractVersion: PROJECT_TREE_CONTRACT_VERSION,
  diagnostics: [],
  diagnosticsComplete: true,
} satisfies NonNullable<ProjectTreeResponse["hierarchy"]>;
const manualOrderingTree: ProjectTreeResponse = {
  ...tree,
  hierarchy: hierarchyMetadata,
  nodes: [
    {
      ...tree.nodes[0],
      hierarchy: hierarchyState(1, [root.id]),
      children:
        tree.nodes[0]?.children.map((treeChild) => ({
          ...treeChild,
          hierarchy: hierarchyState(0, [root.id, treeChild.id]),
        })) ?? [],
    },
    {
      ...tree.nodes[1],
      hierarchy: hierarchyState(0, [plan.id]),
    },
  ],
};
const continuationDocument = makeFeatureArtifact({
  id: "continuation-child",
  title: child.name,
});
const continuationArtifact = makeRawArtifact(ArtifactType.Document, {
  id: continuationDocument.id,
  name: continuationDocument.title,
  priority: continuationDocument.priority,
  slug: continuationDocument.slug,
  sortOrder: continuationDocument.sortOrder,
  status: continuationDocument.status,
  subtype: normalizeArtifactSubtype(continuationDocument.type),
});
const partialHierarchyTree: ProjectTreeResponse = {
  ...manualOrderingTree,
  hierarchy: { ...hierarchyMetadata, diagnosticsComplete: false },
  nodes: manualOrderingTree.nodes.map((node) =>
    node.root.id === root.id
      ? {
          ...node,
          hierarchy: {
            ...hierarchyState(2, [root.id]),
            availability: HierarchyAvailability.Partial,
            nextCursor: "story-child-cursor",
          },
        }
      : node
  ),
};
const hierarchyDocuments = [
  makeArtifact({ id: "hierarchy-root", title: "Hierarchy PRD" }),
  makeFeatureArtifact({ id: "hierarchy-feature", title: "Test Feature" }),
  makePlanArtifact({ id: "hierarchy-plan", title: "Hierarchy Plan" }),
];
const hierarchyArtifacts = hierarchyDocuments.map((document) =>
  makeRawArtifact(ArtifactType.Document, {
    id: document.id,
    name: document.title,
    priority: document.priority,
    slug: document.slug,
    sortOrder: document.sortOrder,
    status: document.status,
    subtype: normalizeArtifactSubtype(document.type),
  })
);
const [hierarchyRoot, hierarchyFeature, hierarchyPlan] = hierarchyArtifacts;
if (!(hierarchyRoot && hierarchyFeature && hierarchyPlan)) {
  throw new Error("Hierarchy story requires its four-level artifact fixtures");
}
const hierarchyBranch = makeRawArtifact(ArtifactType.Branch, {
  id: "hierarchy-branch",
  name: "Hierarchy branch",
});
const hierarchyTree: ProjectTreeResponse = {
  externalParents: [],
  hierarchy: hierarchyMetadata,
  nodes: [
    {
      root: hierarchyRoot,
      hierarchy: hierarchyState(1, [hierarchyRoot.id]),
      children: [
        hierarchyChild(hierarchyFeature, hierarchyRoot.id, 1, [
          hierarchyRoot.id,
          hierarchyFeature.id,
        ]),
        hierarchyChild(hierarchyPlan, hierarchyFeature.id, 2, [
          hierarchyRoot.id,
          hierarchyFeature.id,
          hierarchyPlan.id,
        ]),
        hierarchyChild(hierarchyBranch, hierarchyPlan.id, 3, [
          hierarchyRoot.id,
          hierarchyFeature.id,
          hierarchyPlan.id,
          hierarchyBranch.id,
        ]),
      ],
    },
  ],
};
const EMPTY_TREE: ProjectTreeResponse = {
  externalParents: [],
  nodes: [],
  projectVersion: "story-empty-version",
};
const WINDOWED_PAGE = documentsWindowedPage();
const projectId = "project-1";
const expansionStorageKey = "storybook:documents-view";
const moveSchema = z.object({
  artifactId: z.string(),
  position: z.enum(MovePosition),
  referenceArtifactId: z.string().optional(),
});
const MANUAL_ORDERING_ARGS = {
  projectId,
  treeData: undefined,
  groupBy: GroupByMode.None,
  filterCategory: "all" as const,
};
const MANUAL_ORDERING_PARAMETERS = { manualOrdering: true } as const;

const meta = {
  title: "Composites/Shared/Artifact List/Documents View",
  component: DocumentsView,
  tags: ["autodocs", "stable"],
  parameters: { layout: "padded", controls: { disable: true } },
  args: {
    documents,
    treeData: tree,
    filterText: "",
    filterCategory: "all",
    groupBy: GroupByMode.Status,
    visibleColumns: [DocumentColumn.Assignee, DocumentColumn.Priority],
    storageKey: expansionStorageKey,
    sortPersistenceKey: null,
  },
  beforeEach: ({ parameters }) => {
    const fixture = createDocumentsStoryFixture({
      manualOrdering: parameters.manualOrdering === true,
      partialHierarchy: parameters.partialHierarchy === true,
      placementWritable: parameters.placementWritable !== false,
      selectableHierarchy: parameters.selectableHierarchy === true,
      placementFailureStatus:
        typeof parameters.placementFailureStatus === "number"
          ? parameters.placementFailureStatus
          : undefined,
      undoFailure: parameters.undoFailure === true,
    });
    parameters.appCore = {
      ...parameters.appCore,
      ...fixture,
      enabledFlags: [
        ...new Set([
          ...(parameters.appCore?.enabledFlags ?? []),
          ...fixture.enabledFlags,
        ]),
      ],
    };
    const key = groupExpansionKey(expansionStorageKey, "");
    if (key === null) {
      return;
    }
    const previous = globalThis.localStorage.getItem(key);
    const configuredExpandedRows = Array.isArray(parameters.expandedRows)
      ? parameters.expandedRows.filter(
          (rowId): rowId is string => typeof rowId === "string"
        )
      : undefined;
    const expanded =
      configuredExpandedRows ?? (parameters.closedTree ? [] : ["root"]);
    globalThis.localStorage.setItem(key, JSON.stringify(expanded));
    return () => {
      if (previous === null) {
        globalThis.localStorage.removeItem(key);
      } else {
        globalThis.localStorage.setItem(key, previous);
      }
    };
  },
} satisfies Meta<typeof DocumentsView>;

export default meta;
type Story = StoryObj<typeof meta>;

// No controls: these examples configure the production parent with the existing mixed-kind tree fixture and its real ports.
export const Default: Story = {
  // A desktop canvas: below 768px the grid renders cards and has no header row
  // for the play below to measure against.
  globals: { viewport: { value: "1512-900" } },
  // Every grouped data row draws its column dividers on the header's tracks:
  // a cell that drew its own frame inside the grid's doubled them.
  play: async ({ canvasElement }) => {
    const rows = [...canvasElement.querySelectorAll<HTMLElement>("[role=row]")];
    const header = rows.find((row) => row.querySelector("[role=columnheader]"));
    const dataRows = rows.filter(
      (row) =>
        row !== header &&
        row.querySelector("[role=gridcell]") !== null &&
        row.querySelector("[aria-colspan]") === null
    );
    await expect(header).toBeDefined();
    await expect(dataRows.length).toBeGreaterThan(0);
    for (const row of dataRows) {
      await expect(columnDividerCount(row)).toBe(
        columnDividerCount(header ?? row)
      );
    }
  },
};
export const Loading: Story = {
  args: { documents: [], isLoading: true, treeData: EMPTY_TREE },
};
export const Empty: Story = {
  args: { documents: [], treeData: EMPTY_TREE },
};
export const ManualOrderingError: Story = {
  name: "Error",
  args: MANUAL_ORDERING_ARGS,
  parameters: {
    ...MANUAL_ORDERING_PARAMETERS,
    placementFailureStatus: 409,
  },
  play: showPlacementFailure,
};
export const NoPermission: Story = {
  args: { ...MANUAL_ORDERING_ARGS, canReorderArtifacts: false },
  parameters: {
    ...MANUAL_ORDERING_PARAMETERS,
    placementWritable: false,
  },
  play: assertPlacementControlsHidden,
};
export const UndoFailure: Story = {
  args: MANUAL_ORDERING_ARGS,
  parameters: {
    ...MANUAL_ORDERING_PARAMETERS,
    undoFailure: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = canvas.getAllByRole("button", {
      name: DRAG_REORDER_PATTERN,
    })[0];
    handle?.focus();
    await userEvent.keyboard("{Control>}{ArrowDown}{/Control}");
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(
        body.getByText("Failed to move items. Please try again.")
      ).toBeVisible()
    );
  },
};
/** The owning surface holds the In Review band closed on the Status axis. */
export const ClosedBand: Story = {
  render: (args) => (
    <ClosedBandDocumentsView
      {...args}
      initialCollapsedGroups={closedBandGroups(DocumentStatus.InReview)}
    />
  ),
  play: async ({ canvas }) => {
    const [inReview, plan] = documents.filter(({ id }) => id !== "child");
    await expect(canvas.queryByText(inReview?.title ?? "")).toBeNull();
    await expect(canvas.getByText(plan?.title ?? "")).toBeVisible();
  },
};
/** One page of a windowed response, paged by the production section-aware plan. */
export const WindowedPopulation: Story = {
  args: {
    continuedSectionKeys: WINDOWED_PAGE.continuedSectionKeys,
    documents: WINDOWED_PAGE.documents,
    sectionTotalsByKey: WINDOWED_PAGE.sectionTotals,
    treeData: WINDOWED_PAGE.treeData,
  },
};
/** The caller pages the list but supplies no section totals, so no band states a number. */
export const UnknownPopulation: Story = {
  args: {
    documents: WINDOWED_PAGE.documents,
    sectionTotalsByKey: new Map(),
    treeData: WINDOWED_PAGE.treeData,
  },
};
export const FlatCategory: Story = { args: { filterCategory: "features" } };
export const UngroupedTree: Story = { args: { groupBy: GroupByMode.None } };
export const ClosedTree: Story = {
  args: { groupBy: GroupByMode.None },
  parameters: { closedTree: true },
  play: async ({ canvas }) => {
    await expect(canvas.queryByText(documents[1]?.title ?? "")).toBeNull();
  },
};
export const Flat: Story = {
  args: { filterCategory: "features", groupBy: GroupByMode.None },
};
export const StackRank: Story = {
  args: {
    projectId,
    treeData: undefined,
    groupBy: GroupByMode.None,
    filterCategory: "all",
  },
};
export const StackRankGridViewAdoption: Story = {
  name: "Stack Rank GridView Adoption",
  args: StackRank.args,
  tags: ["!stable", "preview"],
  parameters: {
    appCore: { enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY] },
  },
  play: async ({ canvasElement }) => {
    const contract = canvasElement.querySelector(
      '[data-grid-interaction-contract="pointer-hover"]'
    );
    await expect(contract).toBeInTheDocument();
    const rootSurface = contract?.querySelector(
      '[data-grid-row-id="root"], [data-grid-card-id="root"]'
    );
    if (!(rootSurface instanceof HTMLElement)) {
      throw new Error("root artifact did not render as a grid row or card");
    }
    const rankHandle = rootSurface.querySelector(
      'button[aria-label="Reorder row"][data-grid-contextual-action]'
    );
    if (rootSurface.hasAttribute("data-grid-row-id")) {
      await expect(rootSurface).toHaveAttribute("role", "row");
    } else {
      await expect(rootSurface).toHaveAttribute("data-grid-card-id", "root");
      await expect(rootSurface).toHaveClass("group/row");
    }
    for (
      let tabCount = 0;
      tabCount < 32 && globalThis.document.activeElement !== rankHandle;
      tabCount++
    ) {
      await userEvent.tab();
    }
    await expect(rankHandle).toHaveFocus();
    await expect(rankHandle).toBeVisible();
    await expect(rankHandle).not.toHaveAttribute(
      "data-grid-contextual-action-legacy"
    );
  },
};

export const ManualOrdering: Story = {
  args: MANUAL_ORDERING_ARGS,
  parameters: MANUAL_ORDERING_PARAMETERS,
};
export const ManualDefaultExpanded: Story = {
  args: MANUAL_ORDERING_ARGS,
  parameters: { ...MANUAL_ORDERING_PARAMETERS, closedTree: true },
  play: async ({ canvas }) => {
    await expect(
      canvas.findByText(documents[1]?.title ?? "")
    ).resolves.toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Collapse" })
    ).toBeVisible();
  },
};
export const ManualFlagOffCollapsed: Story = {
  args: MANUAL_ORDERING_ARGS,
  parameters: { closedTree: true, manualOrdering: false },
  play: async ({ canvas }) => {
    await expect(canvas.queryByText(documents[1]?.title ?? "")).toBeNull();
  },
};
export const FourLevelHierarchy: Story = {
  args: {
    documents: hierarchyDocuments,
    filterCategory: "all",
    groupBy: GroupByMode.None,
    projectId,
    storageKey: "storybook:documents-view:four-level-hierarchy",
    treeData: hierarchyTree,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("treegrid")).toBeVisible();
    await openStoryRow(canvasElement, "Hierarchy PRD");
    await openStoryRow(canvasElement, "Test Feature");
    await openStoryRow(canvasElement, "Hierarchy Plan");
    await expect(canvas.getByText("Hierarchy branch")).toBeVisible();

    const planCheckbox = canvas.getByRole("checkbox", {
      name: formatGridCardSelectionLabel("Hierarchy Plan", false),
    });
    await userEvent.click(planCheckbox);
    await expect(planCheckbox).toBeChecked();

    const featureRow = canvas
      .getByText("Test Feature")
      .closest<HTMLElement>("[role=row]");
    if (!featureRow) {
      throw new Error("Four-level hierarchy requires the feature row");
    }
    const featureDisclosure = within(featureRow).getByRole("button", {
      name: "Hide nested artifacts",
    });
    await userEvent.click(featureDisclosure);
    await expect(canvas.queryByText("Hierarchy Plan")).toBeNull();
    await expect(
      canvas.getByRole("checkbox", {
        name: formatGridCardSelectionLabel("Test Feature", false),
      })
    ).not.toBeChecked();
    await userEvent.click(
      within(featureRow).getByRole("button", {
        name: "Show nested artifacts",
      })
    );
    await expect(
      canvas.getByRole("checkbox", {
        name: formatGridCardSelectionLabel("Hierarchy Plan", true),
      })
    ).toBeChecked();
    await expect(
      canvas.getByRole("checkbox", {
        name: formatGridCardSelectionLabel("Test Feature", false),
      })
    ).not.toBeChecked();
    await expect(canvas.getByRole("treegrid")).toBeVisible();
  },
};
export const Hover: Story = {
  ...ManualOrdering,
  parameters: {
    ...MANUAL_ORDERING_PARAMETERS,
    pseudo: { hover: '[aria-label^="Drag to reorder "]' },
  },
};
export const FocusVisible: Story = {
  ...ManualOrdering,
  play: async ({ canvas }) => {
    const handle = canvas.getAllByRole("button", {
      name: DRAG_REORDER_PATTERN,
    })[0];
    handle?.focus();
    await expect(handle).toHaveFocus();
  },
};
export const Selected: Story = {
  ...ManualOrdering,
  parameters: {
    ...MANUAL_ORDERING_PARAMETERS,
    selectableHierarchy: true,
  },
  play: async ({ canvas }) => {
    const checkbox = canvas.getByRole("checkbox", {
      name: "Test PRD",
    });
    await userEvent.click(checkbox);
    await expect(checkbox).toBeChecked();
    const page = checkbox.ownerDocument.documentElement;
    await waitFor(() =>
      expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth)
    );
  },
};
export const Editing: Story = {
  ...ManualOrdering,
  render: (args) => <PriorityEditingDocumentsView {...args} />,
  play: ({ canvasElement }) => playPriorityEditing(canvasElement),
};
export const Dragging: Story = {
  ...ManualOrdering,
  play: ({ canvasElement }) =>
    playDocumentsDragging(
      canvasElement,
      documents.map((document) => document.id)
    ),
};
export const DragOver: Story = {
  ...ManualOrdering,
  parameters: {
    ...MANUAL_ORDERING_PARAMETERS,
    selectableHierarchy: true,
  },
  play: ({ canvasElement }) =>
    playDocumentsDragOver(canvasElement, root.name, plan.name),
};
export const Partial: Story = {
  ...ManualOrdering,
  args: {
    ...MANUAL_ORDERING_ARGS,
    documents: [...documents, continuationDocument],
  },
  parameters: {
    ...MANUAL_ORDERING_PARAMETERS,
    expandedRows: [],
    partialHierarchy: true,
  },
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByText(root.name)).toBeVisible());
    await waitFor(() => expect(canvas.getByText(plan.name)).toBeVisible());
    await waitFor(() => expect(canvas.getByText("Partial")).toBeVisible());
    await waitFor(() =>
      expect(canvas.getByLabelText("Partial cell value")).toBeVisible()
    );
  },
};
export const Disabled: Story = {
  ...ManualOrdering,
  args: { ...MANUAL_ORDERING_ARGS, groupBy: GroupByMode.Status },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("button", { name: DRAG_REORDER_PATTERN })
    ).toBeNull();
    const disabledHandle = canvasElement.querySelector<HTMLElement>(
      ".cursor-not-allowed"
    );
    if (disabledHandle) {
      await userEvent.hover(disabledHandle);
      const hints = await within(
        canvasElement.ownerDocument.body
      ).findAllByText("Disable grouping to reorder");
      await expect(hints.length).toBeGreaterThan(0);
    }
  },
};
export const ReadOnly: Story = {
  args: {
    ...MANUAL_ORDERING_ARGS,
    canReorderArtifacts: false,
  },
  parameters: {
    ...MANUAL_ORDERING_PARAMETERS,
    placementWritable: false,
  },
  play: assertPlacementControlsHidden,
};
export const Narrow: Story = {
  ...ManualOrdering,
  // The grid measures its container, so the phone width is set on it.
  decorators: [
    (StoryComponent) => (
      <div
        className="w-full min-w-0 max-w-sm"
        data-testid="narrow-scroll-container"
      >
        <StoryComponent />
      </div>
    ),
  ],
  globals: { viewport: { value: "390-844" } },
  play: ({ canvasElement }) => assertNarrowCardLayout(canvasElement),
};
export const Overflow: Story = {
  ...ManualOrdering,
  decorators: [
    (StoryComponent) => (
      <div className="max-w-md overflow-x-auto">
        <StoryComponent />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const container = canvasElement.querySelector<HTMLElement>(".max-w-md");
    if ((container?.clientWidth ?? 0) === 0) {
      return;
    }
    await waitFor(() => {
      expect(within(canvasElement).queryByRole("columnheader")).toBeNull();
      expect(
        canvasElement.querySelectorAll('[data-slot="card"]').length
      ).toBeGreaterThan(0);
      expect(container?.scrollWidth ?? 0).toBeLessThanOrEqual(
        container?.clientWidth ?? 0
      );
    });
  },
};
export const Dark: Story = {
  ...ManualOrdering,
  globals: { theme: "dark" },
};
export const PointerPlacement: Story = {
  ...ManualOrdering,
  parameters: {
    ...MANUAL_ORDERING_PARAMETERS,
    expandedRows: [root.id, plan.id],
    selectableHierarchy: true,
  },
  play: async ({ canvasElement }) => {
    const source = storyGridRow(canvasElement, root.name);
    const target = storyGridRow(canvasElement, plan.name);
    await expect(
      storyRowAppearsBefore(canvasElement, root.name, plan.name)
    ).toBe(true);
    const dataTransfer = createStoryDataTransfer();
    const targetRect = storyRowDropRect(target);
    target.getBoundingClientRect = () => targetRect;
    fireStoryDrag(source, "dragstart", targetRect.left, 0, dataTransfer);
    fireStoryDrag(
      target,
      "dragover",
      targetRect.left + 32,
      targetRect.top + targetRect.height / 2,
      dataTransfer
    );
    await waitFor(() =>
      expect(target).toHaveAttribute(
        "data-row-drop",
        ProjectArtifactPlacementPosition.Inside
      )
    );
    fireStoryDrag(
      target,
      "drop",
      targetRect.left + 32,
      targetRect.top + targetRect.height / 2,
      dataTransfer
    );
    await assertPlacementAnnounced(canvasElement);
    await waitFor(() =>
      expect(storyRowAppearsBefore(canvasElement, plan.name, root.name)).toBe(
        true
      )
    );
    await expect(storyGridRow(canvasElement, root.name)).toHaveAttribute(
      "aria-level",
      "2"
    );
    canvasElement.setAttribute("data-story-placement-state", "completed");
  },
};
export const KeyboardPlacement: Story = {
  ...ManualOrdering,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = canvas.getAllByRole("button", {
      name: DRAG_REORDER_PATTERN,
    })[0];
    handle?.focus();
    await userEvent.keyboard("{Control>}{ArrowDown}{/Control}");
    await assertPlacementAnnounced(canvasElement);
  },
};
export const KeyboardIntoCollapsedParent: Story = {
  ...ManualOrdering,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Collapse" }));
    const planTitle = canvas.getByText(documents[2]?.title ?? "");
    const planRow = planTitle.closest<HTMLElement>(".group\\/row");
    if (!planRow) {
      throw new Error("Expected the plan row");
    }
    const handle = within(planRow).getByRole("button", {
      name: DRAG_REORDER_PATTERN,
    });
    handle.focus();
    await userEvent.keyboard("{Control>}{ArrowRight}{/Control}");
    await assertPlacementAnnounced(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Collapse" })
    ).toBeVisible();
    const movedTitle = await canvas.findByText(documents[2]?.title ?? "");
    await expect(movedTitle).toBeVisible();
    const movedRow = movedTitle.closest<HTMLElement>(".group\\/row");
    if (!movedRow) {
      throw new Error("Expected the moved plan row");
    }
    await expect(
      within(movedRow).getByRole("button", { name: DRAG_REORDER_PATTERN })
    ).toHaveFocus();
  },
};

/** The production rank hook owns the optimistic splice; the transport retains the same ordering for its settle/refetch. */
function createDocumentsStoryFixture({
  manualOrdering = false,
  partialHierarchy = false,
  placementWritable = true,
  placementFailureStatus,
  selectableHierarchy = false,
  undoFailure = false,
}: {
  manualOrdering?: boolean;
  partialHierarchy?: boolean;
  placementWritable?: boolean;
  placementFailureStatus?: number;
  selectableHierarchy?: boolean;
  undoFailure?: boolean;
} = {}) {
  let currentTree = initialStoryTree(partialHierarchy, selectableHierarchy);
  let previousTree = currentTree;
  let lastPlacement: ProjectArtifactPlacementResponse["placement"] | null =
    null;
  const apiRoutes: FixtureRoute[] = [
    {
      method: "GET",
      path: `/projects/${projectId}/tree`,
      respond: ({ searchParams }) =>
        partialHierarchy
          ? partialHierarchyPage(searchParams, currentTree)
          : currentTree,
    },
    {
      method: "GET",
      path: `/projects/${projectId}/artifacts/placement`,
      respond: () => ({
        projectId,
        projectVersion: "story-version",
        canPlaceArtifacts: placementWritable,
      }),
    },
    { method: "GET", path: "/tags", respond: () => [] },
    {
      method: "POST",
      path: `/projects/${projectId}/artifacts/placement`,
      status: placementFailureStatus ?? 200,
      error: "Failed to move items. Please try again.",
      respond: ({ body }) => {
        const undo = z
          .object({
            kind: z.literal(ProjectArtifactPlacementKind.Undo),
            undoOfTransactionId: z.string(),
          })
          .passthrough()
          .safeParse(body);
        if (undo.success) {
          if (undoFailure) {
            throw new Error("Failed to move items. Please try again.");
          }
          if (!lastPlacement) {
            throw new Error("No placement to undo");
          }
          currentTree = previousTree;
          return {
            placed: true,
            transactionId: undo.data.undoOfTransactionId,
            affectedArtifactIds: [root.id, child.id, plan.id],
            affectedProjectIds: [projectId],
            projectVersions: { [projectId]: "story-version-3" },
            placement: lastPlacement,
            replayed: false,
            undoAvailable: false,
          } satisfies ProjectArtifactPlacementResponse;
        }
        const request = z
          .object({
            kind: z.literal(ProjectArtifactPlacementKind.Place),
            sourceArtifactIds: z.array(z.string()),
            destinationProjectId: z.string(),
            position: z.enum(ProjectArtifactPlacementPosition),
            targetArtifactId: z.string().optional(),
          })
          .passthrough()
          .parse(body);
        Reflect.set(globalThis, "__PRD725_LAST_PLACEMENT_REQUEST__", request);
        previousTree = currentTree;
        lastPlacement = request;
        currentTree = applyPlacementToProjectTree(currentTree, request);
        return {
          placed: true,
          transactionId: "00000000-0000-4000-8000-000000000001",
          affectedArtifactIds: request.sourceArtifactIds,
          affectedProjectIds: [projectId],
          projectVersions: { [projectId]: "story-version-2" },
          placement: request,
          replayed: false,
          undoAvailable: true,
        } satisfies ProjectArtifactPlacementResponse;
      },
    },
    {
      method: "POST",
      path: `/projects/${projectId}/artifacts/move`,
      respond: ({ body }) => {
        const move = moveSchema.parse(body);
        currentTree = {
          ...currentTree,
          nodes: applyMoveToTree(currentTree.nodes, move),
        };
        return {
          moved: true,
          newSortOrder: currentTree.nodes.findIndex(
            (node) => node.root.id === move.artifactId
          ),
        };
      },
    },
  ];
  const projectTreeQueryData = partialHierarchy
    ? []
    : [[projectTreeKeys.detail(projectId), currentTree] as const];
  return {
    apiRoutes,
    enabledFlags: manualOrdering ? [MANUAL_ARTIFACT_ORDERING_FLAG_KEY] : [],
    queryData: [
      ...projectTreeQueryData,
      [tagKeys.list({}), []],
      [
        projectArtifactPlacementCapabilityKey(projectId),
        {
          projectId,
          projectVersion: "story-version",
          canPlaceArtifacts: placementWritable,
        },
      ],
    ] as const,
  };
}

function partialHierarchyPage(
  searchParams: URLSearchParams,
  currentTree: ProjectTreeResponse
): ProjectTreeResponse {
  if (searchParams.get(PROJECT_TREE_PARENT_ARTIFACT_ID_PARAM) !== root.id) {
    return currentTree;
  }
  const childCursor = searchParams.get(PROJECT_TREE_CHILD_CURSOR_PARAM);
  const pageRoot = childCursor ? continuationArtifact : child;
  return {
    externalParents: [],
    hierarchy: {
      ...hierarchyMetadata,
      childCount: 2,
      diagnosticsComplete: false,
      parentArtifactId: root.id,
      ...(childCursor ? {} : { nextCursor: "story-child-cursor" }),
    },
    nodes: [
      {
        root: pageRoot,
        children: [],
        hierarchy: hierarchyState(0, [root.id, pageRoot.id]),
      },
    ],
  };
}

function initialStoryTree(
  partialHierarchy: boolean,
  selectableHierarchy: boolean
): ProjectTreeResponse {
  if (partialHierarchy) {
    return partialHierarchyTree;
  }
  if (selectableHierarchy) {
    return manualOrderingTree;
  }
  return tree;
}
