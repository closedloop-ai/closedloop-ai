import {
  type ArtifactLinkEndpoint,
  type ArtifactLinkWithEndpoints,
  LinkType,
} from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  type DocumentDetail,
  DocumentStatus,
  DocumentType,
  type DocumentWithProject,
  IssueStatus,
  type PullRequestInfo,
  PullRequestState,
  RepositoryRole,
  SnapshotSource,
} from "@repo/api/src/types/document";
import { TagColor } from "@repo/api/src/types/tag";
import type {
  FixtureRequestContext,
  FixtureRoute,
} from "@repo/app/shared/storybook/fixture-fetch";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { liveAppShellRoutes } from "./live-app-fixtures";
import {
  dana,
  noFavoritesRoute,
  orgUsersRoute,
  priya,
} from "./org-people-fixtures";
import {
  PROJECTS_TEAM_ID,
  projectArtifactsFixture,
  projectDetailFixture,
  projectsFixture,
  projectsTeamMembersFixture,
} from "./projects-fixtures";
import { customFieldsFixture } from "./settings-fixtures";

// The live document routes (Document, PRD, Plan and Issue Detail) read the
// artifact by slug (`GET /documents/by-slug/:slug`, `?version=` for an older
// one) and then the panels around the editor. The artifacts are the ones the
// Project Detail and Documents List fixtures list, so links between pages
// name the same work.

const CREATED_AT = new Date("2026-09-02T09:00:00.000Z");

const PROJECT: DocumentWithProject["project"] = {
  id: projectDetailFixture.id,
  name: projectDetailFixture.name,
  teams: [{ id: PROJECTS_TEAM_ID, name: "Platform Engineering" }],
};

type DetailArgs = {
  id: string;
  type: DocumentType;
  slug: string;
  title: string;
  status: string;
  content: string;
  assignee: DocumentWithProject["assignee"];
  updatedAt: string;
  project?: DocumentWithProject["project"];
  latestVersion?: number;
  /** Which version `version.content` is. Defaults to the latest. */
  versionNumber?: number;
  latestContent?: string;
};

export function buildDocumentDetail({
  id,
  type,
  slug,
  title,
  status,
  content,
  assignee,
  updatedAt,
  project = PROJECT,
  latestVersion = 1,
  versionNumber = latestVersion,
  latestContent = content,
}: DetailArgs): DocumentDetail {
  return {
    ...createMockDocument({
      assignee,
      assigneeId: assignee?.id ?? null,
      createdAt: CREATED_AT,
      createdById: dana.id,
      id,
      latestVersion,
      organizationId: "org_test",
      priority: Priority.High,
      project,
      projectId: project?.id ?? null,
      // Project-less documents carry no repository; project work inherits the
      // project's default.
      repositorySnapshot: project
        ? {
            repositories: [
              {
                fullName: "closedloop-ai/closedloop-ai",
                position: 0,
                role: RepositoryRole.Primary,
              },
            ],
            source: SnapshotSource.ProjectDefaults,
          }
        : { repositories: [], source: SnapshotSource.None },
      slug,
      sortOrder: 1,
      status: status as DocumentWithProject["status"],
      tags: [{ color: TagColor.Blue, id: "tag-platform", name: "Platform" }],
      title,
      type,
      updatedAt: new Date(updatedAt),
    }),
    createdBy: dana,
    latestVersionContent: latestContent,
    version: {
      content,
      createdAt: new Date(updatedAt),
      createdById: dana.id,
      documentId: id,
      id: `${id}-v${versionNumber}`,
      version: versionNumber,
    },
  };
}

const PRD_MARKDOWN = `# Session trace timeline

## Problem
Engineers reviewing a branch jump between the branch page, each session's
trace and the PR to understand what an agent did. There is no single view of
the work in the order it happened.

## Goals
- One timeline for a branch: every session's turns, tool calls and commits.
- Comments anchored to a moment in the trace.
- Zoom from a whole branch to a single turn.

## Non-goals
- Replaying a session.
- Editing a trace.

## Requirements
1. The timeline lists sessions in lanes, newest last.
2. A commit links to the turn that produced it.
3. A reviewer can comment on any turn.

## Success metrics
- Median time to review an agent branch drops by 30%.
`;

const PLAN_MARKDOWN = `# Session trace timeline: implementation plan

## Approach
Build the combined trace from the existing per-session traces, keyed by
branch, and render it with the timeline primitives.

## Steps
1. Add a branch trace read that returns sessions as lanes.
2. Render lanes with the timeline component.
3. Anchor comments to turn ids.
4. Add zoom presets.

## Risks
- Large branches: page lanes beyond 20 sessions.
`;

const ISSUE_MARKDOWN = `# Wire session lanes into the branch trace

## Context
The branch trace shows one session at a time. Lanes let a reviewer see
every session on the branch together.

## Acceptance criteria
- [x] Each session on the branch renders as a lane.
- [ ] Lanes are ordered by start time.
- [ ] A lane collapses to its header.
`;

const DOC_MARKDOWN = `# Engineering onboarding guide

## First day
- Get access to GitHub, Linear and ClosedLoop.
- Install the desktop app and connect it to your workspace.

## First week
- Pair on one agent branch end to end.
- Review a PRD and its implementation plan.

## Where things live
| Topic | Where |
| --- | --- |
| Runbooks | Documents |
| Plans | Project pages |
`;

export const prdDetailFixture = buildDocumentDetail({
  content: PRD_MARKDOWN,
  id: "prd-1",
  assignee: dana,
  latestVersion: 3,
  slug: "PRD-812",
  status: DocumentStatus.Approved,
  title: "Session trace timeline",
  type: DocumentType.Prd,
  updatedAt: "2026-10-01T10:00:00.000Z",
});

export const planDetailFixture = buildDocumentDetail({
  assignee: priya,
  content: PLAN_MARKDOWN,
  id: "plan-1",
  latestVersion: 2,
  slug: "PLN-2140",
  status: DocumentStatus.InReview,
  title: "Session trace timeline: implementation plan",
  type: DocumentType.ImplementationPlan,
  updatedAt: "2026-10-03T15:00:00.000Z",
});

export const issueDetailFixture = buildDocumentDetail({
  assignee: dana,
  content: ISSUE_MARKDOWN,
  id: "issue-1",
  slug: "ISS-11402",
  status: IssueStatus.InProgress,
  title: "Wire session lanes into the branch trace",
  type: DocumentType.Feature,
  updatedAt: "2026-10-06T08:00:00.000Z",
});

export const docDetailFixture = buildDocumentDetail({
  assignee: dana,
  content: DOC_MARKDOWN,
  id: "doc-1",
  latestVersion: 2,
  project: null,
  slug: "DOC-101",
  status: DocumentStatus.Approved,
  title: "Engineering onboarding guide",
  type: DocumentType.Doc,
  updatedAt: "2026-10-06T08:40:00.000Z",
});

const LINKED_AT = new Date("2026-09-03T09:00:00.000Z");

function link(
  source: ArtifactLinkEndpoint,
  target: ArtifactLinkEndpoint
): ArtifactLinkWithEndpoints {
  return {
    createdAt: LINKED_AT,
    id: `link-${source.id}-${target.id}`,
    linkType: LinkType.Produces,
    metadata: null,
    organizationId: "org_test",
    source,
    sourceId: source.id,
    target,
    targetId: target.id,
  };
}

const { branch, issues, plan, prd } = projectArtifactsFixture;

/**
 * The project's lineage: the PRD produced its plan and issues, and the plan
 * produced the branch it is being built on.
 */
export const artifactLinksFixture = [
  ...[plan, ...issues].map((child) => link(prd, child)),
  link(plan, branch),
];

/** The issue's own plan: the issue produced the project's plan. */
export const issuePlanLinkFixture = link(issues[0] ?? prd, plan);

/**
 * The resolved-links read for `artifactId`: `direction=source` asks for the
 * artifacts that produced it, `direction=target` for the ones it produced.
 */
function linksFor(
  links: ArtifactLinkWithEndpoints[],
  artifactId: string,
  direction: string | null
) {
  return links.filter((row) =>
    direction === "source"
      ? row.targetId === artifactId
      : row.sourceId === artifactId
  );
}

/** The plan's pull request. */
export const planPullRequestsFixture: PullRequestInfo[] = [
  {
    baseBranch: "main",
    checksStatus: "PASSING",
    createdAt: new Date("2026-10-04T10:00:00.000Z"),
    externalLinkId: null,
    headBranch: "pln-2140-session-trace-timeline",
    htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/7058",
    id: "pr-7058",
    isDraft: false,
    number: 7058,
    repoFullName: "closedloop-ai/closedloop-ai",
    reviewDecision: "APPROVED",
    state: PullRequestState.Open,
    title: "Session trace timeline: lanes and zoom",
  },
];

function get(path: string, respond: FixtureRoute["respond"]): FixtureRoute {
  return { method: "GET", path, respond };
}

/** A read that never settles. */
export function pendingBySlugRoute(document: DocumentDetail): FixtureRoute {
  return {
    method: "GET",
    path: `/documents/by-slug/${document.slug}`,
    respond: () => new Promise(() => undefined),
  };
}

/** The same document as it read at `version`, before its latest edit. */
export function olderVersionOf(
  document: DocumentDetail,
  version: number,
  content: string
): DocumentDetail {
  return {
    ...document,
    version: {
      ...document.version,
      content,
      createdAt: new Date("2026-09-10T09:00:00.000Z"),
      id: `${document.id}-v${version}`,
      version,
    },
  };
}

/** `GET /documents/by-slug/:slug`, by `?version=` when one is asked for. */
export function documentBySlugRoute(
  document: DocumentDetail,
  versions: Record<number, DocumentDetail> = {}
): FixtureRoute {
  return get(
    `/documents/by-slug/${document.slug}`,
    ({ searchParams }: FixtureRequestContext) =>
      versions[Number(searchParams.get("version"))] ?? document
  );
}

/** Every read a document page makes, answered for `document`. */
export function documentDetailRoutes(
  document: DocumentDetail,
  {
    links = [...artifactLinksFixture, issuePlanLinkFixture],
    versions = {},
  }: {
    links?: ArtifactLinkWithEndpoints[];
    versions?: Record<number, DocumentDetail>;
  } = {}
): FixtureRoute[] {
  const id = document.id;
  return [
    documentBySlugRoute(document, versions),
    get(`/documents/${id}/attachments`, () => []),
    get(`/documents/${id}/pull-request`, () =>
      id === plan.id ? planPullRequestsFixture : []
    ),
    get(`/documents/${id}/inherited-additional-repos`, () => ({
      additionalRepos: [],
      source: null,
    })),
    get("/artifact-links/resolved", ({ searchParams }) =>
      linksFor(
        links,
        searchParams.get("artifactId") ?? "",
        searchParams.get("direction")
      )
    ),
    get("/documents", () => [
      prdDetailFixture,
      planDetailFixture,
      issueDetailFixture,
    ]),
    get(`/teams/${PROJECTS_TEAM_ID}/members`, () => projectsTeamMembersFixture),
    get("/projects", () => projectsFixture),
    get("/custom-fields", () => customFieldsFixture),
    orgUsersRoute,
    noFavoritesRoute,
    ...liveAppShellRoutes,
  ];
}
