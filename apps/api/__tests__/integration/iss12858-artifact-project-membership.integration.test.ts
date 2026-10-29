import { randomUUID } from "node:crypto";
import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import { AuditAction } from "@repo/api/src/types/audit";
import {
  BATCH_ITEM_APPLIED_STATUS,
  BatchItemFailureCode,
  BatchItemFailureStatus,
} from "@repo/api/src/types/batch-mutation-result";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { type Document, DocumentType } from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";

/**
 * ISS-12858 (PRD-799 G-04): every artifact type can be filed into a project,
 * moved, and cleared from one, through the update path and every mover, against
 * a real Postgres. Each case reads the stored row back rather than trusting the
 * response.
 */

const routeState = vi.hoisted(() => ({
  user: { id: "", organizationId: "" },
  scheduled: [] as Promise<unknown>[],
}));
const auditMocks = vi.hoisted(() => ({
  dispatchAuditEvent: vi.fn(),
  dispatchAuditEvents: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context?: { params: Promise<unknown> }) =>
      handler(
        { user: routeState.user, authMethod: "session" },
        request,
        context?.params
      ),
}));

vi.mock("@repo/analytics/node", () => ({
  nodeAnalytics: { captureImmediate: vi.fn() },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    routeState.scheduled.push(Promise.resolve(work));
  },
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvent: auditMocks.dispatchAuditEvent,
  dispatchAuditEvents: auditMocks.dispatchAuditEvents,
  userAuditActor: (userId: string) => ({ actorType: "user", actorId: userId }),
}));

vi.mock("@/lib/assignment-notifications", () => ({
  dispatchAssignmentNotification: vi.fn(),
}));

vi.mock("@/lib/observability/request-span-attribution", () => ({
  recordRequestArtifact: vi.fn(),
  recordRequestErrorCause: vi.fn(),
}));

vi.mock(
  "@/app/documents/blocked-dependent-unblock-service",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    blockedDependentUnblockService: {
      resolveBlocksForChangedArtifacts: vi.fn(async () => ({
        resolvedIds: [],
        unblockedIds: [],
      })),
    },
  })
);

vi.mock("@/app/documents/document-service", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  indexDocumentProjection: vi.fn(),
}));

vi.mock("@/app/documents/room-utils", () => ({
  createDocumentRoom: vi.fn(),
  deleteDocumentRoom: vi.fn(),
}));

import { POST as moveArtifact } from "@/app/artifact-links/batch-move/route";
import { GET as getDocument, PUT } from "@/app/documents/[id]/route";
import { POST as batchMoveV1 } from "@/app/documents/batch-move/route";
import { POST as batchMoveV2 } from "@/app/documents/batch-move/v2/route";
import { createDocumentRecord } from "@/app/documents/document-service";
import {
  POST as createDocument,
  GET as listDocuments,
} from "@/app/documents/route";

const organizations = createCommittedTestOrganizationTracker();
const customFieldIds = new Set<string>();

type World = {
  organizationId: string;
  userId: string;
  projectA: string;
  projectB: string;
};

const EVERY_TYPE = [
  DocumentType.Prd,
  DocumentType.ImplementationPlan,
  DocumentType.Feature,
  DocumentType.Doc,
] as const;

describe.skipIf(!keys().DATABASE_URL)(
  "ISS-12858 artifact project membership",
  () => {
    afterEach(async () => {
      await Promise.all(routeState.scheduled.splice(0));
      auditMocks.dispatchAuditEvent.mockReset();
      auditMocks.dispatchAuditEvents.mockReset();
      if (customFieldIds.size > 0) {
        await withDb(async (db) => {
          await db.customFieldValue.deleteMany({
            where: { customFieldId: { in: [...customFieldIds] } },
          });
          await db.customField.deleteMany({
            where: { id: { in: [...customFieldIds] } },
          });
        });
        customFieldIds.clear();
      }
      await organizations.cleanup();
    });

    it.each(EVERY_TYPE)(
      "PUT changes, clears and sets the project on a %s",
      async (type) => {
        const world = await seedWorld();
        const document = await seedDocument(world, type, world.projectA);

        expect(
          await putStatus(document.id, { projectId: world.projectB })
        ).toBe(200);
        expect(await storedProjectId(document.id)).toBe(world.projectB);

        expect(await putStatus(document.id, { projectId: null })).toBe(200);
        expect(await storedProjectId(document.id)).toBeNull();

        expect(
          await putStatus(document.id, { projectId: world.projectA })
        ).toBe(200);
        expect(await storedProjectId(document.id)).toBe(world.projectA);
      }
    );

    it.each(EVERY_TYPE)(
      "/artifact-links/batch-move changes, clears and sets the project on a %s",
      async (type) => {
        const world = await seedWorld();
        const document = await seedDocument(world, type, world.projectA);

        expect(await moveStatus(document.id, world.projectB)).toBe(200);
        expect(await storedProjectId(document.id)).toBe(world.projectB);

        expect(await moveStatus(document.id, null)).toBe(200);
        expect(await storedProjectId(document.id)).toBeNull();

        expect(await moveStatus(document.id, world.projectA)).toBe(200);
        expect(await storedProjectId(document.id)).toBe(world.projectA);
      }
    );

    it.each([
      [true, null],
      [false, "projectA"],
    ] as const)(
      "a clear with includeDownstream: %s leaves the child Plan in %s",
      async (includeDownstream, childExpectation) => {
        const world = await seedWorld();
        const prd = await seedDocument(world, DocumentType.Prd, world.projectA);
        const plan = await seedDocument(
          world,
          DocumentType.ImplementationPlan,
          world.projectA,
          prd.id
        );

        expect(await moveStatus(prd.id, null, { includeDownstream })).toBe(200);

        expect(await storedProjectId(prd.id)).toBeNull();
        expect(await storedProjectId(plan.id)).toBe(
          childExpectation === null ? null : world.projectA
        );
      }
    );

    it("/documents/batch-move v1 and v2 clear project_id and sort_order", async () => {
      const world = await seedWorld();
      const [first, second, third, fourth] = await Promise.all([
        seedDocument(world, DocumentType.Prd, world.projectA),
        seedDocument(world, DocumentType.Doc, world.projectA),
        seedDocument(world, DocumentType.Feature, world.projectA),
        seedDocument(world, DocumentType.Prd, world.projectA),
      ]);
      routeState.user = asUser(world);

      const v1 = await batchMoveV1(
        post("/documents/batch-move", {
          documentIds: [first.id, second.id],
          targetProjectId: null,
        }),
        undefined as never
      );
      expect(v1.status).toBe(200);

      const v2 = await batchMoveV2(
        post("/documents/batch-move/v2", {
          documentIds: [third.id, fourth.id],
          targetProjectId: null,
        }),
        undefined as never
      );
      expect(v2.status).toBe(200);
      const v2Body = (await v2.json()) as {
        data: { results: { id: string; status: string }[] };
      };
      expect(v2Body.data.results).toEqual([
        expect.objectContaining({
          id: third.id,
          status: BATCH_ITEM_APPLIED_STATUS,
        }),
        expect.objectContaining({
          id: fourth.id,
          status: BATCH_ITEM_APPLIED_STATUS,
        }),
      ]);

      const rows = await withDb((db) =>
        db.artifact.findMany({
          where: { id: { in: [first.id, second.id, third.id, fourth.id] } },
          select: { projectId: true, sortOrder: true },
        })
      );
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row).toEqual({ projectId: null, sortOrder: null });
      }
    });

    it("POST /documents files a DOC into a project, and still refuses TEMPLATE + projectId and a project-less PRD", async () => {
      const world = await seedWorld();
      routeState.user = asUser(world);

      const doc = await createDocument(
        post("/documents", {
          type: DocumentType.Doc,
          title: "Filed handbook",
          content: "",
          projectId: world.projectA,
        }),
        undefined as never
      );
      expect(doc.status).toBe(200);
      const created = (await doc.json()) as { data: { id: string } };
      expect(await storedProjectId(created.data.id)).toBe(world.projectA);

      const template = await createDocument(
        post("/documents", {
          type: DocumentType.Template,
          title: "Filed template",
          content: "",
          projectId: world.projectA,
        }),
        undefined as never
      );
      expect(template.status).toBe(400);

      const prd = await createDocument(
        post("/documents", {
          type: DocumentType.Prd,
          title: "Unfiled PRD",
          content: "",
        }),
        undefined as never
      );
      expect(prd.status).toBe(400);
    });

    it("keeps custom-field values through a PUT change and a batch-move clear", async () => {
      const world = await seedWorld();
      const document = await seedDocument(
        world,
        DocumentType.Doc,
        world.projectA
      );
      const fieldId = await seedTextValue(world, document.id, "kept");

      expect(await putStatus(document.id, { projectId: world.projectB })).toBe(
        200
      );
      expect(await readCustomFieldValue(document.id, fieldId)).toBe("kept");
      expect(await storedTextValue(document.id, fieldId)).toBe("kept");

      expect(await moveStatus(document.id, null)).toBe(200);
      expect(await storedProjectId(document.id)).toBeNull();
      expect(await readCustomFieldValue(document.id, fieldId)).toBe("kept");
      expect(await storedTextValue(document.id, fieldId)).toBe("kept");
    });

    it("the default Documents read returns a DOC moved into a project; unassignedProject=true does not", async () => {
      const world = await seedWorld();
      const document = await seedDocument(world, DocumentType.Doc, null);

      expect(await moveStatus(document.id, world.projectA)).toBe(200);

      expect(await listedIds("type=DOC")).toContain(document.id);
      expect(await listedIds("type=DOC&unassignedProject=true")).not.toContain(
        document.id
      );
    });

    it("older payloads keep their meaning, and a mover without targetProjectId is a 400", async () => {
      const world = await seedWorld();
      const document = await seedDocument(
        world,
        DocumentType.Prd,
        world.projectA
      );

      expect(await putStatus(document.id, { title: "Renamed" })).toBe(200);
      expect(await storedProjectId(document.id)).toBe(world.projectA);

      expect(await putStatus(document.id, { projectId: world.projectB })).toBe(
        200
      );
      expect(await storedProjectId(document.id)).toBe(world.projectB);

      expect(await moveStatus(document.id, world.projectA)).toBe(200);
      expect(await storedProjectId(document.id)).toBe(world.projectA);

      const missingTarget = await moveArtifact(
        post("/artifact-links/batch-move", {
          artifactId: document.id,
          includeDownstream: false,
        }),
        undefined as never
      );
      expect(missingTarget.status).toBe(400);
      expect(await storedProjectId(document.id)).toBe(world.projectA);
    });

    it("a caller in another organization cannot clear the project", async () => {
      const [owner, foreign] = await Promise.all([seedWorld(), seedWorld()]);
      const document = await seedDocument(
        owner,
        DocumentType.Prd,
        owner.projectA
      );
      routeState.user = asUser(foreign);

      const put = await PUT(putRequest(document.id, { projectId: null }), {
        params: Promise.resolve({ id: document.id }),
      });
      expect(put.status).toBe(404);

      const move = await moveArtifact(
        post("/artifact-links/batch-move", {
          artifactId: document.id,
          targetProjectId: null,
          includeDownstream: false,
        }),
        undefined as never
      );
      expect(move.status).toBe(404);

      const v1 = await batchMoveV1(
        post("/documents/batch-move", {
          documentIds: [document.id],
          targetProjectId: null,
        }),
        undefined as never
      );
      expect(v1.status).toBe(404);

      const v2 = await batchMoveV2(
        post("/documents/batch-move/v2", {
          documentIds: [document.id],
          targetProjectId: null,
        }),
        undefined as never
      );
      expect(v2.status).toBe(BATCH_ITEM_APPLIED_STATUS);
      const v2Body = (await v2.json()) as {
        data: { results: { id: string; status: number; code?: string }[] };
      };
      expect(v2Body.data.results).toEqual([
        expect.objectContaining({
          id: document.id,
          status: BatchItemFailureStatus.NotFound,
          code: BatchItemFailureCode.ArtifactsNotFound,
        }),
      ]);

      expect(await storedProjectId(document.id)).toBe(owner.projectA);
    });

    it("a clear writes the move's activity receipt and audit event, with after: null", async () => {
      const world = await seedWorld();
      const [viaPut, viaMove] = await Promise.all([
        seedDocument(world, DocumentType.Prd, world.projectA),
        seedDocument(world, DocumentType.Doc, world.projectA),
      ]);

      expect(await putStatus(viaPut.id, { projectId: null })).toBe(200);
      expect(await moveStatus(viaMove.id, null)).toBe(200);
      await Promise.all(routeState.scheduled.splice(0));

      for (const document of [viaPut, viaMove]) {
        const receipts = await withDb((db) =>
          db.artifactActivityEvent.findMany({
            where: {
              organizationId: world.organizationId,
              artifactId: document.id,
              action: ArtifactActivityAction.FieldChange,
            },
            select: { before: true, after: true },
          })
        );
        expect(receipts).toEqual([
          {
            before: expect.objectContaining({
              field: "projectId",
              value: world.projectA,
            }),
            after: expect.objectContaining({ field: "projectId", value: null }),
          },
        ]);
        expect(auditEvents()).toContainEqual(
          expect.objectContaining({
            action: AuditAction.ArtifactProjectChanged,
            objectId: document.id,
            detail: expect.objectContaining({
              from: world.projectA,
              to: null,
            }),
          })
        );
      }
    });
  }
);

async function seedWorld(): Promise<World> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const [projectA, projectB] = await Promise.all([
    createTestProject(organizationId, user.id),
    createTestProject(organizationId, user.id),
  ]);
  routeState.user = { id: user.id, organizationId };
  return { organizationId, userId: user.id, projectA, projectB };
}

function asUser(world: World) {
  return { id: world.userId, organizationId: world.organizationId };
}

function seedDocument(
  world: World,
  type: DocumentType,
  projectId: string | null,
  sourceId?: string
): Promise<Document> {
  return withDb.tx(async (tx) => {
    const document = await createDocumentRecord(
      tx,
      world.organizationId,
      world.userId,
      {
        content: "Integration content",
        title: `${type} ${randomUUID()}`,
        type,
        ...(projectId === null ? {} : { projectId }),
        ...(sourceId === undefined ? {} : { sourceId }),
      }
    );
    if (!document) {
      throw new Error("Failed to seed ISS-12858 document");
    }
    return document;
  });
}

async function seedTextValue(
  world: World,
  documentId: string,
  value: string
): Promise<string> {
  const field = await withDb((db) =>
    db.customField.create({
      data: {
        organizationId: world.organizationId,
        name: `Project membership ${randomUUID()}`,
        fieldType: CustomFieldType.Text,
        entityTypes: [CustomFieldEntityType.Document],
      },
    })
  );
  customFieldIds.add(field.id);
  await withDb((db) =>
    db.customFieldValue.create({
      data: {
        customFieldId: field.id,
        organizationId: world.organizationId,
        entityType: CustomFieldEntityType.Document,
        entityId: documentId,
        textValue: value,
        displayValue: value,
        multiEnumValueIds: [],
        peopleValueIds: [],
      },
    })
  );
  return field.id;
}

async function storedProjectId(artifactId: string): Promise<string | null> {
  const row = await withDb((db) =>
    db.artifact.findUniqueOrThrow({
      where: { id: artifactId },
      select: { projectId: true },
    })
  );
  return row.projectId;
}

async function storedTextValue(
  documentId: string,
  fieldId: string
): Promise<string | null | undefined> {
  const row = await withDb((db) =>
    db.customFieldValue.findUnique({
      where: {
        customFieldId_entityType_entityId: {
          customFieldId: fieldId,
          entityType: CustomFieldEntityType.Document,
          entityId: documentId,
        },
      },
      select: { textValue: true },
    })
  );
  return row?.textValue;
}

async function readCustomFieldValue(
  documentId: string,
  fieldId: string
): Promise<string | undefined> {
  const response = await getDocument(
    new NextRequest(`http://localhost/documents/${documentId}`),
    { params: Promise.resolve({ id: documentId }) }
  );
  if (response.status !== 200) {
    throw new Error(`GET /documents/${documentId} answered ${response.status}`);
  }
  const body = (await response.json()) as {
    data: {
      customFields: { customFieldId: string; displayValue: string }[];
    };
  };
  return body.data.customFields.find((field) => field.customFieldId === fieldId)
    ?.displayValue;
}

async function listedIds(query: string): Promise<string[]> {
  const response = await listDocuments(
    new NextRequest(`http://localhost/documents?${query}`),
    undefined as never
  );
  if (response.status !== 200) {
    throw new Error(`GET /documents?${query} answered ${response.status}`);
  }
  const body = (await response.json()) as { data: { id: string }[] };
  return body.data.map((document) => document.id);
}

async function putStatus(
  documentId: string,
  body: Record<string, unknown>
): Promise<number> {
  const response = await PUT(putRequest(documentId, body), {
    params: Promise.resolve({ id: documentId }),
  });
  return response.status;
}

async function moveStatus(
  artifactId: string,
  targetProjectId: string | null,
  options: { includeDownstream?: boolean } = {}
): Promise<number> {
  const response = await moveArtifact(
    post("/artifact-links/batch-move", {
      artifactId,
      targetProjectId,
      includeDownstream: options.includeDownstream ?? false,
    }),
    undefined as never
  );
  return response.status;
}

function putRequest(documentId: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/documents/${documentId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function auditEvents(): unknown[] {
  return [
    ...auditMocks.dispatchAuditEvent.mock.calls.map((call) => call[0]),
    ...auditMocks.dispatchAuditEvents.mock.calls.flatMap(
      (call) => call[0] as unknown[]
    ),
  ];
}
