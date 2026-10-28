import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import type { ProjectArtifactBoardPageResponse } from "@repo/api/src/types/project-artifact-board-page";
import {
  HierarchyAvailability,
  PROJECT_TREE_CONTRACT_VERSION,
  PROJECT_TREE_MAX_VISIBLE_LEVELS,
  type ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import { ARTIFACT_BOARD_LABEL } from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model";
import {
  GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
  PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { MANUAL_REORDER_HANDLE_NAME_PATTERN } from "@repo/app/shared/lib/manual-reorder-handle-label";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import ProjectDetailPage from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/page";
import {
  completedProjectTreeFixture,
  PROJECTS_PATH,
  PROJECTS_TEAM_ID,
  projectDetailFixture,
  projectsApiRoutes,
  projectsRoutes,
  projectsTeamFixture,
  projectTreeFixture,
} from "./fixtures/projects-fixtures";
import { LivePage } from "./live-page";
import {
  expectActiveNavItem,
  LIVE_ORG_SLUG,
  narrowStoryViewport,
  withLiveRoute,
} from "./live-route";

// ISS-11361 Target sidebar, entry 19 of 62: Project Detail (Tabbed artifact detail).
// The live route's own page
// (`apps/app/.../teams/[teamId]/projects/[projectId]/page.tsx`: the header
// with Actions, the Overview / All Artifacts / PRDs / Issues / Plans /
// Branches tab bar, filters and the artifact table) in the app frame. Each
// story is one state the live page reaches from its reads or its `?tab=`.

const PROJECT_PATH = `/${LIVE_ORG_SLUG}${PROJECTS_PATH}/${projectDetailFixture.id}`;
const PROJECT_PARAMS = {
  projectId: projectDetailFixture.id,
  teamId: PROJECTS_TEAM_ID,
};
const projectHierarchyTreeFixture = buildProjectHierarchyTreeFixture();

const meta = {
  title: "Surfaces/Your Teams/Project Detail",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => (
    <LivePage activePath={PROJECTS_PATH}>
      <ProjectDetailPage />
    </LivePage>
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: { path: PROJECT_PATH, params: PROJECT_PARAMS },
    appCore: { apiRoutes: projectsApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function onTab(tab: string) {
  return {
    liveRoute: { path: `${PROJECT_PATH}?tab=${tab}`, params: PROJECT_PARAMS },
  };
}

function withRead(
  path: string,
  respond: FixtureRoute["respond"],
  status = 200
) {
  return {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path,
          respond,
          status,
          // The API's own message, which this page prints.
          error: "Internal server error",
        },
        ...projectsApiRoutes,
      ] satisfies FixtureRoute[],
    },
  };
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      (
        await canvas.findAllByText(
          projectDetailFixture.name,
          {},
          { timeout: 10_000 }
        )
      ).length
    ).toBeGreaterThan(0);
    await expectActiveNavItem(canvasElement, projectsTeamFixture.name);
  },
};

/** The project read is still in flight. */
export const Loading: Story = {
  parameters: withRead(
    `/projects/${projectDetailFixture.id}`,
    () => new Promise(() => undefined)
  ),
};

/** Every artifact is finished, so the default "Hide completed" hides them all. */
export const NoMatches: Story = {
  parameters: {
    appCore: {
      apiRoutes: projectsRoutes(
        undefined,
        undefined,
        completedProjectTreeFixture
      ),
    },
  },
};

/** The project read failed. */
export const ErrorState: Story = {
  name: "Error",
  parameters: withRead(`/projects/${projectDetailFixture.id}`, () => null, 500),
};

export const Narrow: Story = {
  beforeEach: narrowStoryViewport,
  globals: { viewport: { value: "390-844" } },
  parameters: {
    appCore: {
      enabledFlags: [
        GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY,
        PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY,
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole(
        "columnheader",
        { name: "Name" },
        { timeout: 10_000 }
      )
    ).toBeVisible();
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(1);
    await expect(
      canvasElement.querySelector('[data-grid-card-id] [data-slot="card"]')
    ).toBeNull();
    await expect(
      await canvas.findByText("Trace timeline rollout notes")
    ).toBeVisible();
    const rows = canvasElement.querySelectorAll<HTMLElement>(
      "[data-grid-row][data-grid-card-id]"
    );
    await expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      const nameCell = row.querySelector('[role="gridcell"]');
      const status = nameCell?.querySelector('[data-slot="status-icon"]');
      const title = nameCell?.querySelector(".truncate");
      if (!(status && title)) {
        throw new Error(
          `Missing narrow status or title in ${row.dataset.gridRowId}: status=${Boolean(status)} title=${Boolean(title)}`
        );
      }
      await expect(
        nameCell?.querySelector('[data-slot="status-icon"], .truncate')
      ).toBe(status);
    }
  },
};

export const LegacyNarrow: Story = {
  beforeEach: narrowStoryViewport,
  globals: { viewport: { value: "390-844" } },
  parameters: {
    appCore: { enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole(
        "columnheader",
        { name: "Name" },
        { timeout: 10_000 }
      )
    ).toBeVisible();
    await expect(canvas.getAllByRole("columnheader")).toHaveLength(1);
    await expect(
      await canvas.findByText("Trace timeline rollout notes")
    ).toBeVisible();
  },
};

/** The production project route on its default All Artifacts tab with manual hierarchy ordering enabled. */
export const ManualOrdering: Story = {
  parameters: {
    liveRoute: {
      path: `${PROJECT_PATH}?group=none`,
      params: PROJECT_PARAMS,
    },
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: `/projects/${projectDetailFixture.id}/tree`,
          respond: () => projectHierarchyTreeFixture,
        },
        {
          method: "GET",
          path: `/projects/${projectDetailFixture.id}/artifacts/placement`,
          respond: () => ({
            canPlaceArtifacts: true,
            projectId: projectDetailFixture.id,
            projectVersion: "story-version",
          }),
        },
        ...projectsApiRoutes,
      ] satisfies FixtureRoute[],
      enabledFlags: [MANUAL_ARTIFACT_ORDERING_FLAG_KEY],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.findByRole("treegrid", {}, { timeout: 10_000 })
    ).resolves.toBeVisible();
    await openHierarchyRow(
      canvasElement,
      projectHierarchyTreeFixture.nodes[0]?.root.name ?? ""
    );
    await openHierarchyRow(
      canvasElement,
      projectHierarchyTreeFixture.nodes[0]?.children[0]?.name ?? ""
    );
    await openHierarchyRow(
      canvasElement,
      projectHierarchyTreeFixture.nodes[0]?.children[1]?.name ?? ""
    );
    const branch = projectHierarchyTreeFixture.nodes[0]?.children[2];
    const branchRow = branch
      ? canvas.getByText(branch.name).closest<HTMLElement>("[role=row]")
      : null;
    await expect(branchRow).not.toBeNull();
    await expect(branchRow).toHaveAttribute("aria-level", "4");
    const hierarchyRows = Array.from(
      canvas
        .getByRole("treegrid")
        .querySelectorAll<HTMLElement>("[data-grid-row]")
    );
    const handles = within(canvasElement).getAllByRole("button", {
      name: MANUAL_REORDER_HANDLE_NAME_PATTERN,
    });
    const checkboxes = canvasElement.querySelectorAll(
      '[data-grid-row] [role="checkbox"]'
    );
    await expect(handles.length).toBe(hierarchyRows.length);
    // Tree rows name their artifact by ID as well as by title.
    const rootSlug = projectHierarchyTreeFixture.nodes[0]?.root.slug ?? "";
    await expect(
      within(canvas.getByRole("treegrid")).getAllByText(rootSlug).length
    ).toBeGreaterThan(0);
    // ISS-13007 R-IDENTICAL-LISTS: no persistent row checkbox, as Documents.
    await expect(checkboxes.length).toBe(0);
  },
};

/** Opened on Overview (`?tab=overview`). */
export const OverviewTab: Story = { parameters: onTab("overview") };

/** Opened on PRDs (`?tab=documents`). */
export const PRDsTab: Story = {
  name: "PRDs Tab",
  parameters: onTab("documents"),
};

/** Opened on Issues (`?tab=issues`). */
export const IssuesTab: Story = { parameters: onTab("issues") };

/** Opened on Plans (`?tab=plans`). */
export const PlansTab: Story = { parameters: onTab("plans") };

/** Opened on Branches (`?tab=branches`). */
export const BranchesTab: Story = { parameters: onTab("branches") };

/** The legacy Project Detail route opened in Board view. */
export const BoardView: Story = {
  parameters: {
    appCore: {
      apiRoutes: [
        {
          method: "GET",
          path: `/projects/${projectDetailFixture.id}/artifacts/board`,
          respond: () => BOARD_PAGE_FIXTURE,
        },
        ...projectsApiRoutes,
      ],
      enabledFlags: [MANUAL_ARTIFACT_ORDERING_FLAG_KEY],
    },
    liveRoute: {
      params: PROJECT_PARAMS,
      path: `${PROJECT_PATH}?layout=board&group=status`,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole(
        "group",
        { name: ARTIFACT_BOARD_LABEL },
        { timeout: 10_000 }
      )
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Filters" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Sort" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Options" })).toBeVisible();
  },
};

const BOARD_ARTIFACT_ID = "11111111-1111-7111-8111-111111111111";
const BOARD_PROJECT_ID = "22222222-2222-7222-8222-222222222222";
const BOARD_ORGANIZATION_ID = "33333333-3333-7333-8333-333333333333";
const BOARD_PAGE_FIXTURE = {
  lanes: [
    {
      cards: [
        {
          artifact: {
            assignee: null,
            assigneeId: null,
            createdAt: new Date("2026-10-19T00:00:00.000Z"),
            createdById: null,
            dueDate: null,
            externalUrl: null,
            id: BOARD_ARTIFACT_ID,
            name: "Wire session lanes into the branch trace",
            organizationId: BOARD_ORGANIZATION_ID,
            priority: null,
            projectId: BOARD_PROJECT_ID,
            slug: "ISS-11402",
            sortOrder: 0,
            status: IssueStatus.InProgress,
            subtype: ArtifactSubtype.Feature,
            type: ArtifactType.Document,
            updatedAt: new Date("2026-10-19T00:00:00.000Z"),
          },
          descendantCount: 0,
        },
      ],
      complete: true,
      count: 1,
      id: IssueStatus.InProgress,
      label: "In Progress",
    },
  ],
  populationRevision: "a".repeat(64),
  rootIds: [BOARD_ARTIFACT_ID],
} satisfies ProjectArtifactBoardPageResponse;

function buildProjectHierarchyTreeFixture(): ProjectTreeDetailsResponse {
  const rootNode = projectTreeFixture.nodes[0];
  const runbookNode = projectTreeFixture.nodes[1];
  const branchNode = projectTreeFixture.nodes[2];
  const [plan, firstIssue, secondIssue, thirdIssue] = rootNode?.children ?? [];
  if (
    !(
      rootNode &&
      runbookNode &&
      branchNode &&
      plan &&
      firstIssue &&
      secondIssue &&
      thirdIssue
    )
  ) {
    throw new Error(
      "Project Detail hierarchy story requires its tree fixtures"
    );
  }
  const rootId = rootNode.root.id;
  return {
    externalParents: [],
    projectVersion: "story-version",
    hierarchy: {
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
    },
    nodes: [
      {
        root: rootNode.root,
        hierarchy: projectHierarchyState(3, [rootId]),
        children: [
          {
            ...plan,
            depth: 1,
            hierarchy: projectHierarchyState(1, [rootId, plan.id]),
            parentId: rootId,
          },
          {
            ...firstIssue,
            depth: 2,
            hierarchy: projectHierarchyState(1, [
              rootId,
              plan.id,
              firstIssue.id,
            ]),
            parentId: plan.id,
          },
          {
            ...branchNode.root,
            depth: 3,
            hierarchy: projectHierarchyState(0, [
              rootId,
              plan.id,
              firstIssue.id,
              branchNode.root.id,
            ]),
            linkType: LinkType.Produces,
            parentId: firstIssue.id,
          },
          {
            ...secondIssue,
            depth: 1,
            hierarchy: projectHierarchyState(0, [rootId, secondIssue.id]),
            parentId: rootId,
          },
          {
            ...thirdIssue,
            depth: 1,
            hierarchy: projectHierarchyState(0, [rootId, thirdIssue.id]),
            parentId: rootId,
          },
        ],
      },
      {
        ...runbookNode,
        hierarchy: projectHierarchyState(0, [runbookNode.root.id]),
      },
    ],
  };
}

function projectHierarchyState(childCount: number, hierarchyPath: string[]) {
  return {
    availability: HierarchyAvailability.Complete,
    canMove: true,
    childCount,
    hierarchyPath,
  };
}

async function openHierarchyRow(
  canvasElement: HTMLElement,
  title: string
): Promise<void> {
  const canvas = within(canvasElement);
  const row = (await canvas.findAllByText(title))
    .map((element) => element.closest<HTMLElement>("[role=row]"))
    .find((candidate): candidate is HTMLElement => candidate !== null);
  if (!row) {
    throw new Error(`Project Detail hierarchy story requires the ${title} row`);
  }
  const disclosure = within(row).queryByRole("button", {
    name: "Expand row",
  });
  if (disclosure) {
    await userEvent.click(disclosure);
  }
}
