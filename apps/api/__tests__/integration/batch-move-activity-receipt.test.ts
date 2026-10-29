/**
 * ISS-9158 vertical: a real batch-move POST through each route leaves the
 * persisted `projectId` receipt in `artifact_activity_events`.
 *
 * The route suites mock `captureBatchProjectChange`, the capture suite mocks
 * persistence, and the service suite never touches the route — each seam is
 * green on its own while a wiring break between them would drop the receipt
 * this ticket adds. Only the auth wrapper and `waitUntil` are replaced here:
 * the route, the service, the locking read, the capture helper, and the
 * activity store all run for real against Postgres inside one rolled-back
 * transaction.
 */
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import { DocumentStatus } from "@repo/api/src/types/document";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postArtifactLinksBatchMove } from "@/app/artifact-links/batch-move/route";
import { artifactActivityService } from "@/app/documents/artifact-activity-service";
import { POST as postDocumentsBatchMove } from "@/app/documents/batch-move/route";
import { generateSlug } from "@/app/documents/document-utils";
import {
  autoRollbackTransaction,
  createCommittedTestOrganizationTracker,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const { authState, waitUntilState } = vi.hoisted(() => ({
  authState: {
    user: { id: "", organizationId: "" },
    authMethod: "session" as "session" | "api_key" | "desktop_session",
  },
  waitUntilState: { promises: [] as Promise<unknown>[] },
}));

type RouteHandler = (
  context: typeof authState,
  request: Request,
  params: Promise<Record<string, string>>
) => Promise<Response>;

vi.mock("@/lib/auth/with-auth", () => ({
  withAuth: (handler: RouteHandler) => (request: Request) =>
    handler(authState, request, Promise.resolve({})),
}));
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: RouteHandler) => (request: Request) =>
    handler(authState, request, Promise.resolve({})),
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    waitUntilState.promises.push(Promise.resolve(promise));
  },
}));

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

type Fixture = {
  orgId: string;
  userId: string;
  sourceProjectId: string;
  targetProjectId: string;
  /** In the source project; the move must leave its receipt. */
  movingId: string;
  /** Already in the target project; the move must leave nothing (AC 3). */
  settledId: string;
};

async function seedFixture(
  createOrganization: () => Promise<string> = createTestOrganization
): Promise<Fixture> {
  const orgId = await createOrganization();
  const user = await createTestUser(orgId);
  const sourceProjectId = await createTestProject(orgId, user.id, {
    name: "Sprint",
  });
  const targetProjectId = await createTestProject(orgId, user.id, {
    name: "Triage",
  });
  const createDocument = (projectId: string) =>
    withDb((db) =>
      db.artifact.create({
        data: {
          name: "Doc",
          slug: generateSlug(),
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.PRD,
          status: DocumentStatus.Draft,
          organizationId: orgId,
          createdById: user.id,
          projectId,
        },
        select: { id: true },
      })
    );
  const moving = await createDocument(sourceProjectId);
  const settled = await createDocument(targetProjectId);
  authState.user = { id: user.id, organizationId: orgId };
  return {
    orgId,
    userId: user.id,
    sourceProjectId,
    targetProjectId,
    movingId: moving.id,
    settledId: settled.id,
  };
}

function postJson(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function flushCapture(): Promise<void> {
  await Promise.all(waitUntilState.promises.splice(0));
}

function readReceipts(orgId: string, artifactId: string) {
  return withDb((db) =>
    db.artifactActivityEvent.findMany({
      where: { organizationId: orgId, artifactId },
      select: {
        action: true,
        actorType: true,
        actorId: true,
        before: true,
        after: true,
        createdAt: true,
      },
    })
  );
}

function readProjectId(artifactId: string) {
  return withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: artifactId },
      select: { projectId: true },
    })
  );
}

describe.skipIf(!hasDatabase)("ISS-9158 batch-move activity receipt", () => {
  beforeEach(() => {
    waitUntilState.promises.length = 0;
    authState.authMethod = "session";
  });

  it("POST /documents/batch-move persists one projectId receipt per moved document and none for a settled one", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      const response = await postDocumentsBatchMove(
        postJson("http://localhost:3002/documents/batch-move", {
          documentIds: [fixture.movingId, fixture.settledId],
          targetProjectId: fixture.targetProjectId,
        }),
        { params: Promise.resolve({}) }
      );
      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual([
        fixture.movingId,
        fixture.settledId,
      ]);
      await flushCapture();

      const receipts = await readReceipts(fixture.orgId, fixture.movingId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        action: ArtifactActivityAction.FieldChange,
        actorType: ArtifactActivityActorType.User,
        actorId: fixture.userId,
        before: { field: "projectId", value: fixture.sourceProjectId },
        after: { field: "projectId", value: fixture.targetProjectId },
      });
      expect(receipts[0].createdAt).toBeInstanceOf(Date);
      expect((await readProjectId(fixture.movingId)).projectId).toBe(
        fixture.targetProjectId
      );
      expect(await readReceipts(fixture.orgId, fixture.settledId)).toEqual([]);
    });
  });

  it("POST /artifact-links/batch-move persists the projectId receipt and attributes an API-key caller as agent", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedFixture();
      authState.authMethod = "api_key";

      const response = await postArtifactLinksBatchMove(
        postJson("http://localhost:3002/artifact-links/batch-move", {
          artifactId: fixture.movingId,
          targetProjectId: fixture.targetProjectId,
          includeDownstream: false,
        }),
        { params: Promise.resolve({}) }
      );
      expect(response.status).toBe(200);
      expect((await response.json()).data).toEqual({
        movedArtifacts: [{ id: fixture.movingId, type: ArtifactType.DOCUMENT }],
      });
      await flushCapture();

      const receipts = await readReceipts(fixture.orgId, fixture.movingId);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        action: ArtifactActivityAction.FieldChange,
        actorType: ArtifactActivityActorType.Agent,
        actorId: fixture.userId,
        before: { field: "projectId", value: fixture.sourceProjectId },
        after: { field: "projectId", value: fixture.targetProjectId },
      });
      expect((await readProjectId(fixture.movingId)).projectId).toBe(
        fixture.targetProjectId
      );
    });
  });

  it("POST /artifact-links/batch-move leaves no receipt for an artifact already in the target project", async () => {
    await autoRollbackTransaction(async () => {
      const fixture = await seedFixture();

      const response = await postArtifactLinksBatchMove(
        postJson("http://localhost:3002/artifact-links/batch-move", {
          artifactId: fixture.settledId,
          targetProjectId: fixture.targetProjectId,
          includeDownstream: false,
        }),
        { params: Promise.resolve({}) }
      );
      expect(response.status).toBe(200);
      await flushCapture();

      expect(await readReceipts(fixture.orgId, fixture.settledId)).toEqual([]);
    });
  });
});

/**
 * ISS-10993, operator ruling (Cosimo Corrigan, 2026-09-23). The receipt is
 * written on the MUTATION'S OWN transaction, so the two commit or roll back
 * together and a capture failure refuses the user's write.
 *
 * These cases cannot use `autoRollbackTransaction` the way the suite above
 * does: `withDb.tx` JOINS an ambient transaction, so the route would run inside
 * the test's rollback and there would be no separate boundary left to observe
 * rolling back. The organization is therefore committed and torn down by the
 * tracker built for exactly this ("when the production entry point must open
 * its own transaction boundary").
 */
describe.skipIf(!hasDatabase)("ISS-10993 receipt atomicity", () => {
  const committedOrganizations = createCommittedTestOrganizationTracker();

  beforeEach(() => {
    waitUntilState.promises.length = 0;
    authState.authMethod = "session";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await committedOrganizations.cleanup();
  });

  it("rolls the move back, leaving no artifact change, when the receipt cannot be written", async () => {
    const fixture = await seedFixture(() => committedOrganizations.create());
    const record = vi
      .spyOn(artifactActivityService, "recordActivityEvents")
      .mockRejectedValue(new Error("activity store down"));

    const response = await postDocumentsBatchMove(
      postJson("http://localhost:3002/documents/batch-move", {
        documentIds: [fixture.movingId],
        targetProjectId: fixture.targetProjectId,
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(500);
    expect(record).toHaveBeenCalledTimes(1);
    // The move itself is gone, not merely unreceipted. Restore a `catch {}`
    // around the capture and this reads `targetProjectId` instead.
    expect((await readProjectId(fixture.movingId)).projectId).toBe(
      fixture.sourceProjectId
    );
    expect(await readReceipts(fixture.orgId, fixture.movingId)).toEqual([]);
  });

  it("commits the receipt with the move, so a committed move always has its activity row", async () => {
    const fixture = await seedFixture(() => committedOrganizations.create());

    const response = await postDocumentsBatchMove(
      postJson("http://localhost:3002/documents/batch-move", {
        documentIds: [fixture.movingId],
        targetProjectId: fixture.targetProjectId,
      }),
      { params: Promise.resolve({}) }
    );

    expect(response.status).toBe(200);
    expect((await readProjectId(fixture.movingId)).projectId).toBe(
      fixture.targetProjectId
    );
    const receipts = await readReceipts(fixture.orgId, fixture.movingId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      action: ArtifactActivityAction.FieldChange,
      actorType: ArtifactActivityActorType.User,
      actorId: fixture.userId,
      before: { field: "projectId", value: fixture.sourceProjectId },
      after: { field: "projectId", value: fixture.targetProjectId },
    });
  });
});
