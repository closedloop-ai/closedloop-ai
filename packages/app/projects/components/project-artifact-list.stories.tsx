import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { DirectCollaboratorSource } from "@repo/api/src/types/artifact-collaborators";
import { BranchStatus } from "@repo/api/src/types/branch";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { type DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import {
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  projectArtifactPlacementValidator,
} from "@repo/api/src/types/project-artifact-placement";
import {
  type DetailedArtifact,
  type ProjectTreeDetailsResponse,
  TreeTruncationReason,
} from "@repo/api/src/types/project-tree";
import { useNavigation } from "@repo/navigation/use-navigation";
import type { Meta, StoryObj } from "@storybook/react";
import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import {
  expect,
  fireEvent,
  screen,
  userEvent,
  waitFor,
  within,
} from "storybook/test";
import { AuthAdapterProvider } from "../../shared/auth/provider";
import { createStaticAuthAdapter } from "../../shared/auth/static-auth-adapter";
import {
  DOCUMENT_STATUS_LABELS,
  ISSUE_STATUS_LABELS,
} from "../../shared/lib/artifact-status-labels";
import type { FixtureRoute } from "../../shared/storybook/fixture-fetch";
import { projectTreeKeys } from "../hooks/project-tree-keys";
import { ProjectArtifactList } from "./project-artifact-list";
import {
  projectStoryArtifact as artifact,
  projectStoryProject as project,
} from "./project-artifact-story-fixtures";

const child = {
  ...artifact,
  id: "33333333-3333-4333-8333-333333333333",
  name: "Implement project surface",
  slug: "ISS-1",
  subtype: ArtifactSubtype.Feature,
  status: IssueStatus.Todo,
  parentId: artifact.id,
  depth: 1,
  linkType: LinkType.Produces,
};
const grandchild = {
  ...child,
  id: "44444444-4444-4444-8444-444444444444",
  name: "Persist hierarchy changes",
  slug: "ISS-2",
  parentId: child.id,
  depth: 2,
};
const leaf = {
  ...child,
  id: "55555555-5555-4555-8555-555555555555",
  name: "Verify both shells",
  slug: "ISS-3",
  parentId: grandchild.id,
  depth: 3,
};
const independent = {
  ...child,
  id: "66666666-6666-4666-8666-666666666666",
  name: "Independent issue",
  slug: "ISS-4",
  parentId: null,
  depth: 0,
};
const baseTree: ProjectTreeDetailsResponse = {
  nodes: [
    { root: artifact, children: [child, grandchild, leaf] },
    { root: independent, children: [] },
  ],
  externalParents: [],
  projectVersion: "revision-1",
};
const transactionId = "77777777-7777-4777-8777-777777777777";
const defaultQuery =
  "group=none&columns=owner,collaborators,status,relatedSessions,comments,updated,currentVersion,tags";
const boardQuery = `${defaultQuery.replace("group=none", "group=status")}&layout=board`;
const boardOrganizationId = "00000000-0000-4000-8000-000000000001";
const boardUserId = "00000000-0000-4000-8000-000000000002";
const boardStatusLabels: Record<string, string> = {
  ...DOCUMENT_STATUS_LABELS,
  ...ISSUE_STATUS_LABELS,
};
/**
 * The fixture's mutable server state. The routes live on `parameters.appCore`
 * for the preview's one harness (ISS-5697), so they cannot close over the
 * story's React state; each mount resets this instead.
 */
const storyWorld = createStoryWorld();

type MutationState = "success" | "pending" | "failure" | "conflict";

type FixtureProps = {
  state:
    | "populated"
    | "loading"
    | "empty"
    | "error"
    | "truncated"
    | "external-parent"
    | "source-managed";
  query: string;
  projectId: string;
  preferences: "default" | "saved-columns" | "old-payload";
  organizationId: string;
  peopleOverflow: boolean;
};

function ProjectArtifactFixture(props: FixtureProps) {
  return <ProjectArtifactFixtureBody key={JSON.stringify(props)} {...props} />;
}

function ProjectArtifactFixtureBody({
  state,
  query,
  projectId,
  preferences,
  organizationId,
  peopleOverflow,
}: FixtureProps) {
  useState(() => {
    seedStoryPreferences(projectId, organizationId, preferences);
    storyWorld.reset(storyTree(state), { projectId, peopleOverflow });
    return null;
  });
  const tree = useSyncExternalStore(
    storyWorld.subscribe,
    storyWorld.readTree,
    storyWorld.readTree
  );
  const [failed, setFailed] = useState(state === "error");
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const [navigated, setNavigated] = useState(false);
  useLayoutEffect(() => {
    queryClient.setQueryData(projectTreeKeys.detail(projectId), tree);
  }, [projectId, queryClient, tree]);
  useLayoutEffect(() => {
    navigation.replace(`/teams/team-story/projects/${projectId}?${query}`);
    setNavigated(true);
  }, [navigation, projectId, query]);
  if (!navigated) {
    return null;
  }
  return (
    <AuthAdapterProvider
      adapter={createStaticAuthAdapter({ orgId: organizationId })}
    >
      <ProjectArtifactList
        failed={failed}
        loading={state === "loading"}
        onRefresh={async () => tree}
        onRequestCreate={() => undefined}
        onRetry={() => {
          setFailed(false);
          storyWorld.updateTree(() => baseTree);
        }}
        project={{ ...project, id: projectId }}
        teamId="team-story"
        tree={tree}
      />
    </AuthAdapterProvider>
  );
}

const meta = {
  title: "Composites/Your Teams/Project Detail/Project Artifact List",
  component: ProjectArtifactFixture,
  tags: ["preview", "autodocs"],
  parameters: {
    layout: "fullscreen",
    appCore: { apiRoutes: storyRoutes("success") },
  },
  args: {
    state: "populated",
    query: defaultQuery,
    projectId: project.id,
    preferences: "default",
    organizationId: "org_test",
    peopleOverflow: false,
  },
  argTypes: {
    state: {
      control: "select",
      options: [
        "populated",
        "loading",
        "empty",
        "error",
        "truncated",
        "external-parent",
        "source-managed",
      ],
    },
    query: { control: "text" },
    projectId: { control: "text" },
    organizationId: { control: "text" },
    peopleOverflow: { control: "boolean" },
    preferences: {
      control: "select",
      options: ["default", "saved-columns", "old-payload"],
    },
  },
} satisfies Meta<typeof ProjectArtifactFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Verify both shells")).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Collapse PRD-1" })
    );
    await expect(
      canvas.queryByText("Verify both shells")
    ).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Expand PRD-1" }));
    await expect(canvas.getByText("Verify both shells")).toBeVisible();
  },
};
export const Loading: Story = { args: { state: "loading" } };
export const Empty: Story = { args: { state: "empty" } };
export const EmptyBoardLanes: Story = {
  args: { state: "empty", query: "layout=board&group=status&emptyGroups=true" },
  parameters: {
    appCore: { enabledFlags: [MANUAL_ARTIFACT_ORDERING_FLAG_KEY] },
  },
};
export const ErrorState: Story = { name: "Error", args: { state: "error" } };
export const ManualOrdering: Story = {
  parameters: {
    appCore: {
      apiRoutes: storyRoutes("success"),
      enabledFlags: [MANUAL_ARTIFACT_ORDERING_FLAG_KEY],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const firstRoot = (
      await canvas.findByText("Delivery plan")
    ).closest<HTMLElement>("[role='row']");
    if (!firstRoot) {
      throw new Error("Expected the hierarchy root row");
    }
    // ISS-12687 (#8963) opens the flag-on hierarchy collapsed.
    await expect(
      canvas.queryByText("Implement project surface")
    ).not.toBeInTheDocument();
    await userEvent.click(
      within(firstRoot).getByRole("button", { name: "Expand row" })
    );
    await expect(
      await canvas.findByText("Implement project surface")
    ).toBeVisible();
    await userEvent.click(
      within(firstRoot).getByRole("button", { name: "Collapse row" })
    );
    await expect(
      canvas.queryByText("Implement project surface")
    ).not.toBeInTheDocument();
  },
};
export const Truncated: Story = { args: { state: "truncated" } };
export const ExternalParent: Story = { args: { state: "external-parent" } };
export const SourceManagedStatus: Story = { args: { state: "source-managed" } };
export const RootOnlyBoard: Story = {
  args: { query: boardQuery },
  parameters: {
    appCore: { enabledFlags: [MANUAL_ARTIFACT_ORDERING_FLAG_KEY] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Delivery plan")).toBeVisible();
    await expect(canvas.getByText("Independent issue")).toBeVisible();
    await expect(
      canvas.queryByText("Verify both shells")
    ).not.toBeInTheDocument();
  },
};
export const GroupedBoardFields: Story = {
  args: { query: boardQuery },
  parameters: {
    appCore: { enabledFlags: [MANUAL_ARTIFACT_ORDERING_FLAG_KEY] },
  },
};
export const MultiSelectedBoardRoots: Story = {
  args: { query: boardQuery },
  parameters: {
    appCore: { enabledFlags: [MANUAL_ARTIFACT_ORDERING_FLAG_KEY] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const first = (await canvas.findByText("Delivery plan")).closest(
      "[data-artifact-board-card]"
    );
    const last = canvas
      .getByText("Independent issue")
      .closest("[data-artifact-board-card]");
    if (!(first && last)) {
      throw new Error("Expected real board card selection targets");
    }
    fireEvent.click(first);
    fireEvent.click(last, { ctrlKey: true });
    const selectionActions = canvasElement.querySelector<HTMLElement>(
      "[data-preserve-artifact-selection]"
    );
    if (!selectionActions) {
      throw new Error("Expected the board selection actions");
    }
    await expect(
      within(selectionActions).getByText("2 artifacts selected")
    ).toBeVisible();
    await expect(
      within(selectionActions).getByRole("button", { name: "Clear selection" })
    ).toBeVisible();
  },
};
export const CollaboratorOverflow: Story = { args: { peopleOverflow: true } };
export const SelectedRange: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const first = await canvas.findByText("Delivery plan");
    await userEvent.click(first.closest("[data-grid-row-id]") ?? first);
    await expect(
      canvas.getByRole("toolbar", { name: "1 artifact selected" })
    ).toBeVisible();
    const last = canvas.getByText("Independent issue");
    fireEvent.click(last.closest("[data-grid-row-id]") ?? last, {
      shiftKey: true,
    });
    await expect(
      canvas.getByRole("toolbar", { name: "5 artifacts selected" })
    ).toBeVisible();
  },
};
export const EditableArtifacts: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await editFirstTitle(canvasElement);
    await expect(
      await canvas.findByText("Updated delivery plan")
    ).toBeVisible();
  },
};
export const InlineIssueCreation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add issue" })
    );
    await userEvent.type(
      await canvas.findByRole("textbox", { name: "Add issue name" }),
      "New inline issue{Enter}"
    );
    await expect(await canvas.findByText("New inline issue")).toBeVisible();
    const next = await canvas.findByRole("textbox", { name: "Add issue name" });
    await userEvent.type(next, "{Escape}");
    await expect(
      canvas.queryByRole("textbox", { name: "Add issue name" })
    ).not.toBeInTheDocument();
  },
};
export const PendingSave: Story = {
  parameters: { appCore: { apiRoutes: storyRoutes("pending") } },
  play: async ({ canvasElement }) => editFirstTitle(canvasElement),
};
export const FailedSave: Story = {
  parameters: { appCore: { apiRoutes: storyRoutes("failure") } },
  play: async ({ canvasElement }) => editFirstTitle(canvasElement),
};
export const ConflictRecovery: Story = {
  parameters: { appCore: { apiRoutes: storyRoutes("conflict") } },
  play: async ({ canvasElement }) => editFirstTitle(canvasElement),
};
export const ExactUrlOverrides: Story = {
  args: {
    query:
      "columns=owner,collaborators,status,relatedSessions,comments,updated,currentVersion,tags&metrics=project-completion,artifact-count,estimated-total-cost,median-token-cost,metric-five&layout=list&group=none&range=7d",
  },
};
export const UnknownOldFields: Story = {
  args: {
    query:
      "columns=retired-field,status&metrics=retired-metric,artifact-count&group=retired-group&range=7d",
  },
};
export const ColumnOverflow: Story = {
  globals: { viewport: { value: "390-844" } },
  args: { query: `${defaultQuery},priority,parent` },
};
export const SavedColumnsRestore: Story = {
  args: { preferences: "saved-columns", query: "group=none" },
};
export const OldStoredPayload: Story = {
  args: { preferences: "old-payload", query: "group=none" },
};
export const FilteredDescendant: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      await canvas.findByRole("textbox", { name: "Filter items" }),
      "Verify both shells"
    );
    await expect(canvas.getByText("Delivery plan")).toBeVisible();
    await expect(canvas.getByText("Verify both shells")).toBeVisible();
    await expect(
      canvas.queryByText("Independent issue")
    ).not.toBeInTheDocument();
  },
};
export const KeyboardMoveUndo: Story = {
  args: { query: `${defaultQuery}&layout=list` },
  parameters: {
    appCore: {
      apiRoutes: storyRoutes("success"),
      enabledFlags: [MANUAL_ARTIFACT_ORDERING_FLAG_KEY],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const handle = await canvas.findByRole("button", {
      name: "Drag to reorder ISS-4",
    });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowUp", ctrlKey: true });
    await waitFor(() => expect(storyWorld.placementRequestCount()).toBe(1));
    await waitFor(() =>
      expect(storyWorld.readTree().projectVersion).toBe("version-2")
    );
    await waitFor(() =>
      expect(canvasElement.querySelector("[data-grid-row-id]")).toHaveAttribute(
        "data-grid-row-id",
        independent.id
      )
    );
    await userEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(canvasElement.querySelector("[data-grid-row-id]")).toHaveAttribute(
        "data-grid-row-id",
        artifact.id
      )
    );
  },
};
export const SavedViewRestore: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      (await canvas.findAllByRole("button", { name: "Default view" }))[0]!
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Save current view" })
    );
    await userEvent.type(
      await screen.findByRole("textbox", { name: "View name" }),
      "Project review"
    );
    await userEvent.click(screen.getByRole("button", { name: "Save view" }));
    await userEvent.click(
      (await canvas.findAllByRole("button", { name: "Project review" }))[0]!
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Default view" })
    );
    await userEvent.click(
      (await canvas.findAllByRole("button", { name: "Default view" }))[0]!
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Project review" })
    );
    await expect(
      canvas.getAllByRole("button", { name: "Project review" })[0]
    ).toBeVisible();
  },
};
export const OtherOrganization: Story = {
  args: { organizationId: "org_other", query: "group=none" },
};
export const OtherProject: Story = {
  args: { projectId: "88888888-8888-4888-8888-888888888888" },
};

function storyTree(state: FixtureProps["state"]): ProjectTreeDetailsResponse {
  if (state === "empty") {
    return { ...baseTree, nodes: [] };
  }
  if (state === "source-managed") {
    return {
      ...baseTree,
      nodes: [
        {
          root: {
            ...artifact,
            type: ArtifactType.Branch,
            subtype: null,
            status: BranchStatus.Open,
          },
          children: [],
        },
      ],
    };
  }
  if (state === "external-parent") {
    return {
      ...baseTree,
      externalParents: [
        {
          childId: artifact.id,
          parent: {
            ...artifact,
            id: "99999999-9999-4999-8999-999999999999",
            name: "External parent",
            slug: "PRD-2",
          },
          linkType: LinkType.Produces,
        },
      ],
    };
  }
  if (state === "truncated") {
    return {
      ...baseTree,
      truncation: {
        anchorsIncluded: 2,
        anchorsMatchedAtLeast: 3,
        reasons: [TreeTruncationReason.AnchorCap],
      },
    };
  }
  return baseTree;
}

function storyRoutes(mutationState: MutationState): FixtureRoute[] {
  return [
    { method: "GET", path: "/me", respond: () => null },
    { method: "GET", path: "/teams/*", respond: () => [] },
    {
      method: "GET",
      path: "/projects",
      respond: () => [{ ...project, id: storyWorld.projectId() }],
    },
    {
      method: "GET",
      path: "/artifacts/collaborators",
      respond: ({ searchParams }) => ({
        results: searchParams.getAll("artifactIds").map((artifactId) => ({
          artifactId,
          artifactType: searchParams.get("artifactType"),
          commentCount: 0,
          collaborators: {
            availability: BranchIdentityAvailability.Complete,
            people: storyWorld.peopleOverflow() ? storyPeople() : [],
            sources: {
              [DirectCollaboratorSource.Creator]:
                BranchIdentityAvailability.Complete,
              [DirectCollaboratorSource.Interactions]:
                BranchIdentityAvailability.Complete,
              [DirectCollaboratorSource.Comments]:
                BranchIdentityAvailability.Complete,
            },
          },
        })),
      }),
    },
    {
      method: "POST",
      path: "/artifacts/related-sessions",
      respond: ({ body }) => ({
        results: Object.fromEntries(
          readArtifactIds(body).map((id) => [id, { items: [], total: 0 }])
        ),
      }),
    },
    {
      method: "POST",
      path: "/documents/costs",
      respond: () => ({ artifacts: [] }),
    },
    {
      method: "POST",
      path: "/documents",
      status: writeStatus(mutationState),
      respond: async ({ body }) => {
        await awaitWrite(mutationState);
        const title =
          body &&
          typeof body === "object" &&
          "title" in body &&
          typeof body.title === "string"
            ? body.title
            : "";
        const created = {
          ...independent,
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          slug: "ISS-5",
          name: title,
        };
        storyWorld.updateTree((current) => ({
          ...current,
          nodes: [...current.nodes, { root: created, children: [] }],
        }));
        return { id: created.id };
      },
    },
    {
      method: "PUT",
      path: "/documents/*",
      status: writeStatus(mutationState),
      respond: async ({ pathname, body }) => {
        await awaitWrite(mutationState);
        const id = pathname.split("/").at(-1);
        storyWorld.updateTree((current) => ({
          ...current,
          nodes: current.nodes.map((node) => ({
            root: updateStoryArtifact(node.root, id, body),
            children: node.children.map((item) => ({
              ...item,
              ...updateStoryArtifact(item, id, body),
            })),
          })),
        }));
        return { id };
      },
    },
    {
      method: "GET",
      path: `/projects/${project.id}/artifacts/board`,
      respond: ({ searchParams }) => storyBoardPage(searchParams),
    },
    {
      method: "GET",
      path: `/projects/${project.id}/artifacts/placement`,
      respond: () => ({
        projectId: storyWorld.projectId(),
        projectVersion: storyWorld.readTree().projectVersion,
        canPlaceArtifacts: true,
      }),
    },
    {
      method: "POST",
      path: `/projects/${project.id}/artifacts/placement`,
      status: writeStatus(mutationState),
      respond: async ({ body }) => {
        storyWorld.recordPlacementRequest();
        await awaitWrite(mutationState);
        const input = projectArtifactPlacementValidator.parse(body);
        const revision = storyWorld.applyPlacement(
          input.kind === ProjectArtifactPlacementKind.Undo
        );
        const projectId = storyWorld.projectId();
        return {
          placed: true,
          transactionId,
          affectedArtifactIds: [artifact.id, independent.id],
          affectedProjectIds: [projectId],
          projectVersions: { [projectId]: `version-${revision}` },
          placement:
            input.kind === ProjectArtifactPlacementKind.Place
              ? {
                  sourceArtifactIds: input.sourceArtifactIds,
                  destinationProjectId: input.destinationProjectId,
                  position: input.position,
                  ...(input.targetArtifactId
                    ? { targetArtifactId: input.targetArtifactId }
                    : {}),
                }
              : {
                  sourceArtifactIds: [independent.id],
                  destinationProjectId: projectId,
                  position: ProjectArtifactPlacementPosition.Root,
                },
          replayed: false,
          undoAvailable: input.kind === ProjectArtifactPlacementKind.Place,
        };
      },
    },
  ];
}

function storyBoardPage(searchParams: URLSearchParams) {
  const tree = storyWorld.readTree();
  const cards = tree.nodes.map(({ root, children }) => ({
    artifact: boardArtifact(root),
    descendantCount: children.length,
  }));
  const groupBy = searchParams.get("groupBy");
  const laneIds =
    groupBy === ProjectArtifactBoardGroup.Status
      ? [...new Set(cards.map(({ artifact: item }) => item.status))]
      : [ProjectArtifactBoardGroup.None];
  const lanes = laneIds.map((id) => {
    const laneCards =
      groupBy === ProjectArtifactBoardGroup.Status
        ? cards.filter(({ artifact: item }) => item.status === id)
        : cards;
    return {
      cards: laneCards,
      complete: true,
      count: laneCards.length,
      id,
      label: boardStatusLabels[id] ?? id,
    };
  });
  return {
    lanes,
    populationRevision: "a".repeat(64),
    projectVersion: tree.projectVersion,
    rootIds: cards.map(({ artifact: item }) => item.id),
  };
}

// The list fixture uses opaque principal IDs; the board wire validator requires UUIDs.
function boardArtifact(source: DetailedArtifact): DetailedArtifact {
  return {
    ...source,
    organizationId: boardOrganizationId,
    createdById: boardUserId,
  };
}

function readArtifactIds(body: unknown): string[] {
  if (
    body &&
    typeof body === "object" &&
    "artifactIds" in body &&
    Array.isArray(body.artifactIds)
  ) {
    return body.artifactIds.filter(
      (id): id is string => typeof id === "string"
    );
  }
  return [];
}
function writeStatus(state: MutationState) {
  if (state === "failure") {
    return 503;
  }
  if (state === "conflict") {
    return 409;
  }
  return 200;
}
async function awaitWrite(state: MutationState) {
  if (state === "pending") {
    await new Promise(() => undefined);
  }
}
function updateStoryArtifact<T extends typeof artifact>(
  source: T,
  id: string | undefined,
  body: unknown
): T {
  if (source.id !== id || !body || typeof body !== "object") {
    return source;
  }
  const patch = body as {
    title?: string;
    status?: DocumentStatus | IssueStatus;
  };
  return {
    ...source,
    ...(patch.title ? { name: patch.title } : {}),
    ...(patch.status ? { status: patch.status } : {}),
  };
}

async function editFirstTitle(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(
    await canvas.findByRole("button", { name: "Edit artifact name for PRD-1" })
  );
  const editor = canvas.getByRole("textbox", {
    name: "Edit artifact name for PRD-1",
  });
  await userEvent.clear(editor);
  await userEvent.type(editor, "Updated delivery plan{Enter}");
}
function seedStoryPreferences(
  projectId: string,
  organizationId: string,
  preferences: FixtureProps["preferences"]
) {
  const namespace = `table:view:project-artifacts-portable:team-story:${projectId}::id:user_test:${organizationId}`;
  for (const suffix of [
    "columns",
    "column-order",
    "column-widths",
    "metrics",
    "expansion",
    "saved-views",
  ]) {
    globalThis.localStorage.removeItem(`${namespace}:${suffix}`);
  }
  if (preferences === "saved-columns") {
    globalThis.localStorage.setItem(
      `${namespace}:columns`,
      JSON.stringify({ savedAt: Date.now(), data: ["status", "comments"] })
    );
  }
  if (preferences === "old-payload") {
    globalThis.localStorage.setItem(
      `${namespace}:columns`,
      JSON.stringify({ savedAt: Date.now(), data: { retired: true } })
    );
  }
}

function storyPeople() {
  return [
    "Ada Lovelace",
    "Grace Hopper",
    "Margaret Hamilton",
    "Alan Turing",
    "Barbara Liskov",
    "Donald Knuth",
  ].map((displayName, index) => ({
    provider: BranchPersonProvider.ClosedLoop,
    id: `person-${index}`,
    displayName,
  }));
}

function createStoryWorld() {
  let tree = baseTree;
  let previous = baseTree;
  let revision = 1;
  let projectId = project.id;
  let peopleOverflow = false;
  let placementRequestCount = 0;
  const listeners = new Set<() => void>();
  const updateTree = (
    updater: (current: ProjectTreeDetailsResponse) => ProjectTreeDetailsResponse
  ) => {
    tree = updater(tree);
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    reset(
      next: ProjectTreeDetailsResponse,
      options: { projectId: string; peopleOverflow: boolean }
    ) {
      tree = next;
      previous = baseTree;
      revision = 1;
      projectId = options.projectId;
      peopleOverflow = options.peopleOverflow;
      placementRequestCount = 0;
    },
    readTree: () => tree,
    projectId: () => projectId,
    peopleOverflow: () => peopleOverflow,
    placementRequestCount: () => placementRequestCount,
    recordPlacementRequest: () => {
      placementRequestCount++;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    updateTree,
    applyPlacement(undo: boolean): number {
      revision++;
      const nextVersion = `version-${revision}`;
      updateTree((current) => {
        if (undo) {
          return {
            ...previous,
            projectVersion: nextVersion,
          };
        }
        previous = current;
        return {
          ...current,
          nodes: [...current.nodes].reverse(),
          projectVersion: nextVersion,
        };
      });
      return revision;
    },
  };
}
