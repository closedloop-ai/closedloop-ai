/**
 * ISS-10993 — a bulk-assign refusal, entered at the ROUTE, leaves no row moved.
 *
 * The sibling `batch-item-results-bulk-assign.integration.test.ts` proves the
 * same contract one layer down, against the service. That is not enough here,
 * and the gap is the whole reason this file exists: `withDb.tx` JOINS an
 * ambient transaction instead of nesting, so whether the refusal rolls anything
 * back is decided by WHO OWNS the outermost transaction — a property only the
 * route can violate and only a route-entered case can see. A route that wrapped
 * the call in a transaction of its own would leave `runSessionWrite` catching
 * `SessionWriteRefusal` inside it, the handler returning normally, and the
 * partial `updateMany` committing under a 404.
 *
 * NOT wrapped in `autoRollbackTransaction`, for the reason that sibling states
 * at length: an outer test transaction is itself the ambient transaction the
 * bug needs, so the harness would manufacture the defect it is meant to detect.
 * Every case commits against a tracked organization and `afterEach` removes it.
 *
 * BOTH routes, because they diverge exactly where it matters. v1 reports the
 * refusal as a 404 envelope; v2 reports it per item with a 200, so v2's handler
 * takes the SUCCESS branch on a refused write and a shared fixture could not
 * tell one route's rollback from the other's.
 */
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditReceiptResult,
  ArtifactFieldEditValueClassification,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { BatchItemFailureCode } from "@repo/api/src/types/batch-mutation-result";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionBulkAssignField } from "@/app/agent-sessions/write-contract";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestSessionDetail,
  createTestUser,
} from "../utils/db-helpers";

const { authState, waitUntilState } = vi.hoisted(() => ({
  authState: {
    user: { id: "", organizationId: "" },
    authMethod: "session" as const,
  },
  waitUntilState: { promises: [] as Promise<unknown>[] },
}));

type RouteHandler = (
  context: typeof authState,
  request: Request,
  params: Promise<Record<string, string>>
) => Promise<Response>;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: RouteHandler) => (request: Request) =>
    handler(authState, request, Promise.resolve({})),
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    waitUntilState.promises.push(Promise.resolve(promise));
  },
}));

const { POST: postBulkAssign } = await import(
  "@/app/agent-sessions/bulk-assign/route"
);
const { POST: postBulkAssignV2 } = await import(
  "@/app/agent-sessions/bulk-assign/v2/route"
);

const hasDatabase = Boolean(keys().DATABASE_URL);
const organizations = createCommittedTestOrganizationTracker();

type World = {
  organizationId: string;
  userId: string;
  projectId: string;
};

async function seedWorld(): Promise<World> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  return { organizationId, userId: user.id, projectId };
}

function seedSession(world: World, label: string): Promise<string> {
  return createTestSessionDetail({
    organizationId: world.organizationId,
    userId: world.userId,
    label,
  });
}

function postJson(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function readProjectId(artifactId: string): Promise<string | null> {
  return withDb(async (db) => {
    const row = await db.artifact.findUniqueOrThrow({
      where: { id: artifactId },
      select: { projectId: true },
    });
    return row.projectId;
  });
}

function readReceiptCount(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.artifactActivityEvent.count({ where: { organizationId } })
  );
}

describe.skipIf(!hasDatabase)("ISS-10993 bulk-assign refusal rollback", () => {
  beforeEach(() => {
    waitUntilState.promises.length = 0;
  });
  afterEach(() => organizations.cleanup());

  it("POST /agent-sessions/bulk-assign answers 404 and moves NO session when one id is foreign", async () => {
    const [world, foreign] = await Promise.all([seedWorld(), seedWorld()]);
    authState.user = {
      id: world.userId,
      organizationId: world.organizationId,
    };
    const [reachable, alsoReachable, foreignSession] = await Promise.all([
      seedSession(world, "v1-reachable"),
      seedSession(world, "v1-also-reachable"),
      seedSession(foreign, "v1-foreign"),
    ]);

    const response = await postBulkAssign(
      postJson("http://localhost/agent-sessions/bulk-assign", {
        sessionIds: [reachable, foreignSession, alsoReachable],
        field: AgentSessionBulkAssignField.Project,
        value: world.projectId,
      }) as never,
      undefined as never
    );

    expect(response.status).toBe(404);
    // The assertion the 404 alone cannot make: the reachable ids were inside
    // the `updateMany` the refusal aborted, so a committed partial write shows
    // up here and nowhere else in the response.
    await expect(readProjectId(reachable)).resolves.toBeNull();
    await expect(readProjectId(alsoReachable)).resolves.toBeNull();
    await expect(readProjectId(foreignSession)).resolves.toBeNull();
    await expect(readReceiptCount(world.organizationId)).resolves.toBe(0);
  });

  it("POST /agent-sessions/bulk-assign/v2 reports every id refused and moves NO session", async () => {
    const [world, foreign] = await Promise.all([seedWorld(), seedWorld()]);
    authState.user = {
      id: world.userId,
      organizationId: world.organizationId,
    };
    const [reachable, foreignSession] = await Promise.all([
      seedSession(world, "v2-reachable"),
      seedSession(foreign, "v2-foreign"),
    ]);

    const response = await postBulkAssignV2(
      postJson("http://localhost/agent-sessions/bulk-assign/v2", {
        sessionIds: [reachable, foreignSession],
        field: AgentSessionBulkAssignField.Project,
        value: world.projectId,
      }) as never,
      undefined as never
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { results: { id: string; code?: string }[] };
    };
    const { results } = body.data;
    expect(results.find((row) => row.id === foreignSession)?.code).toBe(
      BatchItemFailureCode.ArtifactsNotFound
    );
    expect(results.find((row) => row.id === reachable)?.code).toBe(
      BatchItemFailureCode.BatchRefused
    );
    // v2 answers 200 on a refusal, so the response shape alone cannot separate
    // "refused and rolled back" from "refused and committed anyway".
    await expect(readProjectId(reachable)).resolves.toBeNull();
    await expect(readProjectId(foreignSession)).resolves.toBeNull();
    await expect(readReceiptCount(world.organizationId)).resolves.toBe(0);
  });

  it("commits the activity receipt with an assignment the route accepts", async () => {
    const world = await seedWorld();
    authState.user = {
      id: world.userId,
      organizationId: world.organizationId,
    };
    const assigned = await seedSession(world, "v1-committed");

    const response = await postBulkAssign(
      postJson("http://localhost/agent-sessions/bulk-assign", {
        sessionIds: [assigned],
        field: AgentSessionBulkAssignField.Project,
        value: world.projectId,
      }) as never,
      undefined as never
    );

    expect(response.status).toBe(200);
    await expect(readProjectId(assigned)).resolves.toBe(world.projectId);
    // The receipt is written by the callback the route hands the write, so a
    // route that stopped passing one would still return this 200.
    const receipts = await withDb((db) =>
      db.artifactActivityEvent.findMany({
        where: { organizationId: world.organizationId, artifactId: assigned },
        select: {
          action: true,
          actorType: true,
          actorId: true,
          after: true,
        },
      })
    );
    expect(receipts).toEqual([
      {
        action: ArtifactActivityAction.FieldChange,
        actorType: ArtifactActivityActorType.User,
        actorId: world.userId,
        after: expect.objectContaining({
          field: ArtifactFieldEditField.ProjectId,
          value: world.projectId,
          valueClassification: ArtifactFieldEditValueClassification.Reference,
          result: ArtifactFieldEditReceiptResult.Committed,
          surface: ArtifactStatusEditSurface.Bulk,
          commitGroupId: expect.any(String),
        }),
      },
    ]);
  });
});
