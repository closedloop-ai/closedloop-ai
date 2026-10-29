import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { JsonObject } from "@repo/api/src/types/common";
import {
  type ArtifactRepositorySnapshot,
  BATCH_META_MAX_SLUGS,
  CreateDocumentErrorCode,
  type CreateDocumentErrorCode as CreateDocumentErrorCodeType,
  type CreateDocumentInlineImageInput,
  type CreateDocumentInput,
  type CreatedDocumentInlineImage,
  type Document,
  type DocumentMeta,
  type DocumentMetaMap,
  DocumentType,
  type DocumentWithProject,
  fallbackStatusForSubtype,
  isProjectOptionalDocumentType,
  MAX_CREATE_DOCUMENT_INLINE_EXPANDED_CONTENT_CHARS,
  normalizeDocumentType,
  type RepositorySelectionInput,
  SnapshotSource,
  statusOptionsForSubtype,
  type UpdateDocumentInput,
} from "@repo/api/src/types/document";
import type { CreatedDocumentVersionInlineImage } from "@repo/api/src/types/document-version";
import {
  Result,
  type Result as ServiceResult,
} from "@repo/api/src/types/result";
import { expandSlugAliases } from "@repo/api/src/types/slug-prefix";
import { type Prisma, type TransactionClient, withDb } from "@repo/database";
import { waitUntil } from "@vercel/functions";
import { nextProducesLinkSortOrder } from "@/app/artifact-links/produces-link-sort-order";
import {
  type AuditActor,
  systemAuditActor,
} from "@/app/audit/audit-emit-service";
import { documentMoveService } from "@/app/documents/document-move-service";
import { computeNextSortOrder } from "@/app/documents/document-sort-order";
import {
  documentProjection,
  searchIndexService,
} from "@/app/search/search-index-service";
import { documentWhere } from "@/lib/artifact-adapters";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { generateArtifactSlug } from "@/lib/slug-generator";
import {
  isUserInOrganization,
  USER_NOT_IN_ORGANIZATION_MESSAGE,
} from "@/lib/user-org-membership";
import {
  cleanupFailedInlineImageDocument,
  createDocumentInlineImageErrorCodes,
  toCreatedDocumentInlineImage,
  updateInitialDocumentVersionContent,
} from "./create-document-inline-image-helpers";
import type { DocumentListQueryOptions } from "./custom-field-ordered-read";
import {
  DELETED_DOCUMENT_SELECT,
  documentDeleteService,
} from "./document-delete-service";
import {
  buildCreatedInlineImage,
  createInlineImageAttachmentSafely,
  replaceInlineImagePlaceholders,
  validateInlineImagesBeforeSideEffects,
} from "./document-inline-image-helpers";
import {
  findAllDocuments,
  findAllDocumentsWithCustomFields,
} from "./document-list-read";
import {
  documentIncludeWithContext,
  documentIncludeWithUser,
  splitDocumentPayload,
  toDocument,
  toDocumentWithProject,
} from "./document-utils";
import type { CreateInlineImageAttachmentError } from "./inline-image-attachment-contract";
import {
  buildSnapshotFromProjectDefaults,
  buildSnapshotFromRepositorySelection,
  inheritSnapshotFromParent,
  parseStoredSnapshot,
} from "./repository-snapshot-helpers";
import { createDocumentRoom, deleteDocumentRoom } from "./room-utils";
import { sanitizeAndLog } from "./sanitize-content";

/**
 * Document general/CRUD service. Owns reads, writes, deletes, listing,
 * template handling, related-document graph traversal, and batch utilities.
 *
 * Per FEA-680: this is the entity-level CRUD module for DOCUMENT artifacts —
 * named after the entity, not after the responsibility. Evaluation,
 * versioning, and merge live in their own sibling files and import from here.
 */

/**
 * Validate that a user belongs to the given organization. Throws if the user
 * does not exist within the org.
 */
async function validateUserInOrg(
  userId: string,
  organizationId: string
): Promise<void> {
  const inOrg = await withDb((db) =>
    isUserInOrganization(db, userId, organizationId)
  );
  if (!inOrg) {
    throw new Error(USER_NOT_IN_ORGANIZATION_MESSAGE);
  }
}

/**
 * Create a single artifact record within an existing transaction. Centralized
 * so the create() route AND the source-linked plan service share the same
 * artifact-shape contract (slug generation, version 1 seeding, optional
 * source link).
 */
export async function createDocumentRecord(
  tx: TransactionClient,
  organizationId: string,
  userId: string,
  rawInput: CreateDocumentInput,
  /**
   * An id the caller chose before the transaction, for a write that must name
   * the artifact before it exists (an attachment's signed storage key).
   */
  artifactId?: string
): Promise<Document | null> {
  // ISS-4397: `CreateDocumentInput.type` is the request-side superset
  // (DocumentType + the `ISSUE` alias). The HTTP path already normalizes at the
  // create validator, but this helper is also called in-code by the
  // source-linked plan service, so normalize here too — the
  // persisted `subtype`, slug prefix, and status vocabulary must key off the
  // canonical DocumentType, never the `ISSUE` alias.
  const input: CreateDocumentInput & { type: DocumentType } = {
    ...rawInput,
    type: normalizeDocumentType(rawInput.type),
  };
  // Project-bound subtypes (PRD/IMPLEMENTATION_PLAN/FEATURE) must carry a
  // project. The HTTP path enforces this in the create validator, but this
  // helper is also called directly by the source-linked plan service, which
  // builds a `CreateDocumentInput` in code —
  // where `projectId` is typed optional (FEA-4345). Guard here so a direct
  // caller that omits it for a project-bound type is rejected (null return =
  // "failed to create", the contract every caller already handles) instead of
  // silently persisting a project-less PRD. SSOT: isProjectOptionalDocumentType.
  if (!(isProjectOptionalDocumentType(input.type) || input.projectId)) {
    return null;
  }

  const isTemplate = input.type === DocumentType.Template;

  // Templates are org-level and carry no project (FEA-1749); they used to be
  // routed to a hidden sentinel Project purely to satisfy a DB CHECK that no
  // longer exists. Everything else takes the caller's projectId as given —
  // storage no longer second-guesses it. The requirement that a document create
  // names a project is owned by `documents/validators.ts`, which still enforces
  // it; re-checking here only added a silent `null` return for input the
  // validator had already rejected.
  // `undefined`, not `null`: project_id is a nullable column with no default, so
  // omitting it on create yields NULL just the same, and it keeps the existing
  // `string | undefined` contract of resolveRepositorySnapshot/splitDocumentPayload.
  const resolvedProjectId = isTemplate ? undefined : input.projectId;

  const resolvedAssigneeId = input.assigneeId ?? userId;
  await validateUserInOrg(resolvedAssigneeId, organizationId);

  if (input.approverId) {
    await validateUserInOrg(input.approverId, organizationId);
  }

  const slug = await generateArtifactSlug(organizationId, input.type);
  const { sourceId, content, repositorySelection, ...documentInput } = input;

  const resolvedSnapshot = await resolveRepositorySnapshot({
    tx,
    organizationId,
    resolvedProjectId,
    isTemplate,
    repositorySelection,
    sourceId,
  });

  const { artifact: artifactData, detail: detailData } = splitDocumentPayload({
    ...documentInput,
    slug,
    latestVersion: 1,
    projectId: resolvedProjectId,
    assigneeId: resolvedAssigneeId,
    // Subtype-aware default: human-created Features default to BACKLOG,
    // Documents to DRAFT (PRD-495). Agent generators pass an explicit TRIAGE
    // status so they override this default.
    status:
      documentInput.status ?? fallbackStatusForSubtype(documentInput.type),
    repositorySnapshot: resolvedSnapshot,
  });

  // Per PRD-421: new root documents land at the bottom of the project's
  // stack rank. Two concurrent creates under READ COMMITTED can both read
  // the same MAX and write the same sortOrder; the project tree compare
  // function tiebreaks on createdAt so the visible order stays
  // deterministic, and a subsequent user move will spread the rows back
  // out. Children inherit the value; the project tree query only sorts
  // roots by sortOrder so the value is harmless on nested artifacts.
  const nextSortOrder = resolvedProjectId
    ? await computeNextSortOrder(tx, organizationId, resolvedProjectId)
    : null;

  const createdArtifact = await tx.artifact.create({
    data: {
      ...artifactData,
      ...(nextSortOrder !== null && { sortOrder: nextSortOrder }),
      ...(artifactId && { id: artifactId }),
      organizationId,
      createdById: userId,
      document: { create: detailData },
    } as Prisma.ArtifactUncheckedCreateInput,
    include: documentIncludeWithUser,
  });

  const sanitizedContent = sanitizeAndLog(content ?? null, createdArtifact.id);

  await tx.documentVersion.create({
    data: {
      documentId: createdArtifact.id,
      version: 1,
      content: sanitizedContent,
      createdById: userId,
    },
    select: { id: true },
  });

  if (sourceId) {
    const sortOrder = await nextProducesLinkSortOrder(
      tx,
      organizationId,
      sourceId
    );
    await tx.artifactLink.create({
      data: {
        organizationId,
        sourceId,
        targetId: createdArtifact.id,
        linkType: LinkType.Produces,
        sortOrder,
      },
      select: { id: true },
    });
  }

  return toDocument(createdArtifact);
}

/**
 * Resolve the `repository_snapshot` value for a new document. Precedence
 * (PLN-602):
 *   1. Client-supplied `repositorySelection` (e.g. picked in the Create
 *      modal). Stored as a `loop_selection` snapshot.
 *   2. `sourceId`-based inheritance from the parent artifact's snapshot.
 *      Empty parent snapshots fall through to project defaults so the new
 *      artifact still gets meaningful repos when possible.
 *   3. Project defaults via `loadProjectRepoDefaults`. Templates and any
 *      project with no resolved primary produce a `source: 'none'`
 *      empty snapshot.
 */
async function resolveRepositorySnapshot(opts: {
  tx: TransactionClient;
  organizationId: string;
  resolvedProjectId: string | undefined;
  isTemplate: boolean;
  repositorySelection: RepositorySelectionInput | undefined;
  sourceId: string | undefined;
}): Promise<ArtifactRepositorySnapshot> {
  const {
    tx,
    organizationId,
    resolvedProjectId,
    isTemplate,
    repositorySelection,
    sourceId,
  } = opts;

  if (repositorySelection) {
    return buildSnapshotFromRepositorySelection(repositorySelection);
  }

  if (sourceId) {
    const sourceDetail = await tx.documentDetail.findFirst({
      where: { artifactId: sourceId, artifact: { organizationId } },
      select: { repositorySnapshot: true },
    });
    const parsed = parseStoredSnapshot(sourceDetail?.repositorySnapshot);
    if (parsed && parsed.repositories.length > 0) {
      return inheritSnapshotFromParent(parsed);
    }
    // Empty parent snapshot falls through to project defaults.
  }

  if (isTemplate || !resolvedProjectId) {
    return {
      repositories: [],
      source: SnapshotSource.None,
      createdAt: new Date().toISOString(),
    };
  }

  const project = await tx.project.findFirst({
    where: { id: resolvedProjectId, organizationId },
    select: { settings: true },
  });
  if (!project) {
    return {
      repositories: [],
      source: SnapshotSource.None,
      createdAt: new Date().toISOString(),
    };
  }

  return buildSnapshotFromProjectDefaults(
    resolvedProjectId,
    organizationId,
    (project.settings ?? {}) as JsonObject
  );
}

export const documentService = {
  /**
   * Find all DOCUMENT artifacts with optional filters (org-scoped). Returns
   * each document with its project (with teams).
   */
  async findAll(
    options: DocumentListQueryOptions,
    now: Date = new Date()
  ): Promise<DocumentWithProject[]> {
    return await findAllDocuments(options, now);
  },

  /**
   * findAll plus batch-loaded custom field values for each document. Shared
   * by GET /documents and GET /projects/:id/tree?include=documents so both
   * surfaces return the identical document shape (PLN-874).
   */
  async findAllWithCustomFields(
    options: DocumentListQueryOptions,
    now: Date = new Date()
  ): Promise<DocumentWithProject[]> {
    return await findAllDocumentsWithCustomFields(options, now);
  },

  /** Find a DOCUMENT artifact by id (org-scoped) with project context. */
  async findById(
    id: string,
    organizationId: string
  ): Promise<DocumentWithProject | null> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
        include: documentIncludeWithContext,
      })
    );

    if (artifact?.type !== ArtifactType.Document) {
      return null;
    }

    return toDocumentWithProject(artifact);
  },

  /** Find a DOCUMENT artifact by slug (org-scoped) with project context. */
  async findBySlug(
    slug: string,
    organizationId: string
  ): Promise<DocumentWithProject | null> {
    // FEA-4137: `ISS-###` and `FEA-###` address the same numeric identity, so a
    // by-slug lookup tries every alias slug — an `ISS-###` URL still resolves an
    // existing `FEA-###` row (and vice-versa). Only one row exists per numeric
    // identity, so findFirst over the alias set is unambiguous.
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: { organizationId, slug: { in: expandSlugAliases(slug) } },
        include: documentIncludeWithContext,
      })
    );

    if (artifact?.type !== ArtifactType.Document) {
      return null;
    }

    return toDocumentWithProject(artifact);
  },

  /**
   * The id and stored slug of the DOCUMENT {@link findBySlug} resolves,
   * without its include graph.
   */
  async findCanonicalSlugAndId(
    slug: string,
    organizationId: string
  ): Promise<{ id: string; slug: string } | null> {
    const artifact = await withDb((db) =>
      db.artifact.findFirst({
        where: { organizationId, slug: { in: expandSlugAliases(slug) } },
        select: { id: true, slug: true, type: true },
      })
    );
    return artifact?.type === ArtifactType.Document && artifact.slug !== null
      ? { id: artifact.id, slug: artifact.slug }
      : null;
  },

  /** Find a DOCUMENT artifact by id (org-scoped) without related context. */
  async findByIdSimple(
    id: string,
    organizationId: string
  ): Promise<Document | null> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
        include: documentIncludeWithUser,
      })
    );
    if (artifact?.type !== ArtifactType.Document) {
      return null;
    }
    return toDocument(artifact);
  },

  /** Return the org-scoped DOCUMENT slug for context-pack metadata lookups. */
  async findSlugById(
    id: string,
    organizationId: string
  ): Promise<string | null> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: documentWhere({ id, organizationId }),
        select: { slug: true },
      })
    );
    return artifact?.slug ?? null;
  },

  /**
   * Create a new DOCUMENT artifact. Handles initial version seeding and
   * Liveblocks room creation.
   */
  async create(
    organizationId: string,
    userId: string,
    input: CreateDocumentInput,
    /** {@link RecordCreatedArtifact} (ISS-10993). */
    recordCreated?: RecordCreatedArtifact
  ): Promise<Document | null> {
    return await createDocumentWithReceipt(
      organizationId,
      userId,
      input,
      recordCreated
    );
  },

  /**
   * Create a document, store inline image attachments for it, and replace
   * placeholders in the seeded version-1 content.
   */
  async createWithInlineImages(
    organizationId: string,
    userId: string,
    input: CreateDocumentInput,
    inlineImages: CreateDocumentInlineImageInput[],
    /** {@link RecordCreatedArtifact} (ISS-10993). */
    recordCreated?: RecordCreatedArtifact
  ): Promise<CreateDocumentWithInlineImagesResult> {
    const placeholderValidation = validateInlineImagesBeforeSideEffects(
      input.content,
      inlineImages,
      createDocumentInlineImageErrorCodes,
      MAX_CREATE_DOCUMENT_INLINE_EXPANDED_CONTENT_CHARS
    );
    if (!placeholderValidation.ok) {
      return Result.err(placeholderValidation.error);
    }

    const createdDocument = await documentService.create(
      organizationId,
      userId,
      input,
      recordCreated
    );
    if (!createdDocument) {
      return Result.err({
        code: CreateDocumentErrorCode.DocumentCreateFailed,
      });
    }

    const createdImages: CreatedDocumentVersionInlineImage[] = [];
    for (const inlineImage of inlineImages) {
      const imageResult = await createInlineImageAttachmentSafely({
        documentId: createdDocument.id,
        failureReason: CreateDocumentErrorCode.InlineImageCreationFailed,
        inlineImage,
        logScope: "[document-service]",
        organizationId,
        userId,
      });
      if (!imageResult.ok) {
        const cleanup = await cleanupFailedInlineImageDocument({
          createdDocument,
          createdImages,
          deleteDocument: deleteCreatedInlineImageDocument,
          organizationId,
          reason: CreateDocumentErrorCode.InlineImageCreationFailed,
          userId,
        });
        return Result.err({
          cleanupFailed: cleanup.failed,
          cleanupFailedCount: cleanup.failedAttachmentCount,
          code: CreateDocumentErrorCode.InlineImageCreationFailed,
          documentCleanupFailed: cleanup.documentFailed,
          documentCleanupSkipped: cleanup.documentSkipped,
          inlineImageError: imageResult.error,
          placeholder: inlineImage.placeholder,
        });
      }

      createdImages.push(
        buildCreatedInlineImage(imageResult.value, inlineImage)
      );
    }

    const versionContent = replaceInlineImagePlaceholders(
      input.content,
      createdImages
    );
    const persistedVersionContent = await updateInitialDocumentVersionContent(
      createdDocument.id,
      organizationId,
      versionContent
    );
    if (persistedVersionContent === null) {
      const cleanup = await cleanupFailedInlineImageDocument({
        createdDocument,
        createdImages,
        deleteDocument: deleteCreatedInlineImageDocument,
        organizationId,
        reason: CreateDocumentErrorCode.VersionContentUpdateFailed,
        userId,
      });
      return Result.err({
        cleanupFailed: cleanup.failed,
        cleanupFailedCount: cleanup.failedAttachmentCount,
        code: CreateDocumentErrorCode.VersionContentUpdateFailed,
        documentCleanupFailed: cleanup.documentFailed,
        documentCleanupSkipped: cleanup.documentSkipped,
      });
    }

    // `create()` above already indexed the RAW seeded content, which still holds
    // the unresolved `{{image:…}}` placeholders. Now that placeholders are
    // replaced and the final v1 content is persisted, re-index with the resolved
    // body so the searchable text never keeps dangling placeholders. Best-effort,
    // post-commit, fail-open (same helper as create/update).
    indexDocumentProjection(createdDocument, persistedVersionContent);

    return Result.ok({
      document: createdDocument,
      inlineImages: createdImages.map(toCreatedDocumentInlineImage),
      versionContent: persistedVersionContent,
    });
  },

  /** Update an existing DOCUMENT artifact (org-scoped). */
  async update(
    id: string,
    organizationId: string,
    input: Omit<UpdateDocumentInput, "id">
  ): Promise<Document> {
    if (input.assigneeId) {
      await validateUserInOrg(input.assigneeId, organizationId);
    }
    if (input.approverId) {
      await validateUserInOrg(input.approverId, organizationId);
    }
    const { projectId } = input;
    if (projectId) {
      const project = await withDb((db) =>
        db.project.findUnique({
          where: { id: projectId, organizationId },
          select: { id: true },
        })
      );
      if (!project) {
        throw new Error(
          "Invalid project ID: project not found in this organization"
        );
      }
    }

    // Documents and Features carry disjoint status vocabularies on the same
    // freeform column (PRD-495). The update validator accepts the union; the
    // valid subset is enforced here against the target artifact's subtype.
    if (input.status !== undefined) {
      const existing = await withDb((db) =>
        db.artifact.findUnique({
          where: { id, organizationId },
          select: { subtype: true },
        })
      );
      if (!existing) {
        throw new Error("Document not found in this organization");
      }
      if (!statusOptionsForSubtype(existing.subtype).includes(input.status)) {
        throw new Error(
          `Status "${input.status}" is not valid for this ${existing.subtype ?? "document"}`
        );
      }
    }

    const { artifact: artifactData, detail: detailData } =
      splitDocumentPayload(input);
    const updated = await withDb((db) =>
      db.artifact.update({
        where: { id, organizationId },
        data: {
          ...artifactData,
          ...(Object.keys(detailData).length > 0 && {
            document: { update: detailData },
          }),
        },
        include: documentIncludeWithUser,
      })
    );
    const document = toDocument(updated);
    // FEA-3863 / Phase-2: best-effort, post-commit, fail-open search projection
    // upsert. No fresh content on the metadata-update path, so the body is read
    // from the latest version inside the helper (below) rather than clobbered.
    indexDocumentProjection(document, undefined);
    return document;
  },

  /**
   * Delete a DOCUMENT artifact, its audit entry and its Liveblocks room. The
   * implementation, and the same-transaction audit contract that makes a delete
   * and its only surviving record atomic, live in `document-delete-service.ts`.
   */
  delete: documentDeleteService.delete,

  /**
   * Reorder every document in a project by array position. The implementation
   * lives in `document-move-service.ts`, beside the single-item move built on
   * it — rewriting a project's ordering is a separate responsibility from
   * writing a document.
   */
  reorder: documentMoveService.reorder,

  /**
   * Move one root DOCUMENT artifact to a new position in its project's stack
   * rank, including the optional expected-order precondition (ISS-8728). The
   * implementation, and the transaction that makes the precondition check and
   * the write observe one snapshot, live in `document-move-service.ts`.
   */
  moveArtifact: documentMoveService.moveArtifact,

  /**
   * Batch-fetch document metadata by slug (org-scoped). Returns a map of slug
   * → DocumentMeta for all slugs found. Slugs not found are omitted.
   */
  batchFetchDocumentMeta(
    organizationId: string,
    slugs: string[]
  ): Promise<DocumentMetaMap> {
    if (slugs.length === 0) {
      return Promise.resolve({});
    }
    return withDb(async (db) => {
      if (slugs.length > BATCH_META_MAX_SLUGS) {
        throw new Error(
          `batchFetchDocumentMeta: too many slugs (max ${BATCH_META_MAX_SLUGS})`
        );
      }
      const artifacts = await db.artifact.findMany({
        where: documentWhere({ organizationId, slug: { in: slugs } }),
        select: { slug: true, name: true, subtype: true },
      });

      const validDocumentTypes = new Set<string>(Object.values(DocumentType));
      return Object.fromEntries(
        artifacts
          .filter((a): a is typeof a & { slug: string } => a.slug !== null)
          .map((a): [string, DocumentMeta] => {
            const type =
              a.subtype !== null && validDocumentTypes.has(a.subtype)
                ? (a.subtype as DocumentType)
                : undefined;
            return [
              a.slug,
              { title: a.name, ...(type !== undefined && { type }) },
            ];
          })
      );
    });
  },

  /**
   * Delete multiple documents and their Liveblocks rooms. Returns the IDs that
   * were successfully deleted and any that were not found.
   *
   * Each deleted document gets its OWN `document.deleted` audit entry, enqueued
   * in the same transaction as the `deleteMany` (ISS-10029): these deletes are
   * as hard as the single-document path, so a batch cannot commit without the
   * entries that are all that outlive its rows. `recordDeleted` runs on that
   * same transaction with the ids it deleted (ISS-12552).
   */
  async batchDelete(
    documentIds: string[],
    organizationId: string,
    actor: AuditActor,
    transactionId: string,
    recordDeleted?: RecordWriteInTransaction<{ deletedIds: string[] }>
  ): Promise<{ deletedIds: string[]; failedIds: string[] }> {
    const uniqueIds = [...new Set(documentIds)];

    const foundArtifacts = await withDb.tx(async (tx) => {
      const artifacts = await tx.artifact.findMany({
        where: documentWhere({ id: { in: uniqueIds }, organizationId }),
        select: { id: true, ...DELETED_DOCUMENT_SELECT },
      });

      const foundIds = artifacts.map((a: { id: string }) => a.id);

      await tx.artifact.deleteMany({
        where: { id: { in: foundIds }, organizationId },
      });

      // One bulk insert, and it throws: the rows above are gone either way, so
      // a batch whose audit entries cannot be written must roll back with them.
      await documentDeleteService.enqueueBatchAuditEvents(
        organizationId,
        actor,
        artifacts,
        transactionId
      );
      await recordDeleted?.(tx, { deletedIds: foundIds });

      return artifacts;
    });

    const foundIds = foundArtifacts.map((a) => a.id);
    const foundIdSet = new Set(foundIds);
    const missingIds = uniqueIds.filter((id) => !foundIdSet.has(id));

    // Clean up Liveblocks rooms after the transaction commits
    const deletedSlugs = foundArtifacts
      .map((a) => a.slug)
      .filter((slug): slug is string => slug !== null);
    await Promise.all(
      deletedSlugs.map((slug) => deleteDocumentRoom(organizationId, slug))
    );

    return { deletedIds: foundIds, failedIds: missingIds };
  },
};

export type CreateDocumentError = {
  code: CreateDocumentErrorCodeType;
  placeholder?: string;
  inlineImageError?: CreateInlineImageAttachmentError;
  cleanupFailed?: boolean;
  cleanupFailedCount?: number;
  documentCleanupFailed?: boolean;
  documentCleanupSkipped?: boolean;
  estimatedContentChars?: number;
  maxContentChars?: number;
  requestBodyBytes?: number;
  maxBytes?: number;
};

export type CreateDocumentWithInlineImagesSuccess = {
  document: Document;
  versionContent: string;
  inlineImages: CreatedDocumentInlineImage[];
};

type CreateDocumentWithInlineImagesResult = ServiceResult<
  CreateDocumentWithInlineImagesSuccess,
  CreateDocumentError
>;

/**
 * Delete a partially-created inline-image document via the service, reporting
 * success as a boolean (no throw). Passed to `cleanupFailedInlineImageDocument`
 * so the extracted helper stays independent of the `documentService`
 * composition root.
 */
async function deleteCreatedInlineImageDocument(
  documentId: string,
  organizationId: string
): Promise<boolean> {
  try {
    // An internal compensating delete of an artifact this same call just
    // created, so the ledger attributes it to `system` rather than to the user
    // whose create failed part-way.
    await documentService.delete(
      documentId,
      organizationId,
      systemAuditActor()
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * FEA-3863 / Phase-2: index a document into the search projection. `body` is the
 * document's content: the caller passes it on create (the seeded v1 content);
 * on the metadata-update path it is `undefined`, so the latest version content
 * is read from the source of truth and passed through — this keeps the
 * searchable body populated instead of clobbering it to null on a title-only
 * edit. Best-effort throughout: the projection upsert already runs post-commit
 * via `waitUntil` and swallows errors, and the content read here is scheduled
 * the same way so a failed read never affects the user's write.
 *
 * CALLER CONTRACT (ISS-10993): call this with NO transaction open. The read and
 * the projection upsert both start eagerly, before `waitUntil` sees them, and
 * `withDb` joins an ambient transaction — so inside one they issue on the
 * caller's transaction client, where a projection failure aborts the caller's
 * write and a statement queued past the commit is swallowed against a closed
 * transaction. Nothing enforces this; `PUT /documents/[id]` is the caller that
 * has to hold it, and it indexes after its own `withDb.tx` resolves.
 */
export function indexDocumentProjection(
  document: Document,
  body: string | null | undefined
): void {
  const project = (resolvedBody: string | null) =>
    documentProjection({
      id: document.id,
      organizationId: document.organizationId,
      title: document.title,
      slug: document.slug,
      entitySubtype: document.type,
      body: resolvedBody,
      projectId: document.projectId,
      assigneeId: document.assigneeId,
      status: document.status,
      priority: document.priority,
      updatedAt: document.updatedAt,
    });

  if (body !== undefined) {
    searchIndexService.indexAfterCommit(project(body));
    return;
  }

  // No fresh content on hand — resolve the latest version body first, then
  // index. `indexAfterCommit`'s own `waitUntil`/swallow covers the upsert; wrap
  // the read so a lookup failure degrades to a metadata-only (null body) index
  // rather than dropping the projection write entirely.
  waitUntil(
    latestDocumentVersionContent(document.id, document.organizationId)
      .catch(() => null)
      .then((resolvedBody) => {
        searchIndexService.indexAfterCommit(project(resolvedBody));
      })
  );
}

/**
 * Read the latest version's content for a document (org-scoped), or null when
 * absent. Used only by the best-effort search indexer, so a null (missing
 * detail/version) is a safe metadata-only fallback, not an error.
 */
function latestDocumentVersionContent(
  documentId: string,
  organizationId: string
): Promise<string | null> {
  return withDb(async (db) => {
    const latest = await db.documentVersion.findFirst({
      where: {
        documentId,
        documentDetail: { artifact: { organizationId } },
      },
      orderBy: { version: "desc" },
      select: { content: true },
    });
    return latest?.content ?? null;
  });
}

/**
 * The create itself, as a module function rather than a member, so
 * `createWithInlineImages` does not have to reference `documentService` from
 * inside its own initializer.
 *
 * ISS-10993: the artifact row and its creation receipt are written on ONE
 * transaction, so a receipt that cannot be persisted refuses the create instead
 * of leaving the feed with no row to start from. The Liveblocks room and the
 * search projection stay OUTSIDE it — both are post-commit and neither should
 * hold a pooled connection across a network call.
 */
async function createDocumentWithReceipt(
  organizationId: string,
  userId: string,
  input: CreateDocumentInput,
  recordCreated?: RecordCreatedArtifact
): Promise<Document | null> {
  // Kept, and more honest now that the sentinel is gone: templates really are
  // org-level, so being handed a project for one is a caller error.
  if (input.type === DocumentType.Template && input.projectId) {
    throw new Error(
      "Templates are organization-level artifacts and cannot be associated with a project"
    );
  }
  // FEA-1749: the converse guard ("artifacts except templates must have a
  // project") is deliberately NOT here. `documents/validators.ts` requires
  // projectId on every document create and still does — this was a second,
  // redundant enforcement of a rule the entry point already owns, and the
  // storage layer holding an opinion about it is what blocked unparented
  // BRANCH/SESSION artifacts from ever existing.

  const createdDocument = await withDb.tx(async (tx) => {
    const created = await createDocumentRecord(
      tx,
      organizationId,
      userId,
      input
    );
    if (created) {
      await recordCreated?.(tx, created);
    }
    return created;
  });

  if (createdDocument) {
    await publishCreatedDocument(createdDocument, input.content ?? null);
  }

  return createdDocument;
}

/**
 * The receipt a caller writes for a newly created artifact, on the create's OWN
 * transaction (ISS-10993), so a receipt that cannot be persisted refuses the
 * create instead of leaving the activity feed with no row to start from.
 *
 * A CALLBACK rather than an actor the store captures for itself: the store has
 * no business knowing what a receipt is, and `POST /documents` is the only
 * caller that owns one. Absent — every other caller — nothing is written, which
 * is what those callers have always done.
 */
export type RecordCreatedArtifact = (
  tx: TransactionClient,
  created: Document
) => Promise<void>;

/**
 * The post-commit half of a document create: its Liveblocks room and its
 * search projection. Neither belongs inside the create's transaction, since
 * both are network calls.
 */
export async function publishCreatedDocument(
  document: Document,
  content: string | null
): Promise<void> {
  await createDocumentRoom(document);
  // FEA-3863 / Phase-2 (parent FEA-3800): best-effort, post-commit,
  // fail-open search projection upsert. Never blocks or fails the create.
  // Index the seeded v1 content as the searchable body and carry slug + type
  // for the routable deep link.
  indexDocumentProjection(document, content);
}
