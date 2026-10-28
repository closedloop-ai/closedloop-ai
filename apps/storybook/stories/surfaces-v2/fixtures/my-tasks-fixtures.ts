import {
  type Artifact,
  type ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  DOCUMENT_LIST_MAX_LIMIT,
  type DocumentListPage,
  DocumentStatus,
  DocumentType,
  type DocumentWithProject,
  IssueStatus,
} from "@repo/api/src/types/document";
import {
  ASSIGNED_ARTIFACT_TREE_PATH,
  type ProjectTreeResponse,
  type TreeChild,
} from "@repo/api/src/types/project-tree";
import type { BasicUser } from "@repo/api/src/types/user";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { makeProject } from "@repo/app/shared/test-fixtures/project";
import {
  currentUserFixture,
  liveAppShellRoutes,
  organizationUsersFixture,
} from "./live-app-fixtures";

// The live My Tasks (`apps/app/.../my-tasks/page.tsx`) reads the signed-in
// user's assigned documents (`GET /documents?assigneeId=…`), the projects those
// rows belong to and each project's tree.
// These are those responses for one engineer's working queue.

const ME: BasicUser = {
  avatarUrl: currentUserFixture.avatarUrl,
  email: currentUserFixture.email,
  firstName: currentUserFixture.firstName,
  id: currentUserFixture.id,
  lastName: currentUserFixture.lastName,
};

const EMMA = organizationUsersFixture[1] as BasicUser;

export const myTasksProjectsFixture = [
  makeProject({
    id: "prj_reliability",
    name: "Session Reliability",
    organizationId: "org_test",
    teams: [{ id: "team_platform", name: "Platform Engineering" }],
  }),
  makeProject({
    id: "prj_insights",
    name: "Insights v2",
    organizationId: "org_test",
    teams: [{ id: "team_closedloop", name: "ClosedLoop" }],
  }),
];

function project(id: string) {
  const match = myTasksProjectsFixture.find((p) => p.id === id);
  return match ? { id: match.id, name: match.name, teams: match.teams } : null;
}

function task(
  n: number,
  overrides: Partial<DocumentWithProject> & {
    title: string;
    type: DocumentWithProject["type"];
    projectId: string;
  }
): DocumentWithProject {
  const updated = new Date(Date.UTC(2026, 9, 6 - n, 15, 0, 0));
  return createMockDocument({
    approver: EMMA,
    approverId: EMMA.id,
    assignee: ME,
    assigneeId: ME.id,
    createdAt: new Date(Date.UTC(2026, 8, 20 - n, 9, 0, 0)),
    createdBy: EMMA,
    createdById: EMMA.id,
    id: `doc_task_${n}`,
    organizationId: "org_test",
    project: project(overrides.projectId),
    updatedAt: updated,
    ...overrides,
  });
}

export const myTasksDocumentsFixture: DocumentWithProject[] = [
  task(1, {
    priority: Priority.Urgent,
    projectId: "prj_reliability",
    slug: "ISS-1042",
    status: IssueStatus.InProgress,
    title: "Fix session transcripts truncating at 2 MB",
    type: DocumentType.Feature,
  }),
  task(2, {
    priority: Priority.High,
    projectId: "prj_reliability",
    slug: "ISS-1048",
    status: IssueStatus.InReview,
    title: "Retry desktop sync after a token refresh",
    type: DocumentType.Feature,
  }),
  task(3, {
    priority: Priority.High,
    projectId: "prj_reliability",
    slug: "PRD-212",
    status: DocumentStatus.Approved,
    title: "Session reliability: zero lost transcripts",
    type: DocumentType.Prd,
  }),
  task(4, {
    priority: Priority.Medium,
    projectId: "prj_reliability",
    slug: "PLN-318",
    status: DocumentStatus.InReview,
    title: "Chunked transcript upload plan",
    type: DocumentType.ImplementationPlan,
  }),
  task(5, {
    priority: Priority.Medium,
    projectId: "prj_insights",
    slug: "ISS-1057",
    status: IssueStatus.Todo,
    title: "Delivery chart: weekly buckets for long ranges",
    type: DocumentType.Feature,
  }),
  task(6, {
    priority: Priority.Low,
    projectId: "prj_insights",
    slug: "ISS-1063",
    status: IssueStatus.Backlog,
    title: "Agent leaderboard: show cost per merged PR",
    type: DocumentType.Feature,
  }),
  task(7, {
    priority: Priority.High,
    projectId: "prj_insights",
    slug: "PRD-219",
    status: DocumentStatus.Draft,
    title: "Insights v2: delivery and spend in one view",
    type: DocumentType.Prd,
  }),
  task(8, {
    priority: Priority.Medium,
    projectId: "prj_insights",
    slug: "ISS-1071",
    status: IssueStatus.Blocked,
    title: "Backfill token usage for archived sessions",
    type: DocumentType.Feature,
  }),
  task(9, {
    priority: Priority.Urgent,
    projectId: "prj_insights",
    slug: "ISS-1080",
    status: IssueStatus.Todo,
    title: "Dashboard KPI tiles show stale totals after sync",
    type: DocumentType.Feature,
  }),
];

export function documentListPage(
  items: readonly DocumentWithProject[]
): DocumentListPage {
  return {
    hasMore: false,
    items: [...items],
    limit: DOCUMENT_LIST_MAX_LIMIT,
    offset: 0,
    total: items.length,
  };
}

function docArtifact(doc: DocumentWithProject): Artifact {
  return {
    assignee: doc.assignee,
    assigneeId: doc.assigneeId,
    createdAt: doc.createdAt,
    createdById: doc.createdById,
    dueDate: null,
    externalUrl: null,
    id: doc.id,
    name: doc.title,
    organizationId: doc.organizationId,
    priority: doc.priority,
    projectId: doc.projectId,
    slug: doc.slug,
    sortOrder: null,
    status: doc.status,
    subtype: doc.type as ArtifactSubtype,
    type: ArtifactType.Document,
    updatedAt: doc.updatedAt,
  };
}

function child(artifact: Artifact, parentId: string, depth = 1): TreeChild {
  return { ...artifact, depth, linkType: LinkType.Produces, parentId };
}

function docById(slug: string): Artifact {
  const doc = myTasksDocumentsFixture.find((d) => d.slug === slug);
  if (!doc) {
    throw new Error(`no My Tasks fixture ${slug}`);
  }
  return docArtifact(doc);
}

/**
 * The signed-in user's assigned tree (`GET /artifacts/assigned-tree`): the
 * assigned PRDs with their plans and issues. The endpoint leaves out sessions
 * and branches (ISS-12463).
 */
export const myTasksAssignedTreeFixture: ProjectTreeResponse = {
  externalParents: [],
  nodes: [
    {
      children: [child(docById("ISS-1057"), "doc_task_7")],
      root: docById("PRD-219"),
    },
    { children: [], root: docById("ISS-1063") },
    { children: [], root: docById("ISS-1071") },
    { children: [], root: docById("ISS-1080") },
    {
      children: [
        child(docById("PLN-318"), "doc_task_3"),
        child(docById("ISS-1042"), "doc_task_4", 2),
        child(docById("ISS-1048"), "doc_task_4", 2),
      ],
      root: docById("PRD-212"),
    },
  ],
};

export const myTasksApiRoutes: FixtureRoute[] = [
  ...liveAppShellRoutes,
  { method: "GET", path: "/users", respond: () => organizationUsersFixture },
  { method: "GET", path: "/projects", respond: () => myTasksProjectsFixture },
  { method: "GET", path: "/artifacts/favorites", respond: () => [] },
  { method: "GET", path: "/tags", respond: () => [] },
  {
    method: "GET",
    path: "/documents",
    respond: () => documentListPage(myTasksDocumentsFixture),
  },
  {
    method: "GET",
    path: ASSIGNED_ARTIFACT_TREE_PATH,
    respond: () => myTasksAssignedTreeFixture,
  },
];
