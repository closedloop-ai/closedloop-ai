import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  type CreateDocumentInput,
  type Document,
  DocumentType,
  type SourceLinkedPlanAmbiguousPlan,
  SourceLinkedPlanCreateErrorCode,
  SourceLinkedPlanOutcome,
  SourceLinkedPlanPolicy,
  type SourceLinkedPlanResult,
} from "@repo/api/src/types/document";
import {
  Result,
  type Result as ServiceResult,
  Status,
} from "@repo/api/src/types/result";
import { type TransactionClient, withDb } from "@repo/database";
import type { RecordCreatedArtifact } from "@/app/documents/document-service";
import { isUuid } from "@/lib/is-uuid";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import {
  createDocumentRecord,
  indexDocumentProjection,
} from "./document-service";
import {
  type ArtifactWithDocumentDetail,
  documentIncludeWithUser,
  toDocument,
} from "./document-utils";
import { createDocumentRoom } from "./room-utils";
import { acquireSourceLinkedPlanLockInTransaction } from "./source-linked-plan-lock";

export type CreateOrReuseSourceLinkedPlanInput = CreateDocumentInput & {
  projectId: string;
  sourceId: string;
  sourceLinkedPlanPolicy: typeof SourceLinkedPlanPolicy.ReuseOrCreate;
};

export type SourceLinkedPlanCreateSuccess = {
  document: Document;
  sourceLinkedPlanResult: SourceLinkedPlanResult;
};

export type SourceLinkedPlanCreateError =
  | {
      code: typeof SourceLinkedPlanCreateErrorCode.Ambiguous;
      plans: SourceLinkedPlanAmbiguousPlan[];
    }
  | {
      code: typeof Status.BadRequest | typeof Status.NotFound;
      message: string;
    };

export const sourceLinkedPlanService = {
  /**
   * Opt-in server transaction contract for POST /documents callers that want a
   * source-linked Implementation Plan without racing another opt-in writer.
   */
  async createOrReuse(
    organizationId: string,
    userId: string,
    input: CreateOrReuseSourceLinkedPlanInput,
    /** {@link RecordCreatedArtifact} (ISS-10993). */
    recordCreated?: RecordCreatedArtifact,
    /** Runs on the same transaction when an existing plan is reused (ISS-12552). */
    recordReused?: RecordWriteInTransaction<Document>
  ): Promise<SourceLinkedPlanCreateResult> {
    const inputError = validateCreateOrReuseInput(input);
    if (inputError) {
      return Result.err(inputError);
    }

    const result = await withDb.tx((tx) =>
      createOrReuseInTransaction(tx, organizationId, userId, input, {
        recordCreated,
        recordReused,
      })
    );
    if (
      result.ok &&
      result.value.sourceLinkedPlanResult.outcome ===
        SourceLinkedPlanOutcome.Created
    ) {
      await createDocumentRoom(result.value.document);
      indexDocumentProjection(result.value.document, input.content ?? null);
    }

    return result;
  },
};

async function createOrReuseInTransaction(
  tx: TransactionClient,
  organizationId: string,
  userId: string,
  input: CreateOrReuseSourceLinkedPlanInput,
  records: {
    recordCreated?: RecordCreatedArtifact;
    recordReused?: RecordWriteInTransaction<Document>;
  }
): Promise<SourceLinkedPlanCreateResult> {
  const { recordCreated, recordReused } = records;
  await acquireSourceLinkedPlanLockInTransaction(tx, {
    organizationId,
    sourceId: input.sourceId,
  });

  const resolved = await resolveLockedSourceAndProject(tx, {
    organizationId,
    projectIdentifier: input.projectId,
    sourceId: input.sourceId,
  });
  if (!resolved.ok) {
    return Result.err(resolved.error);
  }

  const linkedPlans = await findLinkedImplementationPlans(tx, {
    organizationId,
    sourceId: input.sourceId,
  });
  if (linkedPlans.length > 1) {
    return Result.err({
      code: SourceLinkedPlanCreateErrorCode.Ambiguous,
      plans: linkedPlans.map(toAmbiguousPlan),
    });
  }
  if (linkedPlans.length === 1) {
    const document = toLinkedPlanDocument(linkedPlans[0].target);
    await recordReused?.(tx, document);
    return Result.ok({
      document,
      sourceLinkedPlanResult: sourceLinkedPlanResult({
        document,
        outcome: SourceLinkedPlanOutcome.ReusedExisting,
        sourceId: input.sourceId,
      }),
    });
  }

  const { sourceLinkedPlanPolicy: _sourceLinkedPlanPolicy, ...createInput } =
    input;
  const createdDocument = await createDocumentRecord(
    tx,
    organizationId,
    userId,
    {
      ...createInput,
      projectId: resolved.value.projectId,
      sourceId: input.sourceId,
    }
  );
  if (!createdDocument) {
    return Result.err({
      code: Status.BadRequest,
      message: "Failed to create implementation plan",
    });
  }

  // The receipt for a REUSE is deliberately absent: nothing was created, so a
  // creation row would record an event that never happened.
  await recordCreated?.(tx, createdDocument);

  return Result.ok({
    document: createdDocument,
    sourceLinkedPlanResult: sourceLinkedPlanResult({
      document: createdDocument,
      outcome: SourceLinkedPlanOutcome.Created,
      sourceId: input.sourceId,
    }),
  });
}

async function resolveLockedSourceAndProject(
  tx: TransactionClient,
  input: {
    organizationId: string;
    projectIdentifier: string;
    sourceId: string;
  }
): Promise<ServiceResult<{ projectId: string }, SourceLinkedPlanCreateError>> {
  const source = await tx.artifact.findFirst({
    where: { id: input.sourceId, organizationId: input.organizationId },
    select: { id: true, projectId: true },
  });
  if (!source) {
    return Result.err({
      code: Status.NotFound,
      message: "Source artifact not found",
    });
  }

  const projectId = await resolveProjectIdInTransaction(tx, {
    organizationId: input.organizationId,
    projectIdentifier: input.projectIdentifier,
  });
  if (!projectId) {
    return Result.err({
      code: Status.NotFound,
      message: "Project not found",
    });
  }
  if (source.projectId !== projectId) {
    return Result.err({
      code: Status.BadRequest,
      message:
        "sourceId must belong to the target project for source-linked plan reuse",
    });
  }

  return Result.ok({ projectId });
}

async function resolveProjectIdInTransaction(
  tx: TransactionClient,
  input: {
    organizationId: string;
    projectIdentifier: string;
  }
): Promise<string | null> {
  if (isUuid(input.projectIdentifier)) {
    const project = await tx.project.findFirst({
      where: {
        id: input.projectIdentifier,
        organizationId: input.organizationId,
      },
      select: { id: true },
    });
    return project?.id ?? null;
  }

  const project = await tx.project.findUnique({
    where: {
      organizationId_slug: {
        organizationId: input.organizationId,
        slug: input.projectIdentifier,
      },
    },
    select: { id: true },
  });
  return project?.id ?? null;
}

function findLinkedImplementationPlans(
  tx: TransactionClient,
  input: { organizationId: string; sourceId: string }
): Promise<LinkedPlanRow[]> {
  return tx.artifactLink.findMany({
    where: {
      organizationId: input.organizationId,
      sourceId: input.sourceId,
      linkType: LinkType.Produces,
      target: {
        organizationId: input.organizationId,
        type: ArtifactType.Document,
        subtype: DocumentType.ImplementationPlan,
      },
    },
    select: { target: { include: documentIncludeWithUser } },
    orderBy: { createdAt: "asc" },
  });
}

function validateCreateOrReuseInput(
  input: CreateOrReuseSourceLinkedPlanInput
): SourceLinkedPlanCreateError | null {
  if (
    input.sourceLinkedPlanPolicy !== SourceLinkedPlanPolicy.ReuseOrCreate ||
    input.type !== DocumentType.ImplementationPlan ||
    !input.sourceId ||
    !input.projectId
  ) {
    return {
      code: Status.BadRequest,
      message: "Invalid source-linked implementation plan create request",
    };
  }

  return null;
}

function sourceLinkedPlanResult(input: {
  document: Document;
  outcome: SourceLinkedPlanOutcome;
  sourceId: string;
}): SourceLinkedPlanResult {
  return {
    currentPlanVersion: input.document.latestVersion,
    outcome: input.outcome,
    planId: input.document.id,
    policy: SourceLinkedPlanPolicy.ReuseOrCreate,
    sourceId: input.sourceId,
  };
}

function toLinkedPlanDocument(artifact: LinkedPlanRow["target"]): Document {
  if (!artifact.document) {
    throw new Error("Linked implementation plan is missing document detail");
  }
  return toDocument(artifact);
}

function toAmbiguousPlan(row: LinkedPlanRow): SourceLinkedPlanAmbiguousPlan {
  if (!row.target.document) {
    throw new Error("Linked implementation plan is missing document detail");
  }
  return {
    currentVersion: row.target.document.latestVersion,
    id: row.target.id,
    ...(row.target.slug ? { slug: row.target.slug } : {}),
    title: row.target.name,
  };
}

type SourceLinkedPlanCreateResult = ServiceResult<
  SourceLinkedPlanCreateSuccess,
  SourceLinkedPlanCreateError
>;

type LinkedPlanRow = { target: ArtifactWithDocumentDetail };
