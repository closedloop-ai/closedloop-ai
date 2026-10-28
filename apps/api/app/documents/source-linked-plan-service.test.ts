import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  type Document,
  DocumentStatus,
  DocumentType,
  SnapshotSource,
  SourceLinkedPlanCreateErrorCode,
  SourceLinkedPlanOutcome,
  SourceLinkedPlanPolicy,
} from "@repo/api/src/types/document";
import { Result, Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const SOURCE_ID = "source-1";
const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_SLUG = "team-plan";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  createDocumentRecord: vi.fn(),
  indexDocumentProjection: vi.fn(),
  toDocument: vi.fn(),
  createDocumentRoom: vi.fn(),
  acquireLock: vi.fn(),
  documentIncludeStub: { __stub: "document-include-with-user" },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("./document-service", () => ({
  createDocumentRecord: mocks.createDocumentRecord,
  indexDocumentProjection: mocks.indexDocumentProjection,
}));

vi.mock("./document-utils", () => ({
  documentIncludeWithUser: mocks.documentIncludeStub,
  toDocument: mocks.toDocument,
}));

vi.mock("./room-utils", () => ({
  createDocumentRoom: mocks.createDocumentRoom,
}));

vi.mock("./source-linked-plan-lock", () => ({
  acquireSourceLinkedPlanLockInTransaction: mocks.acquireLock,
}));

import {
  type CreateOrReuseSourceLinkedPlanInput,
  sourceLinkedPlanService,
} from "./source-linked-plan-service";

type FakeTx = {
  artifact: { findFirst: ReturnType<typeof vi.fn> };
  project: {
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  artifactLink: { findMany: ReturnType<typeof vi.fn> };
};

function createFakeTx(): FakeTx {
  return {
    artifact: { findFirst: vi.fn() },
    project: { findFirst: vi.fn(), findUnique: vi.fn() },
    artifactLink: { findMany: vi.fn() },
  };
}

function buildInput(
  overrides: Partial<CreateOrReuseSourceLinkedPlanInput> = {}
): CreateOrReuseSourceLinkedPlanInput {
  return {
    content: "Plan body content",
    projectId: PROJECT_ID,
    sourceId: SOURCE_ID,
    sourceLinkedPlanPolicy: SourceLinkedPlanPolicy.ReuseOrCreate,
    status: DocumentStatus.Draft,
    title: "Implementation plan",
    type: DocumentType.ImplementationPlan,
    ...overrides,
  };
}

function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    approver: null,
    approverId: null,
    assignee: null,
    assigneeId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    createdBy: null,
    createdById: USER_ID,
    fileName: null,
    id: "plan-created-1",
    latestVersion: 1,
    organizationId: ORGANIZATION_ID,
    priority: Priority.Medium,
    projectId: PROJECT_ID,
    repositorySnapshot: {
      createdAt: "2026-01-01T00:00:00.000Z",
      repositories: [],
      source: SnapshotSource.None,
    },
    slug: "PLN-1",
    sortOrder: null,
    status: DocumentStatus.Draft,
    templateForType: null,
    title: "Created plan",
    type: DocumentType.ImplementationPlan,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("sourceLinkedPlanService.createOrReuse", () => {
  let tx: FakeTx;

  beforeEach(() => {
    vi.clearAllMocks();
    tx = createFakeTx();
    mocks.withDb.tx.mockImplementation((callback: (db: FakeTx) => unknown) =>
      callback(tx)
    );
  });

  describe("input validation", () => {
    it("returns a bad-request error without opening a transaction when the type is not an implementation plan", async () => {
      const result = await sourceLinkedPlanService.createOrReuse(
        ORGANIZATION_ID,
        USER_ID,
        buildInput({ type: DocumentType.Prd })
      );

      expect(result).toEqual(
        Result.err({
          code: Status.BadRequest,
          message: "Invalid source-linked implementation plan create request",
        })
      );
      expect(mocks.withDb.tx).not.toHaveBeenCalled();
    });

    it("returns a bad-request error without opening a transaction when sourceId is blank", async () => {
      const result = await sourceLinkedPlanService.createOrReuse(
        ORGANIZATION_ID,
        USER_ID,
        buildInput({ sourceId: "" })
      );

      expect(result).toEqual(
        Result.err({
          code: Status.BadRequest,
          message: "Invalid source-linked implementation plan create request",
        })
      );
      expect(mocks.withDb.tx).not.toHaveBeenCalled();
    });

    it("returns a bad-request error without opening a transaction when projectId is blank", async () => {
      const result = await sourceLinkedPlanService.createOrReuse(
        ORGANIZATION_ID,
        USER_ID,
        buildInput({ projectId: "" })
      );

      expect(result).toEqual(
        Result.err({
          code: Status.BadRequest,
          message: "Invalid source-linked implementation plan create request",
        })
      );
      expect(mocks.withDb.tx).not.toHaveBeenCalled();
    });
  });

  describe("source and project resolution", () => {
    it("returns not-found and skips room/projection side effects when the source artifact does not exist", async () => {
      tx.artifact.findFirst.mockResolvedValue(null);

      const result = await sourceLinkedPlanService.createOrReuse(
        ORGANIZATION_ID,
        USER_ID,
        buildInput()
      );

      expect(tx.artifact.findFirst).toHaveBeenCalledWith({
        where: { id: SOURCE_ID, organizationId: ORGANIZATION_ID },
        select: { id: true, projectId: true },
      });
      expect(result).toEqual(
        Result.err({
          code: Status.NotFound,
          message: "Source artifact not found",
        })
      );
      expect(mocks.createDocumentRoom).not.toHaveBeenCalled();
      expect(mocks.indexDocumentProjection).not.toHaveBeenCalled();
      expect(mocks.createDocumentRecord).not.toHaveBeenCalled();
    });

    it("returns not-found when the target project cannot be resolved by UUID", async () => {
      tx.artifact.findFirst.mockResolvedValue({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
      });
      tx.project.findFirst.mockResolvedValue(null);

      const result = await sourceLinkedPlanService.createOrReuse(
        ORGANIZATION_ID,
        USER_ID,
        buildInput({ projectId: PROJECT_ID })
      );

      expect(tx.project.findFirst).toHaveBeenCalledWith({
        where: { id: PROJECT_ID, organizationId: ORGANIZATION_ID },
        select: { id: true },
      });
      expect(tx.project.findUnique).not.toHaveBeenCalled();
      expect(result).toEqual(
        Result.err({ code: Status.NotFound, message: "Project not found" })
      );
      expect(mocks.createDocumentRecord).not.toHaveBeenCalled();
    });

    it("resolves the target project by slug and rejects a source that belongs to a different project", async () => {
      const otherSourceProjectId = "other-project";
      const resolvedProjectId = "22222222-2222-2222-2222-222222222222";
      tx.artifact.findFirst.mockResolvedValue({
        id: SOURCE_ID,
        projectId: otherSourceProjectId,
      });
      tx.project.findUnique.mockResolvedValue({ id: resolvedProjectId });

      const result = await sourceLinkedPlanService.createOrReuse(
        ORGANIZATION_ID,
        USER_ID,
        buildInput({ projectId: PROJECT_SLUG })
      );

      expect(tx.project.findFirst).not.toHaveBeenCalled();
      expect(tx.project.findUnique).toHaveBeenCalledWith({
        where: {
          organizationId_slug: {
            organizationId: ORGANIZATION_ID,
            slug: PROJECT_SLUG,
          },
        },
        select: { id: true },
      });
      expect(result).toEqual(
        Result.err({
          code: Status.BadRequest,
          message:
            "sourceId must belong to the target project for source-linked plan reuse",
        })
      );
      expect(mocks.createDocumentRecord).not.toHaveBeenCalled();
    });

    it("returns not-found when the target project cannot be resolved by slug", async () => {
      tx.artifact.findFirst.mockResolvedValue({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
      });
      tx.project.findUnique.mockResolvedValue(null);

      const result = await sourceLinkedPlanService.createOrReuse(
        ORGANIZATION_ID,
        USER_ID,
        buildInput({ projectId: PROJECT_SLUG })
      );

      expect(result).toEqual(
        Result.err({ code: Status.NotFound, message: "Project not found" })
      );
      expect(mocks.createDocumentRecord).not.toHaveBeenCalled();
    });
  });

  describe("create path", () => {
    it("creates a new implementation plan, provisions its room, and indexes its projection when no linked plan exists", async () => {
      tx.artifact.findFirst.mockResolvedValue({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
      });
      tx.project.findFirst.mockResolvedValue({ id: PROJECT_ID });
      tx.artifactLink.findMany.mockResolvedValue([]);
      const createdDocument = makeDocument({
        id: "plan-created-1",
        latestVersion: 1,
      });
      mocks.createDocumentRecord.mockResolvedValue(createdDocument);

      const result = await sourceLinkedPlanService.createOrReuse(
        ORGANIZATION_ID,
        USER_ID,
        buildInput({ content: "Plan body content" })
      );

      expect(mocks.acquireLock).toHaveBeenCalledWith(tx, {
        organizationId: ORGANIZATION_ID,
        sourceId: SOURCE_ID,
      });
      expect(tx.artifactLink.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORGANIZATION_ID,
          sourceId: SOURCE_ID,
          linkType: LinkType.Produces,
          target: {
            organizationId: ORGANIZATION_ID,
            type: ArtifactType.Document,
            subtype: DocumentType.ImplementationPlan,
          },
        },
        select: { target: { include: mocks.documentIncludeStub } },
        orderBy: { createdAt: "asc" },
      });
      expect(mocks.createDocumentRecord).toHaveBeenCalledWith(
        tx,
        ORGANIZATION_ID,
        USER_ID,
        {
          content: "Plan body content",
          projectId: PROJECT_ID,
          sourceId: SOURCE_ID,
          status: DocumentStatus.Draft,
          title: "Implementation plan",
          type: DocumentType.ImplementationPlan,
        }
      );
      expect(result).toEqual(
        Result.ok({
          document: createdDocument,
          sourceLinkedPlanResult: {
            currentPlanVersion: 1,
            outcome: SourceLinkedPlanOutcome.Created,
            planId: "plan-created-1",
            policy: SourceLinkedPlanPolicy.ReuseOrCreate,
            sourceId: SOURCE_ID,
          },
        })
      );
      expect(mocks.createDocumentRoom).toHaveBeenCalledWith(createdDocument);
      expect(mocks.indexDocumentProjection).toHaveBeenCalledWith(
        createdDocument,
        "Plan body content"
      );
    });

    it("returns a bad-request error when document creation fails and skips room/projection side effects", async () => {
      tx.artifact.findFirst.mockResolvedValue({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
      });
      tx.project.findFirst.mockResolvedValue({ id: PROJECT_ID });
      tx.artifactLink.findMany.mockResolvedValue([]);
      mocks.createDocumentRecord.mockResolvedValue(null);

      const result = await sourceLinkedPlanService.createOrReuse(
        ORGANIZATION_ID,
        USER_ID,
        buildInput()
      );

      expect(result).toEqual(
        Result.err({
          code: Status.BadRequest,
          message: "Failed to create implementation plan",
        })
      );
      expect(mocks.createDocumentRoom).not.toHaveBeenCalled();
      expect(mocks.indexDocumentProjection).not.toHaveBeenCalled();
    });
  });

  describe("reuse path", () => {
    it("reuses the single existing linked plan without provisioning a room or indexing a projection", async () => {
      tx.artifact.findFirst.mockResolvedValue({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
      });
      tx.project.findFirst.mockResolvedValue({ id: PROJECT_ID });
      const existingTarget = {
        id: "existing-1",
        name: "Existing Plan",
        slug: "PLN-9",
        document: { latestVersion: 4 },
      };
      tx.artifactLink.findMany.mockResolvedValue([{ target: existingTarget }]);
      const existingDocument = makeDocument({
        id: "existing-1",
        latestVersion: 4,
        slug: "PLN-9",
        title: "Existing Plan",
      });
      mocks.toDocument.mockReturnValue(existingDocument);

      const result = await sourceLinkedPlanService.createOrReuse(
        ORGANIZATION_ID,
        USER_ID,
        buildInput()
      );

      expect(mocks.toDocument).toHaveBeenCalledWith(existingTarget);
      expect(result).toEqual(
        Result.ok({
          document: existingDocument,
          sourceLinkedPlanResult: {
            currentPlanVersion: 4,
            outcome: SourceLinkedPlanOutcome.ReusedExisting,
            planId: "existing-1",
            policy: SourceLinkedPlanPolicy.ReuseOrCreate,
            sourceId: SOURCE_ID,
          },
        })
      );
      expect(mocks.createDocumentRecord).not.toHaveBeenCalled();
      expect(mocks.createDocumentRoom).not.toHaveBeenCalled();
      expect(mocks.indexDocumentProjection).not.toHaveBeenCalled();
    });

    it("throws when the single linked plan is missing its document detail", async () => {
      tx.artifact.findFirst.mockResolvedValue({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
      });
      tx.project.findFirst.mockResolvedValue({ id: PROJECT_ID });
      tx.artifactLink.findMany.mockResolvedValue([
        {
          target: {
            id: "existing-1",
            name: "Existing Plan",
            slug: "PLN-9",
            document: null,
          },
        },
      ]);

      // pins current behavior; looks odd because a missing document detail on
      // a linked plan surfaces as an unhandled thrown error rather than a
      // Result.err, so the route's `result.ok` branch never sees it. Tracked
      // in ISS-10523.
      await expect(
        sourceLinkedPlanService.createOrReuse(
          ORGANIZATION_ID,
          USER_ID,
          buildInput()
        )
      ).rejects.toThrow(
        "Linked implementation plan is missing document detail"
      );
    });
  });

  describe("ambiguous path", () => {
    it("returns an ambiguity error listing every linked plan, omitting slug only for entries without one", async () => {
      tx.artifact.findFirst.mockResolvedValue({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
      });
      tx.project.findFirst.mockResolvedValue({ id: PROJECT_ID });
      tx.artifactLink.findMany.mockResolvedValue([
        {
          target: {
            id: "plan-a",
            name: "Plan A",
            slug: "PLN-1",
            document: { latestVersion: 1 },
          },
        },
        {
          target: {
            id: "plan-b",
            name: "Plan B",
            slug: null,
            document: { latestVersion: 2 },
          },
        },
      ]);

      const result = await sourceLinkedPlanService.createOrReuse(
        ORGANIZATION_ID,
        USER_ID,
        buildInput()
      );

      expect(result).toEqual(
        Result.err({
          code: SourceLinkedPlanCreateErrorCode.Ambiguous,
          plans: [
            { currentVersion: 1, id: "plan-a", slug: "PLN-1", title: "Plan A" },
            { currentVersion: 2, id: "plan-b", title: "Plan B" },
          ],
        })
      );
      expect(mocks.createDocumentRecord).not.toHaveBeenCalled();
      expect(mocks.createDocumentRoom).not.toHaveBeenCalled();
      expect(mocks.indexDocumentProjection).not.toHaveBeenCalled();
    });

    it("throws when an ambiguous linked plan is missing its document detail", async () => {
      tx.artifact.findFirst.mockResolvedValue({
        id: SOURCE_ID,
        projectId: PROJECT_ID,
      });
      tx.project.findFirst.mockResolvedValue({ id: PROJECT_ID });
      tx.artifactLink.findMany.mockResolvedValue([
        {
          target: {
            id: "plan-a",
            name: "Plan A",
            slug: "PLN-1",
            document: { latestVersion: 1 },
          },
        },
        {
          target: {
            id: "plan-b",
            name: "Plan B",
            slug: null,
            document: null,
          },
        },
      ]);

      // pins current behavior; looks odd because a missing document detail on
      // any one of several ambiguous plans surfaces as an unhandled thrown
      // error rather than a Result.err naming which plan is broken. Tracked in
      // ISS-10523.
      await expect(
        sourceLinkedPlanService.createOrReuse(
          ORGANIZATION_ID,
          USER_ID,
          buildInput()
        )
      ).rejects.toThrow(
        "Linked implementation plan is missing document detail"
      );
    });
  });
});
