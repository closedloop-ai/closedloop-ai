import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { DocumentWithProject } from "@repo/api/src/types/document";
import type { DocumentCostsResponse } from "@repo/api/src/types/document-costs";
import type { DocumentListSummary } from "@repo/api/src/types/document-list-summary";
import { ApproverRole, type User } from "@repo/api/src/types/user.ts";
import {
  type ArtifactCollaboratorBatchResponse,
  CollaboratorArtifactType,
  DirectCollaboratorSource,
} from "../../../../packages/api/src/types/artifact-collaborators.ts";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "../../../../packages/api/src/types/branch-identity.ts";
// Explicit source extensions keep the Electron spec loader out of extension-less API re-exports.
import { Priority } from "../../../../packages/loops-api/src/common.ts";
import {
  DocumentType,
  IssueStatus,
  SnapshotSource,
} from "../../../../packages/loops-api/src/document.ts";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  closeServer,
  rejectNotFound,
  rejectUnauthorized,
  routeDesktopSessionRefresh,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import { gotoHash } from "./helpers/desktop-app";
import {
  launchShellSidebarApp,
  seedShellSidebarSession,
} from "./helpers/shell-navigation-cloud";

const metricLabels = [
  "Issues",
  "Est. Total",
  "Median token cost",
  "Produced by sessions",
  "Updated this week",
];
const issues: DocumentWithProject[] = Array.from(
  { length: 26 },
  (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    organizationId: "org-e2e",
    createdById: "user-e2e",
    slug: `ISS-${index + 1}`,
    title:
      index === 25
        ? "Second project evergreen desktop issue"
        : `First project desktop issue ${String(index + 1).padStart(2, "0")}`,
    type: DocumentType.Feature,
    projectId: index === 25 ? "project-b" : "project-a",
    project: {
      id: index === 25 ? "project-b" : "project-a",
      name: index === 25 ? "Second project" : "First project",
    },
    status: index === 25 ? IssueStatus.InReview : IssueStatus.Backlog,
    priority: index === 25 ? Priority.High : Priority.Medium,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date(
      index === 25 ? "2020-01-01T00:00:00Z" : "2026-10-08T00:00:00Z"
    ),
    approver: null,
    approverId: null,
    assignee: null,
    assigneeId: null,
    fileName: null,
    latestVersion: 1,
    repositorySnapshot: { repositories: [], source: SnapshotSource.None },
    sortOrder: null,
    tags: [],
    templateForType: null,
  })
);
const prd: DocumentWithProject = {
  ...issues[0],
  id: "excluded-prd",
  title: "Excluded desktop PRD",
  type: DocumentType.Prd,
};
const user: User = {
  id: "user-e2e",
  organizationId: "org-e2e",
  clerkId: "clerk-e2e",
  email: "e2e@closedloop.ai",
  firstName: "E2E",
  lastName: "User",
  avatarUrl: null,
  phoneNumber: null,
  role: ApproverRole.Engineer,
  linearId: null,
  slackId: null,
  githubUsername: null,
  active: true,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};
const trendValues = Array.from({ length: 14 }, (_, index) => index % 3);
const trendBounds = {
  startDate: "2026-09-26T00:00:00.000Z",
  endDate: "2026-10-09T18:00:00.000Z",
};
const costs: DocumentCostsResponse = {
  artifacts: [],
  totalEstimatedCost: 10,
  medianEstimatedCost: 1,
  trendlines: {
    ...trendBounds,
    totalEstimatedCost: trendValues,
    medianEstimatedCost: trendValues,
  },
};

function participation(ids: string[]): ArtifactCollaboratorBatchResponse {
  return {
    results: ids.map((artifactId) => ({
      artifactId,
      artifactType: CollaboratorArtifactType.Document,
      commentCount: 2,
      collaborators: {
        availability: BranchIdentityAvailability.Complete,
        people: [
          {
            provider: BranchPersonProvider.ClosedLoop,
            id: "direct-commenter",
            displayName: "Direct commenter",
          },
          {
            provider: BranchPersonProvider.ClosedLoop,
            id: "inline-commenter",
            displayName: "Inline commenter",
          },
        ],
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
  };
}

async function startIssueAuthority(enabled: boolean) {
  const documentRequests: URL[] = [];
  const server = createServer((request, response) => {
    if (routeDesktopSessionRefresh(request, response)) {
      return;
    }
    if (
      request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
    ) {
      rejectUnauthorized(response);
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/desktop/feature-flags") {
      writeApiResult(response, {
        userId: AUTHENTICATED_USER_ID,
        resolved: true,
        flags: {
          labsNav: true,
          "dev-mode": true,
          ...(enabled ? { "issues-nav": true } : {}),
          "artifact-list-summary": true,
        },
      });
      return;
    }
    if (url.pathname === "/desktop/identity") {
      writeApiResult(response, {
        userId: AUTHENTICATED_USER_ID,
        organizationId: AUTHENTICATED_ORGANIZATION_ID,
        email: "e2e@closedloop.ai",
        firstName: "E2E",
        lastName: "User",
        organizationName: "E2E",
        organizationSlug: "closedloop-ai",
      });
      return;
    }
    if (url.pathname === "/navigation/view-model") {
      const destinations: Record<string, { status: string }> =
        Object.fromEntries(
          url.searchParams
            .getAll("destinations")
            .map((id) => [id, { status: "ready" }])
        );
      writeApiResult(response, {
        destinations,
        organizationId: "org-e2e",
        projectionStatus: "ready",
        standing: "member",
      });
      return;
    }
    if (
      url.pathname === "/documents" ||
      url.pathname === "/documents/summary"
    ) {
      const types = (
        url.searchParams.get("types") ?? url.searchParams.get("type")
      )?.split(",");
      const recency = Number(url.searchParams.get("recencyDays"));
      const search = url.searchParams.get("search")?.toLowerCase();
      const documents: DocumentWithProject[] = [...issues, prd].filter(
        (issue) =>
          (!types || types.includes(issue.type)) &&
          (!recency ||
            issue.updatedAt.getTime() >= Date.now() - recency * 86_400_000) &&
          (!search || issue.title.toLowerCase().includes(search))
      );
      if (url.pathname === "/documents") {
        documentRequests.push(url);
        writeApiResult(response, answerDocumentsList(url, documents));
      } else {
        const summary: DocumentListSummary = {
          total: documents.length,
          producedByAgentSessions: 0,
          updatedInWindow: 25,
          neverEdited: documents.length,
          windowDays: 7,
          appliedTypes: [DocumentType.Feature],
          trendlines: {
            ...trendBounds,
            total: trendValues,
            producedByAgentSessions: trendValues,
            updatedInWindow: trendValues,
          },
        };
        writeApiResult(response, summary);
      }
      return;
    }
    if (url.pathname === "/artifacts/collaborators") {
      writeApiResult(
        response,
        participation(url.searchParams.getAll("artifactIds"))
      );
      return;
    }
    const responses: Record<string, unknown> = {
      "/me": user,
      "/users": [user],
      "/custom-fields": [],
      "/artifacts/favorites": [],
      "/documents/costs": costs,
      "/artifacts/related-sessions": { results: {} },
    };
    if (Object.hasOwn(responses, url.pathname)) {
      writeApiResult(response, responses[url.pathname]);
      return;
    }
    rejectNotFound(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Issues fixture did not bind");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    server,
    documentRequests,
  };
}

for (const enabled of [false, true]) {
  test(`Desktop Issues flag ${enabled ? "on" : "off"} reaches the shared org listing`, async () => {
    test.setTimeout(180_000);
    const authority = await startIssueAuthority(enabled);
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-org-issues-")
    );
    try {
      await seedShellSidebarSession(userDataDir);
      const launched = await launchShellSidebarApp({
        apiOrigin: authority.origin,
        flags: {
          labsNav: true,
          "dev-mode": true,
          ...(enabled ? { "issues-nav": true } : {}),
          "artifact-list-summary": true,
        },
        profileId: "org-issues",
        profileName: "Org issues fixture",
        userDataDir,
      });
      try {
        await gotoHash(launched.page, "/issues");
        if (enabled) {
          await expect(
            launched.page.getByRole("button", {
              name: "Add issue",
              exact: true,
            })
          ).toBeVisible();
          await expect(
            launched.page.getByText("First project desktop issue 01", {
              exact: true,
            })
          ).toBeVisible();
          await expect(
            launched.page.locator('[data-slot="metric-card-label-text"]')
          ).toHaveText(metricLabels);
          await expect(
            launched.page.getByRole("columnheader", {
              name: "Priority",
              exact: true,
            })
          ).toBeVisible();
          await expect(
            launched.page.getByRole("columnheader", {
              name: "Status",
              exact: true,
            })
          ).toBeVisible();
          await expect(
            launched.page.getByRole("columnheader", {
              name: "Outcome",
              exact: true,
            })
          ).toHaveCount(0);
          await expect(
            launched.page.getByText("Excluded desktop PRD", { exact: true })
          ).toHaveCount(0);
          await expect(
            launched.page.getByRole("columnheader", {
              name: "Collaborators",
              exact: true,
            })
          ).toBeVisible();
          await expect(
            launched.page
              .locator(
                '[data-column-id="collaborators"]:is([role="cell"],[role="gridcell"])'
              )
              .first()
              .getByRole("img", { name: "Direct commenter, Inline commenter" })
          ).toBeVisible();
          await expect(
            launched.page
              .locator(
                '[data-column-id="comments"]:is([role="cell"],[role="gridcell"])'
              )
              .first()
          ).toHaveAccessibleName("2 comments");
          await expect(
            launched.page.getByText("Trend across the period", { exact: true })
          ).toHaveCount(5);
          await expect(
            launched.page.getByRole("button", {
              name: "More actions",
              exact: true,
            })
          ).toHaveCount(0);
          await launched.page
            .getByRole("button", { name: "Add New Issue", exact: true })
            .click();
          await expect(
            launched.page.getByRole("dialog", { name: "Create New Issue" })
          ).toBeVisible();
          await launched.page.keyboard.press("Escape");
          await launched.page.getByLabel("Go to next page").click();
          await expect(
            launched.page.getByText("Second project evergreen desktop issue", {
              exact: true,
            })
          ).toBeVisible();
          await expect(
            launched.page.getByRole("radio", { name: "All time", exact: true })
          ).toBeChecked();
          await launched.page
            .getByRole("textbox", { name: "Filter items" })
            .fill("evergreen desktop issue");
          await expect(
            launched.page.getByText("Second project evergreen desktop issue", {
              exact: true,
            })
          ).toBeVisible();
          await expect(
            launched.page.getByText("First project desktop issue 01", {
              exact: true,
            })
          ).toHaveCount(0);
          await launched.page
            .getByRole("radio", { name: "Board view", exact: true })
            .click();
          await expect(
            launched.page.getByText("Second project evergreen desktop issue", {
              exact: true,
            })
          ).toBeVisible();
          await launched.page
            .getByRole("radio", { name: "List view", exact: true })
            .click();
          await expect(
            launched.page.getByRole("columnheader", {
              name: "Priority",
              exact: true,
            })
          ).toBeVisible();
          expect(
            authority.documentRequests.some(
              (url) =>
                url.searchParams.get("types") === DocumentType.Feature &&
                url.searchParams.get("includeTotal") === "true" &&
                url.searchParams.get("limit") === String(ISSUES_PAGE_SIZE) &&
                !url.searchParams.has("projectId") &&
                !url.searchParams.has("recencyDays")
            )
          ).toBe(true);
        } else {
          await expect(
            launched.page.getByText("Issues is turned off", { exact: true })
          ).toBeVisible();
          await expect(
            launched.page.getByRole("button", {
              name: "Add issue",
              exact: true,
            })
          ).toHaveCount(0);
          expect(authority.documentRequests).toHaveLength(0);
        }
        expect(launched.pageErrors).toEqual([]);
      } finally {
        await launched.cleanup();
      }
    } finally {
      await closeServer(authority.server);
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}

/** The shipped default rows-per-page; the fixture is one page plus one. */
const ISSUES_PAGE_SIZE = 25;

/**
 * What the real `/documents` route answers: a bare array for an unpaged read,
 * and one window of rows with the real total when the client asks for the
 * envelope with `includeTotal=true` (ISS-9157).
 */
function answerDocumentsList(url: URL, served: DocumentWithProject[]) {
  if (url.searchParams.get("includeTotal") !== "true") {
    return served;
  }
  const limit = Number(url.searchParams.get("limit"));
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const items = served.slice(offset, offset + limit);
  // The route echoes the subtypes it applied; without the echo the client
  // treats the server as pre-union and falls back to the unpaged per-type read.
  const types = url.searchParams
    .get("types")
    ?.split(",")
    .flatMap((raw) =>
      Object.values(DocumentType).filter((type) => type === raw)
    );
  return {
    ...(types ? { appliedTypes: types } : {}),
    hasMore: offset + items.length < served.length,
    items,
    limit,
    offset,
    total: served.length,
  };
}
