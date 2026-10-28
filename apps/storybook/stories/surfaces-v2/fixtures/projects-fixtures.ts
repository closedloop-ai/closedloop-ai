import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import {
  ProjectStatus,
  type ProjectWithDetails,
} from "@repo/api/src/types/project";
import {
  ProjectArtifactPlacementKind,
  projectArtifactPlacementValidator,
} from "@repo/api/src/types/project-artifact-placement";
import type {
  DetailedArtifact,
  ProjectTreeDetailsResponse,
} from "@repo/api/src/types/project-tree";
import { type Tag, TagColor } from "@repo/api/src/types/tag";
import {
  type TeamMember,
  type TeamRepository,
  TeamRole,
  type TeamWithCounts,
} from "@repo/api/src/types/teams";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";
import { makeProject } from "@repo/app/shared/test-fixtures/project";
import { liveAppShellRoutes, sessionListResponse } from "./live-app-fixtures";
import {
  dana,
  hana,
  marco,
  noFavoritesRoute,
  orgUsersRoute,
  priya,
} from "./org-people-fixtures";
import { sessionsListRowsFixture } from "./sessions-list-fixtures";

// The live team Projects pages (`apps/app/.../teams/[teamId]/projects/...`)
// read the team (`GET /teams/:teamId`) and its projects
// (`GET /projects?teamId=…`, active ones by `excludeStatus=ARCHIVED`, archived
// ones by `status=ARCHIVED`). The team is the Global Nav's "Platform
// Engineering", so its sidebar item is the active one.

export const PROJECTS_TEAM_ID = "platform-engineering";
export const PROJECTS_PATH = `/teams/${PROJECTS_TEAM_ID}/projects`;

export const projectsTeamFixture: TeamWithCounts = {
  createdAt: new Date("2026-01-12T09:00:00.000Z"),
  id: PROJECTS_TEAM_ID,
  memberCount: 4,
  name: "Platform Engineering",
  organizationId: "org_test",
  projectCount: 6,
  slug: PROJECTS_TEAM_ID,
  updatedAt: new Date("2026-09-30T09:00:00.000Z"),
};

const TEAMS = [{ id: PROJECTS_TEAM_ID, name: "Platform Engineering" }];

function project(
  index: number,
  overrides: Partial<ProjectWithDetails> & Pick<ProjectWithDetails, "name">
): ProjectWithDetails {
  return makeProject({
    createdAt: new Date("2026-07-01T09:00:00.000Z"),
    createdById: dana.id,
    id: `project-${index}`,
    organizationId: "org_test",
    slug: `PRO-${40 + index}`,
    sortOrder: index,
    teams: TEAMS,
    updatedAt: new Date("2026-10-05T12:00:00.000Z"),
    ...overrides,
  });
}

export const projectsFixture: ProjectWithDetails[] = [
  project(1, {
    assignee: dana,
    assigneeId: dana.id,
    completionPercentage: 64,
    description: "Branch and session traces in one timeline.",
    name: "Session trace timeline",
    priority: Priority.High,
    status: ProjectStatus.InProgress,
    targetDate: new Date("2026-10-24T00:00:00.000Z"),
  }),
  project(2, {
    assignee: priya,
    assigneeId: priya.id,
    completionPercentage: 38,
    description: "Retry and backoff for desktop sync.",
    name: "Desktop sync reliability",
    priority: Priority.Urgent,
    status: ProjectStatus.InProgress,
    targetDate: new Date("2026-10-15T00:00:00.000Z"),
  }),
  project(3, {
    assignee: marco,
    assigneeId: marco.id,
    completionPercentage: 82,
    description: "Usage, cost and lost-work insights.",
    name: "Insights v2",
    priority: Priority.Medium,
    status: ProjectStatus.InProgress,
    targetDate: new Date("2026-11-07T00:00:00.000Z"),
  }),
  project(4, {
    assignee: hana,
    assigneeId: hana.id,
    completionPercentage: 0,
    description: "Storybook pages that match the live app.",
    name: "Design system convergence",
    priority: Priority.Medium,
    status: ProjectStatus.NotStarted,
    targetDate: new Date("2026-12-01T00:00:00.000Z"),
  }),
  project(5, {
    assignee: dana,
    assigneeId: dana.id,
    completionPercentage: 100,
    description: "Guided onboarding and the dashboard tour.",
    name: "Guided onboarding",
    priority: Priority.Low,
    status: ProjectStatus.Completed,
    targetDate: new Date("2026-09-26T00:00:00.000Z"),
  }),
  project(6, {
    assignee: marco,
    assigneeId: marco.id,
    completionPercentage: 51,
    description: "Compute target health and pairing.",
    name: "Compute targets",
    priority: Priority.High,
    status: ProjectStatus.InProgress,
    targetDate: new Date("2026-10-31T00:00:00.000Z"),
  }),
];

export const archivedProjectsFixture: ProjectWithDetails[] = [
  project(7, {
    assignee: priya,
    assigneeId: priya.id,
    completionPercentage: 100,
    name: "Loop runner migration",
    priority: Priority.Medium,
    status: ProjectStatus.Archived,
  }),
  project(8, {
    assignee: dana,
    assigneeId: dana.id,
    completionPercentage: 72,
    name: "Legacy issues board",
    priority: Priority.Low,
    status: ProjectStatus.Archived,
  }),
];

export const projectsTeamMembersFixture: TeamMember[] = [
  dana,
  priya,
  marco,
  hana,
].map((user, index) => ({
  createdAt: new Date("2026-01-12T09:00:00.000Z"),
  id: `team-member-${index + 1}`,
  role: index === 0 ? TeamRole.Admin : TeamRole.Member,
  teamId: PROJECTS_TEAM_ID,
  user,
  userId: user.id,
}));

/** The workspace's tags (`GET /tags`), for the artifact table's Tags filter. */
export const workspaceTagsFixture: Tag[] = [
  { color: TagColor.Blue, id: "tag-platform", name: "Platform" },
  { color: TagColor.Violet, id: "tag-q4", name: "Q4" },
].map((tag) => ({
  ...tag,
  createdAt: new Date("2026-01-12T09:00:00.000Z"),
  createdById: dana.id,
  organizationId: "org_test",
  updatedAt: new Date("2026-01-12T09:00:00.000Z"),
}));

/** The repositories the team works in (`GET /teams/:teamId/repositories`). */
export const projectsTeamRepositoriesFixture: TeamRepository[] = [
  "closedloop-ai",
  "desktop",
].map((name, index) => ({
  createdAt: new Date("2026-01-12T09:30:00.000Z"),
  id: `team-repo-${index + 1}`,
  installationRepositoryId: `install-repo-${index + 1}`,
  isDefaultSelected: index === 0,
  isPrimary: index === 0,
  repository: {
    fullName: `closedloop-ai/${name}`,
    githubRepoId: `${70_000 + index}`,
    id: `install-repo-${index + 1}`,
    installationId: "ghi_test",
    name,
    owner: "closedloop-ai",
    private: true,
  },
  teamId: PROJECTS_TEAM_ID,
  updatedAt: new Date("2026-01-12T09:30:00.000Z"),
}));

/** The project Project Detail opens: Session trace timeline. */
export const projectDetailFixture = projectsFixture[0] as ProjectWithDetails;

function doc(
  id: string,
  subtype: DetailedArtifact["subtype"],
  slug: string,
  name: string,
  status: string,
  assignee: typeof dana,
  updatedAt: string
): DetailedArtifact {
  const artifact = makeRawArtifact(ArtifactType.Document, {
    assignee,
    assigneeId: assignee.id,
    createdAt: new Date("2026-09-02T09:00:00.000Z"),
    createdById: dana.id,
    id,
    name,
    organizationId: "org_test",
    priority: Priority.High,
    projectId: projectDetailFixture.id,
    slug,
    status,
    subtype,
    updatedAt: new Date(updatedAt),
  });
  return {
    ...artifact,
    tags: [{ color: TagColor.Blue, id: "tag-platform", name: "Platform" }],
  };
}

const prd = doc(
  "prd-1",
  ArtifactSubtype.Prd,
  "PRD-812",
  "Session trace timeline",
  DocumentStatus.Approved,
  dana,
  "2026-10-01T10:00:00.000Z"
);
const plan = doc(
  "plan-1",
  ArtifactSubtype.ImplementationPlan,
  "PLN-2140",
  "Session trace timeline: implementation plan",
  DocumentStatus.InReview,
  priya,
  "2026-10-03T15:00:00.000Z"
);
const issues = [
  doc(
    "issue-1",
    ArtifactSubtype.Feature,
    "ISS-11402",
    "Wire session lanes into the branch trace",
    IssueStatus.InProgress,
    dana,
    "2026-10-06T08:00:00.000Z"
  ),
  doc(
    "issue-2",
    ArtifactSubtype.Feature,
    "ISS-11403",
    "Comments rail for the combined trace",
    IssueStatus.InReview,
    marco,
    "2026-10-05T17:00:00.000Z"
  ),
  doc(
    "issue-3",
    ArtifactSubtype.Feature,
    "ISS-11404",
    "Timeline zoom presets",
    IssueStatus.Todo,
    hana,
    "2026-10-04T12:00:00.000Z"
  ),
];
const runbook = doc(
  "doc-7",
  ArtifactSubtype.Doc,
  "DOC-118",
  "Trace timeline rollout notes",
  DocumentStatus.Draft,
  priya,
  "2026-09-30T09:00:00.000Z"
);

const branch: DetailedArtifact = makeRawArtifact(ArtifactType.Branch, {
  assignee: dana,
  assigneeId: dana.id,
  createdAt: new Date("2026-10-02T09:00:00.000Z"),
  externalUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/7031",
  id: "branch-4410",
  name: "fea-4410-branch-trace",
  organizationId: "org_test",
  projectId: "project-1",
  slug: "BR-4410",
  updatedAt: new Date("2026-10-06T09:24:00.000Z"),
});

/** The project's PRD, its plan and issues, as the artifact reads carry them. */
export const projectArtifactsFixture = { branch, issues, plan, prd };

/** The project's artifact tree: the PRD produces its plan and issues. */
export const projectTreeFixture: ProjectTreeDetailsResponse = {
  externalParents: [],
  nodes: [
    {
      children: [plan, ...issues].map((child) => ({
        ...child,
        depth: 1,
        linkType: LinkType.Produces,
        parentId: prd.id,
      })),
      root: prd,
    },
    { children: [], root: runbook },
    { children: [], root: branch },
  ],
};

/** The same tree with every artifact finished, so "Hide completed" hides all. */
export const completedProjectTreeFixture: ProjectTreeDetailsResponse = {
  ...projectTreeFixture,
  nodes: projectTreeFixture.nodes.map((node) => ({
    children: node.children.map((child) => ({
      ...child,
      status:
        child.subtype === ArtifactSubtype.Feature
          ? IssueStatus.Done
          : DocumentStatus.Executed,
    })),
    root: { ...node.root, status: DocumentStatus.Executed },
  })),
};

/** The reads the team Projects pages make, answered with `projects`. */
export function projectsRoutes(
  projects: ProjectWithDetails[] = projectsFixture,
  archived: ProjectWithDetails[] = archivedProjectsFixture,
  projectTree: ProjectTreeDetailsResponse = projectTreeFixture
): FixtureRoute[] {
  return [
    ...liveAppShellRoutes,
    orgUsersRoute,
    noFavoritesRoute,
    { method: "GET", path: "/projects/favorites", respond: () => [] },
    { method: "GET", path: "/tags", respond: () => workspaceTagsFixture },
    {
      method: "GET",
      path: `/teams/${PROJECTS_TEAM_ID}`,
      respond: () => projectsTeamFixture,
    },
    {
      method: "GET",
      path: `/teams/${PROJECTS_TEAM_ID}/repositories`,
      respond: () => projectsTeamRepositoriesFixture,
    },
    {
      method: "GET",
      path: `/teams/${PROJECTS_TEAM_ID}/members`,
      respond: () => projectsTeamMembersFixture,
    },
    {
      // The project header's active-sessions status reads one running session.
      method: "GET",
      path: "/agent-sessions",
      respond: () => sessionListResponse(sessionsListRowsFixture.slice(0, 1)),
    },
    {
      method: "GET",
      path: `/projects/${projectDetailFixture.id}/tree`,
      respond: () => projectTree,
    },
    {
      method: "POST",
      path: `/projects/${projectDetailFixture.id}/artifacts/placement`,
      respond: ({ body }) => {
        const placement = projectArtifactPlacementValidator.parse(body);
        if (placement.kind !== ProjectArtifactPlacementKind.Place) {
          throw new Error("Project detail fixture accepts placement only");
        }
        return {
          affectedArtifactIds: placement.sourceArtifactIds,
          affectedProjectIds: [placement.destinationProjectId],
          placed: true,
          placement: {
            destinationProjectId: placement.destinationProjectId,
            position: placement.position,
            sourceArtifactIds: placement.sourceArtifactIds,
            ...(placement.targetArtifactId
              ? { targetArtifactId: placement.targetArtifactId }
              : {}),
          },
          projectVersions: {
            [placement.destinationProjectId]: "story-version-next",
          },
          replayed: false,
          transactionId: "a2837896-5542-4644-9262-21ad2d927a7e",
          undoAvailable: true,
        };
      },
    },
    {
      method: "GET",
      path: `/projects/${projectDetailFixture.id}`,
      respond: () => projectDetailFixture,
    },
    {
      method: "GET",
      path: "/projects",
      respond: ({ searchParams }) =>
        searchParams.get("status") === ProjectStatus.Archived
          ? archived
          : projects,
    },
  ];
}

export const projectsApiRoutes = projectsRoutes();
