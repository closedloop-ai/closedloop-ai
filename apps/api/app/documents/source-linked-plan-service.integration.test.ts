import {
  type CreateDocumentInput,
  type Document,
  DocumentStatus,
  DocumentType,
  SourceLinkedPlanCreateErrorCode,
  SourceLinkedPlanOutcome,
  SourceLinkedPlanPolicy,
} from "@repo/api/src/types/document";
import { Status } from "@repo/api/src/types/result";
import {
  ArtifactSubtype,
  ArtifactType,
  LinkType as PrismaLinkType,
  withDb,
} from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestProject,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { documentService } from "@/app/documents/document-service";
import { documentVersionService } from "@/app/documents/document-version-service";
import { sourceLinkedPlanService } from "@/app/documents/source-linked-plan-service";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;
const organizations = createCommittedTestOrganizationTracker();

type SeededProject = {
  organizationId: string;
  projectId: string;
  userId: string;
};

type LinkedImplementationPlan = {
  targetId: string;
  latestVersion: number;
};

describe.skipIf(!hasDatabase)(
  "sourceLinkedPlanService.createOrReuse (Postgres)",
  () => {
    afterEach(async () => {
      await organizations.cleanup();
    });

    it("creates and links a plan with a real current version when none exists", async () => {
      const context = await seedProject();
      const source = await createDocument(context, {
        title: "Source PRD",
        type: DocumentType.Prd,
      });

      const result = await createOrReusePlan(context, source.id, {
        content: "created content",
        title: "Created plan",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected source-linked plan create to succeed");
      }
      expect(result.value.sourceLinkedPlanResult).toEqual({
        currentPlanVersion: 1,
        outcome: SourceLinkedPlanOutcome.Created,
        planId: result.value.document.id,
        policy: SourceLinkedPlanPolicy.ReuseOrCreate,
        sourceId: source.id,
      });
      expect(result.value.document.latestVersion).toBe(1);
      expect(await readLinkedImplementationPlans(context, source.id)).toEqual([
        {
          latestVersion: 1,
          targetId: result.value.document.id,
        },
      ]);
    });

    it("reuses a single linked plan with its selected latest version and no version append", async () => {
      const context = await seedProject();
      const source = await createDocument(context, {
        title: "Source PRD",
        type: DocumentType.Prd,
      });
      const existing = await createDocument(context, {
        sourceId: source.id,
        title: "Existing plan",
        type: DocumentType.ImplementationPlan,
      });
      const secondVersion = await documentVersionService.createVersion(
        existing.id,
        context.organizationId,
        context.userId,
        "existing v2"
      );
      expect(secondVersion?.version).toBe(2);

      const result = await createOrReusePlan(context, source.id, {
        content: "incoming content must not be appended",
        title: "Incoming plan",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("expected source-linked plan reuse to succeed");
      }
      expect(result.value.document.id).toBe(existing.id);
      expect(result.value.sourceLinkedPlanResult).toEqual({
        currentPlanVersion: 2,
        outcome: SourceLinkedPlanOutcome.ReusedExisting,
        planId: existing.id,
        policy: SourceLinkedPlanPolicy.ReuseOrCreate,
        sourceId: source.id,
      });
      expect(await readDocumentVersions(existing.id)).toEqual([
        { content: "Content", version: 1 },
        { content: "existing v2", version: 2 },
      ]);
      expect(await readLinkedImplementationPlans(context, source.id)).toEqual([
        { latestVersion: 2, targetId: existing.id },
      ]);
    });

    it("returns ambiguity without writing when normal create already produced multiple linked plans", async () => {
      const context = await seedProject();
      const source = await createDocument(context, {
        title: "Source PRD",
        type: DocumentType.Prd,
      });
      const first = await createDocument(context, {
        sourceId: source.id,
        title: "First normal plan",
        type: DocumentType.ImplementationPlan,
      });
      const second = await createDocument(context, {
        sourceId: source.id,
        title: "Second normal plan",
        type: DocumentType.ImplementationPlan,
      });
      expect(
        sortLinked(await readLinkedImplementationPlans(context, source.id))
      ).toEqual([
        { latestVersion: 1, targetId: first.id },
        { latestVersion: 1, targetId: second.id },
      ]);

      const result = await createOrReusePlan(context, source.id, {
        title: "Ambiguous incoming plan",
      });

      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("expected source-linked plan create to be ambiguous");
      }
      if (result.error.code !== SourceLinkedPlanCreateErrorCode.Ambiguous) {
        throw new Error("expected an ambiguity error");
      }
      expect(sortAmbiguousPlans(result.error.plans)).toEqual(
        sortAmbiguousPlans([
          {
            currentVersion: 1,
            id: first.id,
            slug: first.slug,
            title: first.title,
          },
          {
            currentVersion: 1,
            id: second.id,
            slug: second.slug,
            title: second.title,
          },
        ])
      );
      expect(
        sortLinked(await readLinkedImplementationPlans(context, source.id))
      ).toEqual([
        { latestVersion: 1, targetId: first.id },
        { latestVersion: 1, targetId: second.id },
      ]);
    });

    it("rejects a source from a different project before creating a link", async () => {
      const context = await seedProject();
      const otherProjectId = await createTestProject(
        context.organizationId,
        context.userId,
        { name: "Other project" }
      );
      const source = await createDocument(context, {
        title: "Source PRD",
        type: DocumentType.Prd,
      });

      const result = await sourceLinkedPlanService.createOrReuse(
        context.organizationId,
        context.userId,
        {
          ...planInput({ projectId: otherProjectId, sourceId: source.id }),
          sourceLinkedPlanPolicy: SourceLinkedPlanPolicy.ReuseOrCreate,
        }
      );

      expect(result).toEqual({
        error: {
          code: Status.BadRequest,
          message:
            "sourceId must belong to the target project for source-linked plan reuse",
        },
        ok: false,
      });
      expect(await readLinkedImplementationPlans(context, source.id)).toEqual(
        []
      );
    });

    it("rejects a source from another organization without leaking linked plans", async () => {
      const context = await seedProject();
      const otherContext = await seedProject();
      const otherSource = await createDocument(otherContext, {
        title: "Other org source",
        type: DocumentType.Prd,
      });
      await createDocument(otherContext, {
        sourceId: otherSource.id,
        title: "Other org plan",
        type: DocumentType.ImplementationPlan,
      });

      const result = await sourceLinkedPlanService.createOrReuse(
        context.organizationId,
        context.userId,
        {
          ...planInput({
            projectId: context.projectId,
            sourceId: otherSource.id,
          }),
          sourceLinkedPlanPolicy: SourceLinkedPlanPolicy.ReuseOrCreate,
        }
      );

      expect(result).toEqual({
        error: {
          code: Status.NotFound,
          message: "Source artifact not found",
        },
        ok: false,
      });
      expect(
        await readLinkedImplementationPlans(otherContext, otherSource.id)
      ).toHaveLength(1);
    });

    it("serializes concurrent opt-in creates for the same source", async () => {
      const context = await seedProject();
      const source = await createDocument(context, {
        title: "Race source PRD",
        type: DocumentType.Prd,
      });

      const [first, second] = await Promise.all([
        createOrReusePlan(context, source.id, { title: "Race plan A" }),
        createOrReusePlan(context, source.id, { title: "Race plan B" }),
      ]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!(first.ok && second.ok)) {
        throw new Error("expected both concurrent creates to resolve");
      }
      const results = [first.value, second.value];
      const outcomes = results
        .map((result) => result.sourceLinkedPlanResult.outcome)
        .sort();
      expect(outcomes).toEqual([
        SourceLinkedPlanOutcome.Created,
        SourceLinkedPlanOutcome.ReusedExisting,
      ]);
      expect(new Set(results.map((result) => result.document.id)).size).toBe(1);
      expect(
        results.map(
          (result) => result.sourceLinkedPlanResult.currentPlanVersion
        )
      ).toEqual([1, 1]);
      const linkedPlans = await readLinkedImplementationPlans(
        context,
        source.id
      );
      expect(linkedPlans).toEqual([
        { latestVersion: 1, targetId: results[0].document.id },
      ]);
    });
  }
);

async function seedProject(): Promise<SeededProject> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  const projectId = await createTestProject(organizationId, user.id);
  return { organizationId, projectId, userId: user.id };
}

async function createDocument(
  context: SeededProject,
  overrides: Partial<CreateDocumentInput>
): Promise<Document> {
  const document = await documentService.create(
    context.organizationId,
    context.userId,
    {
      content: "Content",
      projectId: context.projectId,
      status: DocumentStatus.Draft,
      title: "Document",
      type: DocumentType.Prd,
      ...overrides,
    }
  );
  if (!document) {
    throw new Error("Failed to create test document");
  }
  return document;
}

function createOrReusePlan(
  context: SeededProject,
  sourceId: string,
  overrides: Partial<CreateDocumentInput> = {}
) {
  return sourceLinkedPlanService.createOrReuse(
    context.organizationId,
    context.userId,
    {
      ...planInput({ projectId: context.projectId, sourceId }),
      ...overrides,
      sourceLinkedPlanPolicy: SourceLinkedPlanPolicy.ReuseOrCreate,
    }
  );
}

function planInput(input: {
  projectId: string;
  sourceId: string;
}): CreateDocumentInput & {
  projectId: string;
  sourceId: string;
} {
  return {
    content: "Plan content",
    projectId: input.projectId,
    sourceId: input.sourceId,
    status: DocumentStatus.Draft,
    title: "Implementation plan",
    type: DocumentType.ImplementationPlan,
  };
}

function readLinkedImplementationPlans(
  context: SeededProject,
  sourceId: string
): Promise<LinkedImplementationPlan[]> {
  return withDb(async (db) => {
    const links = await db.artifactLink.findMany({
      where: {
        linkType: PrismaLinkType.PRODUCES,
        organizationId: context.organizationId,
        sourceId,
        target: {
          organizationId: context.organizationId,
          subtype: ArtifactSubtype.IMPLEMENTATION_PLAN,
          type: ArtifactType.DOCUMENT,
        },
      },
      select: {
        target: {
          select: {
            document: { select: { latestVersion: true } },
            id: true,
          },
        },
        targetId: true,
      },
      orderBy: { createdAt: "asc" },
    });

    return links.map((link) => {
      if (!link.target.document) {
        throw new Error(
          "Linked implementation plan is missing document detail"
        );
      }
      return {
        latestVersion: link.target.document.latestVersion,
        targetId: link.targetId,
      };
    });
  });
}

function readDocumentVersions(
  documentId: string
): Promise<Array<{ content: string | null; version: number }>> {
  return withDb((db) =>
    db.documentVersion.findMany({
      where: { documentId },
      orderBy: { version: "asc" },
      select: { content: true, version: true },
    })
  );
}

function sortLinked(
  linkedPlans: LinkedImplementationPlan[]
): LinkedImplementationPlan[] {
  return [...linkedPlans].sort((first, second) =>
    first.targetId.localeCompare(second.targetId)
  );
}

function sortAmbiguousPlans<Plan extends { id: string }>(
  plans: Plan[]
): Plan[] {
  return [...plans].sort((first, second) => first.id.localeCompare(second.id));
}
