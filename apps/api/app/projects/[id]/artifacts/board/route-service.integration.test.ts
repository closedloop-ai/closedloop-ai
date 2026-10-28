import { IssueStatus } from "@repo/api/src/types/document";
import {
  type ProjectArtifactBoardFilters,
  ProjectArtifactBoardGroup,
  projectArtifactBoardPagePath,
  projectArtifactBoardPageResponseValidator,
} from "@repo/api/src/types/project-artifact-board-page";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDbIssue } from "@/__tests__/support/artifacts/artifact-hierarchy.test-db";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";

let mockAuthContext: import("@/lib/auth/with-auth").AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => unknown) =>
    (request: unknown, context: { params?: unknown }) =>
      handler(mockAuthContext, request, context?.params),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/app/artifacts/project-artifact-board-status-evidence", () => ({
  resolveBoardStatusEvidence: vi.fn(
    async () =>
      (await import("@/app/artifacts/project-artifact-board-roots"))
        .BoardStatusEvidence.Stored
  ),
  resolveBoardStatusOrdering: vi.fn(
    async () =>
      (await import("@repo/api/src/types/artifact-group-by-mode"))
        .ArtifactSectionOrdering.Vocabulary
  ),
}));

import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "@/__tests__/utils/auth-helpers";
import { GET } from "./route";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

// The board read opens its own RepeatableRead transaction, so its rows must be
// committed rather than held in an ambient rollback transaction.
const organizations = createCommittedTestOrganizationTracker();

/**
 * CT-08 over the real client path: the shared path builder, the route's query
 * parse, the service and Postgres. ISS-12929 (724-F5) adds the filters to that
 * path, so a filter the client sends is the filter the database applies.
 */
describe.skipIf(!hasDatabase)(
  "CT-08 real client path through GET route and board service",
  () => {
    afterEach(() => organizations.cleanup());

    it("carries an opaque cursor across two partial lanes without truncation", async () => {
      await organizations.run(async () => {
        const { projectId, rootOne, rootTwo } = await seedBoard();

        const firstPage = await readPage(projectId);
        expect(firstPage.lanes).toMatchObject([
          { cards: [{ artifact: { id: rootOne } }], complete: true, count: 1 },
          { cards: [], complete: false, count: 1 },
        ]);
        expect(firstPage.rootIds).toEqual([rootOne]);
        expect(firstPage.nextCursor).toBeDefined();

        const secondPage = await readPage(projectId, firstPage.nextCursor);
        expect(secondPage.lanes).toMatchObject([
          { cards: [], complete: true, count: 1 },
          { cards: [{ artifact: { id: rootTwo } }], complete: true, count: 1 },
        ]);
        expect(secondPage.rootIds).toEqual([rootTwo]);
        expect(secondPage.nextCursor).toBeUndefined();
      });
    });

    it("ISS-12929 724-F5 applies the client's filters in the database page and lane counts", async () => {
      await organizations.run(async () => {
        const { projectId, rootTwo } = await seedBoard();

        const page = await readPage(projectId, undefined, {
          search: "second",
          statuses: [IssueStatus.Done],
        });

        expect(page.rootIds).toEqual([rootTwo]);
        expect(page.lanes).toMatchObject([
          { cards: [{ artifact: { id: rootTwo } }], complete: true, count: 1 },
        ]);
        expect(page.nextCursor).toBeUndefined();
      });
    });
  }
);

async function seedBoard() {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  mockAuthContext = createTestAuthContext({
    user: { ...createTestAuthContext().user, id: user.id, organizationId },
  });
  const projectId = await createTestProject(organizationId, user.id);
  const rootOne = await createDbIssue({
    organizationId,
    projectId,
    name: "First root",
    status: IssueStatus.Todo,
    sortOrder: 0,
  });
  const rootTwo = await createDbIssue({
    organizationId,
    projectId,
    name: "Second root",
    status: IssueStatus.Done,
    sortOrder: 1,
  });
  return { projectId, rootOne: rootOne.id, rootTwo: rootTwo.id };
}

async function readPage(
  projectId: string,
  cursor?: string,
  filters?: ProjectArtifactBoardFilters
) {
  const path = projectArtifactBoardPagePath(projectId, {
    ...(cursor ? { cursor } : {}),
    ...(filters ? { filters } : {}),
    groupBy: ProjectArtifactBoardGroup.Status,
    pageSize: 1,
  });
  const response = await GET(
    createMockRequest({ url: `http://localhost:3002${path}` }),
    createMockRouteContext({ id: projectId })
  );
  if (response.status !== 200) {
    throw new Error(`board read answered ${response.status}`);
  }
  const body = await response.json();
  return projectArtifactBoardPageResponseValidator.parse(body.data);
}
