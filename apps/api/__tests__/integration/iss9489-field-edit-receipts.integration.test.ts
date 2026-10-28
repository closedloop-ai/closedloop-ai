import { randomUUID } from "node:crypto";
import {
  ArtifactActivityAction,
  ArtifactActivityActorType,
} from "@repo/api/src/types/artifact-activity";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import {
  type Document,
  DocumentStatus,
  DocumentType,
} from "@repo/api/src/types/document";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import {
  captureArtifactUpdate,
  captureBatchStatusChange,
} from "@/lib/artifact-activity-capture";

const routeState = vi.hoisted(() => ({
  user: { id: "", organizationId: "" },
  scheduled: [] as Promise<unknown>[],
}));
const analyticsCaptureImmediate = vi.hoisted(() => vi.fn());

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
  nodeAnalytics: { captureImmediate: analyticsCaptureImmediate },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    routeState.scheduled.push(Promise.resolve(work));
  },
}));

vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvent: vi.fn(),
  dispatchAuditEvents: vi.fn(),
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

import { POST as batchMoveArtifacts } from "@/app/artifact-links/batch-move/route";
import { artifactCustomFieldValueService } from "@/app/custom-fields/artifact-custom-field-value-service";
import { PUT } from "@/app/documents/[id]/route";
import { artifactActivityService } from "@/app/documents/artifact-activity-service";
import { createDocumentRecord } from "@/app/documents/document-service";

const organizations = createCommittedTestOrganizationTracker();
const customFieldIds = new Set<string>();

type World = {
  organizationId: string;
  userId: string;
  projectId: string;
};

describe.skipIf(!keys().DATABASE_URL)("ISS-9489 field-edit receipts", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(routeState.scheduled.splice(0));
    analyticsCaptureImmediate.mockReset();
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

  it.each([
    [ArtifactStatusEditSurface.Detail, "detail", false],
    [ArtifactStatusEditSurface.InlineCell, "inline_cell", false],
    [ArtifactStatusEditSurface.Board, "board", true],
  ] as const)(
    "persists a classified %s route receipt through the production caller",
    async (surface, persistedSurface, grouped) => {
      const world = await seedWorld();
      const document = await seedDocument(
        world,
        `production caller ${surface}`
      );
      routeState.user = {
        id: world.userId,
        organizationId: world.organizationId,
      };

      const response = await PUT(
        request(document.id, { priority: Priority.High, surface }),
        { params: Promise.resolve({ id: document.id }) }
      );

      expect(response.status).toBe(200);
      const persisted = await withDb((db) =>
        db.artifact.findUniqueOrThrow({
          where: { id: document.id },
          select: { priority: true },
        })
      );
      expect(persisted.priority).toBe(Priority.High);
      const receipts = await readReceipts(world.organizationId, document.id);
      expect(receipts).toEqual([
        {
          action: "field_change",
          before: {
            field: "priority",
            value: null,
            valueClassification: "absent",
          },
          after: {
            field: "priority",
            value: "HIGH",
            valueClassification: "enumerated",
            result: "committed",
            surface: persistedSurface,
            ...(grouped ? { commitGroupId: expect.any(String) } : {}),
          },
        },
      ]);
    }
  );

  it.each([
    ["unknown future", "command_palette", undefined],
    ["known bulk", ArtifactStatusEditSurface.Bulk, "bulk"],
  ] as const)(
    "keeps %s batch-move provenance honest through route, receipt, and analytics",
    async (_case, surface, persistedSurface) => {
      const world = await seedWorld();
      const targetProjectId = await createTestProject(
        world.organizationId,
        world.userId
      );
      const document = await seedDocument(world, `batch move ${surface}`);
      routeState.user = {
        id: world.userId,
        organizationId: world.organizationId,
      };

      const response = await batchMoveArtifacts(
        batchMoveRequest(document.id, targetProjectId, surface),
        undefined as never
      );
      expect(response.status).toBe(200);
      await Promise.all(routeState.scheduled.splice(0));

      const persisted = await withDb((db) =>
        db.artifact.findUniqueOrThrow({
          where: { id: document.id },
          select: { projectId: true },
        })
      );
      expect(persisted.projectId).toBe(targetProjectId);

      const expectedAfter = {
        field: "projectId",
        value: targetProjectId,
        valueClassification: "reference",
        result: "committed",
        ...(persistedSurface === undefined
          ? {}
          : {
              surface: persistedSurface,
              commitGroupId: expect.any(String),
            }),
      };
      await expect(
        readReceipts(world.organizationId, document.id)
      ).resolves.toEqual([
        {
          action: "field_change",
          before: {
            field: "projectId",
            value: world.projectId,
            valueClassification: "reference",
          },
          after: expectedAfter,
        },
      ]);

      expect(analyticsCaptureImmediate).toHaveBeenCalledTimes(1);
      expect(analyticsCaptureImmediate).toHaveBeenCalledWith({
        distinctId: world.userId,
        event: "artifact_field_edit_result",
        properties: {
          organizationId: world.organizationId,
          field: "projectId",
          result: "committed",
          artifactCount: 1,
          lineage: "grouped",
          toValueClassification: "reference",
          occurrences: 1,
          ...(persistedSurface === undefined
            ? {}
            : { surface: persistedSurface }),
        },
      });
    }
  );

  it("does not add a second receipt for a same-value retry", async () => {
    const world = await seedWorld();
    const document = await seedDocument(world, "same-value retry");
    routeState.user = {
      id: world.userId,
      organizationId: world.organizationId,
    };
    const invoke = () =>
      PUT(
        request(document.id, {
          priority: Priority.High,
          surface: ArtifactStatusEditSurface.InlineCell,
        }),
        { params: Promise.resolve({ id: document.id }) }
      );

    await expect(invoke()).resolves.toMatchObject({ status: 200 });
    await expect(invoke()).resolves.toMatchObject({ status: 200 });
    await expect(
      readReceipts(world.organizationId, document.id)
    ).resolves.toHaveLength(1);
  });

  it("rolls back a real route write when its receipt store fails", async () => {
    const world = await seedWorld();
    const document = await seedDocument(world, "route rollback");
    routeState.user = {
      id: world.userId,
      organizationId: world.organizationId,
    };
    vi.spyOn(
      artifactActivityService,
      "recordActivityEvent"
    ).mockRejectedValueOnce(new Error("injected receipt store failure"));

    const response = await PUT(
      request(document.id, {
        priority: Priority.Urgent,
        surface: ArtifactStatusEditSurface.Detail,
      }),
      { params: Promise.resolve({ id: document.id }) }
    );

    expect(response.status).toBe(500);
    const persisted = await withDb((db) =>
      db.artifact.findUniqueOrThrow({
        where: { id: document.id },
        select: { priority: true },
      })
    );
    expect(persisted.priority).toBeNull();
    await expect(
      readReceipts(world.organizationId, document.id)
    ).resolves.toEqual([]);
  });

  it("rolls back a write when the receipt cannot pass the tenant boundary", async () => {
    const [world, foreign] = await Promise.all([seedWorld(), seedWorld()]);
    const document = await seedDocument(world, "rollback");

    await expect(
      withDb.tx(async (tx) => {
        await tx.artifact.update({
          where: { id: document.id },
          data: { priority: Priority.Urgent },
          select: { id: true },
        });
        await captureArtifactUpdate({
          tx,
          organizationId: foreign.organizationId,
          artifactId: document.id,
          actor: { userId: world.userId, authMethod: "session" },
          before: captured(document),
          after: { ...captured(document), priority: Priority.Urgent },
        });
      })
    ).rejects.toThrow("not found in organization");

    const persisted = await withDb((db) =>
      db.artifact.findUniqueOrThrow({
        where: { id: document.id },
        select: { priority: true },
      })
    );
    expect(persisted.priority).toBeNull();
    await expect(
      readReceipts(foreign.organizationId, document.id)
    ).resolves.toEqual([]);
  });

  it.each([
    ["set", "after"],
    ["clear", null],
  ] as const)(
    "commits a real custom-field %s without adding an activity/feed row",
    async (operation, nextValue) => {
      const world = await seedWorld();
      const document = await seedDocument(world, `custom field ${operation}`);
      const field = await withDb((db) =>
        db.customField.create({
          data: {
            organizationId: world.organizationId,
            name: `Receipt rollback ${operation} ${randomUUID()}`,
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
            entityId: document.id,
            textValue: "before",
            displayValue: "before",
            multiEnumValueIds: [],
            peopleValueIds: [],
          },
        })
      );
      const params = {
        fieldId: field.id,
        entityType: CustomFieldEntityType.Document,
        entityId: document.id,
        organizationId: world.organizationId,
        context: {
          actor: { userId: world.userId, authMethod: "session" as const },
          receipt: {
            provenance: { surface: ArtifactStatusEditSurface.Detail },
          },
        },
      };

      const mutation =
        nextValue === null
          ? artifactCustomFieldValueService.clear(params)
          : artifactCustomFieldValueService.set({
              ...params,
              rawValue: nextValue,
            });
      await mutation;

      const stored = await withDb((db) =>
        db.customFieldValue.findUnique({
          where: {
            customFieldId_entityType_entityId: {
              customFieldId: field.id,
              entityType: CustomFieldEntityType.Document,
              entityId: document.id,
            },
          },
          select: { textValue: true },
        })
      );
      if (nextValue === null) {
        expect(stored).toBeNull();
      } else {
        expect(stored?.textValue).toBe(nextValue);
      }
      await expect(
        readReceipts(world.organizationId, document.id)
      ).resolves.toEqual([]);
    }
  );

  it("preserves legacy bare snapshots while reading classified receipts", async () => {
    const world = await seedWorld();
    const document = await seedDocument(world, "legacy");
    await withDb((db) =>
      db.artifactActivityEvent.create({
        data: {
          organizationId: world.organizationId,
          artifactId: document.id,
          actorType: ArtifactActivityActorType.User,
          actorId: world.userId,
          action: ArtifactActivityAction.FieldChange,
          before: "old name",
          after: "new name",
        },
      })
    );

    const page = await artifactActivityService.listActivityEvents({
      organizationId: world.organizationId,
      artifactId: document.id,
    });

    expect(page.items).toEqual([
      expect.objectContaining({ before: "old name", after: "new name" }),
    ]);
  });

  it("persists grouped and undo lineage on both columns and receipt envelopes", async () => {
    const world = await seedWorld();
    const [first, second] = await Promise.all([
      seedDocument(world, "grouped-first"),
      seedDocument(world, "grouped-second"),
    ]);
    const transactionId = randomUUID();
    const undoOfTransactionId = randomUUID();

    await withDb.tx(async (tx) => {
      await tx.artifact.updateMany({
        where: { id: { in: [first.id, second.id] } },
        data: { status: DocumentStatus.Approved },
      });
      await captureBatchStatusChange({
        tx,
        organizationId: world.organizationId,
        actor: { userId: world.userId, authMethod: "session" },
        provenance: {
          surface: ArtifactStatusEditSurface.Bulk,
          commitGroupId: transactionId,
        },
        transactionId,
        undoOfTransactionId,
        changes: [first, second].map((document) => ({
          artifactId: document.id,
          before: DocumentStatus.Draft,
          after: DocumentStatus.Approved,
        })),
      });
    });

    const receipts = await withDb((db) =>
      db.artifactActivityEvent.findMany({
        where: {
          organizationId: world.organizationId,
          artifactId: { in: [first.id, second.id] },
        },
        orderBy: { artifactId: "asc" },
        select: {
          before: true,
          after: true,
          transactionId: true,
          undoOfTransactionId: true,
        },
      })
    );
    const expectedReceipt = {
      before: {
        field: "status",
        value: "DRAFT",
        valueClassification: "enumerated",
      },
      after: {
        field: "status",
        value: "APPROVED",
        valueClassification: "enumerated",
        result: "committed",
        surface: "bulk",
        commitGroupId: transactionId,
        undoOfCommitGroupId: undoOfTransactionId,
      },
      transactionId,
      undoOfTransactionId,
    };
    expect(receipts).toEqual([expectedReceipt, expectedReceipt]);
  });

  it("rolls back a batch mutation when tenant filtering short-inserts receipts", async () => {
    const [world, foreign] = await Promise.all([seedWorld(), seedWorld()]);
    const [ownedDocument, foreignDocument] = await Promise.all([
      seedDocument(world, "owned batch row"),
      seedDocument(foreign, "foreign batch row"),
    ]);
    const transactionId = randomUUID();

    await expect(
      withDb.tx(async (tx) => {
        await tx.artifact.update({
          where: { id: ownedDocument.id },
          data: { status: DocumentStatus.Approved },
          select: { id: true },
        });
        await captureBatchStatusChange({
          tx,
          organizationId: world.organizationId,
          actor: { userId: world.userId, authMethod: "session" },
          provenance: {
            surface: ArtifactStatusEditSurface.Bulk,
            commitGroupId: transactionId,
          },
          transactionId,
          changes: [ownedDocument, foreignDocument].map((document) => ({
            artifactId: document.id,
            before: DocumentStatus.Draft,
            after: DocumentStatus.Approved,
          })),
        });
      })
    ).rejects.toThrow(
      "artifact activity receipt cardinality mismatch: expected 2, inserted 1"
    );

    const persisted = await withDb((db) =>
      db.artifact.findUniqueOrThrow({
        where: { id: ownedDocument.id },
        select: { status: true },
      })
    );
    expect(persisted.status).toBe(DocumentStatus.Draft);
    await expect(
      readReceipts(world.organizationId, ownedDocument.id)
    ).resolves.toEqual([]);
  });
});

async function seedWorld(): Promise<World> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  return { organizationId, userId: user.id, projectId };
}

function seedDocument(world: World, title: string): Promise<Document> {
  return withDb.tx(async (tx) => {
    const document = await createDocumentRecord(
      tx,
      world.organizationId,
      world.userId,
      {
        content: "Integration content",
        projectId: world.projectId,
        status: DocumentStatus.Draft,
        title,
        type: DocumentType.Prd,
      }
    );
    if (!document) {
      throw new Error("Failed to seed ISS-9489 document");
    }
    return document;
  });
}

function captured(document: Document) {
  return {
    status: document.status,
    assigneeId: document.assigneeId,
    approverId: document.approverId,
    priority: document.priority,
    title: document.title,
    dueDate: document.dueDate ?? null,
    projectId: document.projectId,
  };
}

function request(documentId: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/documents/${documentId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function batchMoveRequest(
  artifactId: string,
  targetProjectId: string,
  surface: string
): NextRequest {
  return new NextRequest("http://localhost/artifact-links/batch-move", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      artifactId,
      targetProjectId,
      includeDownstream: false,
      surface,
    }),
  });
}

function readReceipts(organizationId: string, artifactId: string) {
  return withDb((db) =>
    db.artifactActivityEvent.findMany({
      where: { organizationId, artifactId },
      select: { action: true, before: true, after: true },
    })
  );
}
