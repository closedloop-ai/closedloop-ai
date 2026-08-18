import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { JsonObject } from "@repo/api/src/types/common";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
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
  type FindDocumentsOptions,
  fallbackStatusForSubtype,
  type GenerationStatus,
  isProjectOptionalDocumentType,
  MAX_CREATE_DOCUMENT_INLINE_EXPANDED_CONTENT_CHARS,
  normalizeDocumentType,
  type RepositorySelectionInput,
  SnapshotSource,
  statusOptionsForSubtype,
  type UpdateDocumentInput,
} from "@repo/api/src/types/document";
import type { CreatedDocumentVersionInlineImage } from "@repo/api/src/types/document-version";
import type { MoveArtifactRequest } from "@repo/api/src/types/project-artifact-move";
import {
  Result,
  type Result as ServiceResult,
  Status,
} from "@repo/api/src/types/result";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { expandSlugAliases } from "@repo/api/src/types/slug-prefix";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { waitUntil } from "@vercel/functions";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import {
  computeNextSortOrder,
  type MoveArtifactError,
  resolveInsertIndex,
  STACK_RANK_GAP,
} from "@/app/documents/document-sort-order";
import {
  documentProjection,
  searchIndexService,
} from "@/app/search/search-index-service";
import { mapTagRelations } from "@/app/tags/service";
import { documentWhere } from "@/lib/artifact-adapters";
import { generateArtifactSlug } from "@/lib/slug-generator";
import { displayUserName } from "@/lib/user-display-name";
import {
  cleanupFailedInlineImageDocument,
  createDocumentInlineImageErrorCodes,
  toCreatedDocumentInlineImage,
  updateInitialDocumentVersionContent,
} from "./create-document-inline-image-helpers";
import {
  buildCreatedInlineImage,
  createInlineImageAttachmentSafely,
  replaceInlineImagePlaceholders,
  validateInlineImagesBeforeSideEffects,
} from "./document-inline-image-helpers";
import {
  attachCustomFieldValues,
  buildDocumentListWhere,
  resolveDocumentListSkip,
  resolveDocumentListTake,
} from "./document-list-query";
import {
  documentIncludeWithContext,
  documentIncludeWithUser,
  type RawDocumentWithContext,
  splitDocumentPayload,
  toDocument,
} from "./document-utils";
import {
  mergeLoopStatuses,
  suppressDismissedFailuresForDocumentMap,
} from "./generation-status-helpers";
import type { CreateInlineImageAttachmentError } from "./inline-image-attachment-contract";
import {
  buildSnapshotFromLoopSelection,
  buildSnapshotFromProjectDefaults,
  inheritSnapshotFromParent,
  parseStoredSnapshot,
} from "./repository-snapshot-helpers";
import { createDocumentRoom, deleteDocumentRoom } from "./room-utils";
import { sanitizeAndLog } from "./sanitize-content";

/**
 * Document general/CRUD service. Owns reads, writes, deletes, listing,
 * template handling, related-document graph traversal, batch utilities, and
 * the helpers that the generation/execution flows compose with.
 *
 * Per FEA-680: this is the entity-level CRUD module for DOCUMENT artifacts —
 * named after the entity, not after the responsibility. Generation,
 * execution, evaluation, performance, versioning, and merge live in their
 * own sibling files and import from here.
 */

/**
 * Validate that a user belongs to the given organization. Throws if the user
 * does not exist within the org.
 */
async function validateUserInOrg(
  userId: string,
  organizationId: string
): Promise<void> {
  const user = await withDb((db) =>
    db.user.findFirst({
      where: { id: userId, organizationId },
      select: { id: true },
    })
  );
  if (!user) {
    throw new Error("Invalid user ID: user not found in this organization");
  }
}

/**
 * Look up the user's name and email for git commit attribution. Used to set
 * committer identity on bot commits so Vercel can match the author to a team
 * member and trigger preview deploys.
 *
 * Exported for use by generation/execution flows when triggering workflows.
 */
export async function getCommitterInfo(
  userId: string
): Promise<{ committerName: string; committerEmail: string } | undefined> {
  const user = await withDb((db) =>
    db.user.findUnique({
      where: { id: userId },
      select: { email: true, firstName: true, lastName: true },
    })
  );
  if (!user?.email) {
    return undefined;
  }
  return {
    committerName: displayUserName({ ...user, email: user.email }),
    committerEmail: user.email,
  };
}

/**
 * Create a single artifact record within an existing transaction. Centralized
 * so the create() route AND the start-plan-loop-from-local helper share the
 * same artifact-shape contract (slug generation, version 1 seeding, optional
 * source link).
 *
 * Exported for use by `documentExecutionService.startPlanLoopFromLocal`.
 */
export async function createDocumentRecord(
  tx: TransactionClient,
  organizationId: string,
  userId: string,
  rawInput: CreateDocumentInput
): Promise<Document | null> {
  // ISS-4397: `CreateDocumentInput.type` is the request-side superset
  // (DocumentType + the `ISSUE` alias). The HTTP path already normalizes at the
  // create validator, but this helper is also called in-code by generation /
  // plan-from-local / context-attachment services, so normalize here too — the
  // persisted `subtype`, slug prefix, and status vocabulary must key off the
  // canonical DocumentType, never the `ISSUE` alias.
  const input: CreateDocumentInput & { type: DocumentType } = {
    ...rawInput,
    type: normalizeDocumentType(rawInput.type),
  };
  // Project-bound subtypes (PRD/IMPLEMENTATION_PLAN/FEATURE) must carry a
  // project. The HTTP path enforces this in the create validator, but this
  // helper is also called directly by generate-prd-from-doc / plan-from-local /
  // context-attachment services that build a `CreateDocumentInput` in code —
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
    await tx.artifactLink.create({
      data: {
        organizationId,
        sourceId,
        targetId: createdArtifact.id,
        linkType: LinkType.Produces,
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
    return buildSnapshotFromLoopSelection(repositorySelection);
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

/** Transform Artifact + detail into the DocumentWithProject wire shape. */
function toDocumentWithProject(
  artifact: RawDocumentWithContext,
  maps?: {
    generationStatusMap?: Map<string, GenerationStatus>;
  }
): DocumentWithProject {
  const generationStatus = maps?.generationStatusMap?.get(artifact.id);
  const base = toDocument(artifact);

  return {
    ...base,
    project: artifact.project
      ? {
          id: artifact.project.id,
          name: artifact.project.name,
          teams: artifact.project.teams.map(
            (pt: { team: { id: string; name: string } }) => pt.team
          ),
        }
      : null,
    tags: mapTagRelations(artifact.tagArtifacts ?? []),
    ...(generationStatus && { generationStatus }),
  };
}

export const documentService = {
  /**
   * Find all DOCUMENT artifacts with optional filters (org-scoped). Returns
   * each document with its project (with teams), and generation status
   * (resolved from Loop records, with dismissed failures suppressed).
   */
  async findAll(
    options: FindDocumentsOptions & { organizationId: string },
    now: Date = new Date()
  ): Promise<DocumentWithProject[]> {
    // FEA-4373: the list is unbounded by default — every matching artifact is
    // loaded — which the shared Documents index, plan/document pickers, and
    // version-skewed API clients all still depend on to show and select older
    // artifacts. Only a caller that explicitly asks to page (My Tasks, whose
    // board renders one row/card per artifact and could crash on a very large
    // assigned set) opts into the bound by passing `limit`; when it is omitted
    // the query stays unbounded and this endpoint's default contract is
    // unchanged. When a caller does page, the value is clamped to
    // [1, DOCUMENT_LIST_MAX_LIMIT] (the validator clamps client input; this is
    // defense in depth for direct service callers) and `offset` to
    // [0, DOCUMENT_LIST_MAX_OFFSET]. Offset without a limit is meaningless, so
    // it applies only alongside a limit.
    const take = resolveDocumentListTake(options.limit);
    const skip = resolveDocumentListSkip(take, options.offset);

    const artifacts = await withDb((db) =>
      db.artifact.findMany({
        // ISS-4576: the same predicate builder the honest-total `count` uses, so
        // the page and its total always describe one population.
        where: buildDocumentListWhere(options, now),
        include: documentIncludeWithContext,
        // Stable secondary sort on id so `createdAt` ties order deterministically
        // across pages (two rows sharing a millisecond can't swap between pages).
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        skip,
      })
    );

    const documentIds = artifacts.map((a) => a.id);
    const generationStatusMap = new Map<string, GenerationStatus>();

    await mergeLoopStatuses(documentIds, generationStatusMap);

    await suppressDismissedFailuresForDocumentMap(
      documentIds,
      generationStatusMap
    );

    return artifacts.map((a: RawDocumentWithContext) =>
      toDocumentWithProject(a, { generationStatusMap })
    );
  },

  /**
   * findAll plus batch-loaded custom field values for each document. Shared
   * by GET /documents and GET /projects/:id/tree?include=documents so both
   * surfaces return the identical document shape (PLN-874).
   */
  async findAllWithCustomFields(
    options: FindDocumentsOptions & { organizationId: string },
    now: Date = new Date()
  ): Promise<DocumentWithProject[]> {
    const documents = await documentService.findAll(options, now);
    if (documents.length === 0) {
      return documents;
    }

    const allValues = await customFieldValuesService.getValuesForEntity(
      CustomFieldEntityType.Document,
      documents.map((d) => d.id),
      options.organizationId
    );

    return attachCustomFieldValues(documents, allValues);
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

    return toDocumentWithProject(artifact, {});
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

    return toDocumentWithProject(artifact, {});
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
    input: CreateDocumentInput
  ): Promise<Document | null> {
    const isTemplate = input.type === DocumentType.Template;

    // Kept, and more honest now that the sentinel is gone: templates really are
    // org-level, so being handed a project for one is a caller error.
    if (isTemplate && input.projectId) {
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

    const createdDocument = await withDb.tx((tx) =>
      createDocumentRecord(tx, organizationId, userId, input)
    );

    if (createdDocument) {
      await createDocumentRoom(createdDocument);
      // FEA-3863 / Phase-2 (parent FEA-3800): best-effort, post-commit,
      // fail-open search projection upsert. Never blocks or fails the create.
      // Index the seeded v1 content as the searchable body and carry slug + type
      // for the routable deep link.
      indexDocumentProjection(createdDocument, input.content ?? null);
    }

    return createdDocument;
  },

  /**
   * Create a document, store inline image attachments for it, and replace
   * placeholders in the seeded version-1 content.
   */
  async createWithInlineImages(
    organizationId: string,
    userId: string,
    input: CreateDocumentInput,
    inlineImages: CreateDocumentInlineImageInput[]
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
      input
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
    if (input.projectId) {
      const project = await withDb((db) =>
        db.project.findUnique({
          where: { id: input.projectId, organizationId },
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
   * Delete a DOCUMENT artifact and its Liveblocks room.
   * ArtifactLink rows cascade via FK ON DELETE CASCADE; Loops are preserved
   * (onDelete: SetNull) to retain execution history.
   */
  async delete(id: string, organizationId: string): Promise<void> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
        select: { slug: true, organizationId: true, type: true },
      })
    );

    if (artifact?.type !== ArtifactType.Document) {
      return;
    }

    await withDb((db) => db.artifact.delete({ where: { id, organizationId } }));

    // FEA-3863: best-effort, post-commit, fail-open search projection removal.
    searchIndexService.removeAfterCommit({
      organizationId,
      entityType: SearchEntityType.Document,
      entityId: id,
    });

    if (artifact.slug) {
      await deleteDocumentRoom(organizationId, artifact.slug);
    }
  },

  /**
   * Reorder documents in a project by setting sortOrder values atomically.
   * Validates that every documentId belongs to the supplied project AND the
   * caller's organization.
   *
   * Performance: a single `UPDATE … FROM (VALUES …)` statement updates every
   * row in one Postgres round-trip regardless of input size, instead of one
   * round-trip per row. The validation `findMany` adds one more query for a
   * total of 2 statements per call.
   *
   * Caller assigns sortOrder by array position: `documentIds[i]` → sortOrder
   * = `i * STACK_RANK_GAP`. The caller is responsible for choosing the gap
   * strategy (full reindex vs. affected-window-only). For single-item moves,
   * prefer `moveArtifact` which computes a minimal affected window internally.
   */
  reorder(
    projectId: string,
    documentIds: string[],
    organizationId: string
  ): Promise<string[]> {
    if (documentIds.length === 0) {
      return Promise.resolve([]);
    }

    const uniqueIds = [...new Set(documentIds)];

    return withDb.tx(async (tx) => {
      const artifacts = await tx.artifact.findMany({
        where: documentWhere({
          id: { in: uniqueIds },
          projectId,
          organizationId,
        }),
        select: { id: true },
      });

      if (artifacts.length !== uniqueIds.length) {
        const foundIds = new Set(artifacts.map((a: { id: string }) => a.id));
        const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
        throw new Error(
          `Invalid artifact IDs for project ${projectId}: ${missingIds.join(", ")} not found in organization`
        );
      }

      const valueRows = uniqueIds.map(
        (id, index) => Prisma.sql`(${id}::uuid, ${index * STACK_RANK_GAP}::int)`
      );
      await tx.$executeRaw(Prisma.sql`
        UPDATE "artifacts"
        SET "sort_order" = data.new_order
        FROM (VALUES ${Prisma.join(valueRows)}) AS data(id, new_order)
        WHERE "artifacts"."id" = data.id
          AND "artifacts"."organization_id" = ${organizationId}::uuid
          AND "artifacts"."project_id" = ${projectId}::uuid
          AND "artifacts"."type" = ${ArtifactType.Document}::"ArtifactType"
      `);

      return uniqueIds;
    });
  },

  /**
   * Move one root DOCUMENT artifact to a new position in its project's stack
   * rank. Single-item primitive that backs drag-drop, keyboard ⌘↑/⌘↓, and the
   * row-menu "Move to top" / "Move to bottom" actions in the project page
   * (PRD-421).
   *
   * Implementation: fetches the current project ordering, splices the moved
   * id into the requested slot, and delegates to `reorder` which rewrites
   * sortOrder for every row of the project in a single SQL statement. The
   * gap-based midpoint optimisation that would touch only O(window) rows is
   * deferred — the simpler full-project reindex is correct, easy to test, and
   * runs in a single `UPDATE … FROM (VALUES …)` round-trip (FEA-821), which
   * stays well under the 250ms p95 target even for PRO-16's 834 artifacts.
   *
   * Returns `Result.err` for client-error paths the route maps to 4xx (per
   * apps/api/AGENTS.md "Errors as values"):
   *  - `Status.NotFound` — `artifactId` not in `projectId` OR
   *    `referenceArtifactId` not in the same project. A caller with a stale
   *    id should not see a 500.
   *  - `Status.BadRequest` — `referenceArtifactId` equals `artifactId`
   *    (ambiguous), or `Before`/`After` is missing `referenceArtifactId`
   *    (the Zod validator already catches the latter at the boundary; the
   *    service still guards defensively).
   */
  moveArtifact(
    projectId: string,
    organizationId: string,
    input: MoveArtifactRequest
  ): Promise<Result<{ newSortOrder: number }, MoveArtifactError>> {
    return withDb.tx(async (tx) => {
      const orderedRoots = await tx.artifact.findMany({
        where: documentWhere({ projectId, organizationId }),
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
        select: { id: true },
      });
      const ids = orderedRoots.map((row) => row.id);

      if (!ids.includes(input.artifactId)) {
        return Result.err({
          status: Status.NotFound,
          message: `Artifact ${input.artifactId} not found in project ${projectId}`,
        });
      }
      const indexResult = resolveInsertIndex(ids, input, projectId);
      if (!indexResult.ok) {
        return indexResult;
      }
      const insertIndex = indexResult.value;

      const withoutTarget = ids.filter((id) => id !== input.artifactId);
      const newOrder = [
        ...withoutTarget.slice(0, insertIndex),
        input.artifactId,
        ...withoutTarget.slice(insertIndex),
      ];

      // Delegate to the batch reorder. Inner withDb.tx participates in this
      // transaction via AsyncLocalStorage so the read + write are atomic.
      await documentService.reorder(projectId, newOrder, organizationId);

      return Result.ok({ newSortOrder: insertIndex * STACK_RANK_GAP });
    });
  },

  /**
   * Move multiple documents to a target project atomically. Validates that
   * all artifacts and the target project belong to the user's organization.
   *
   * Per PRD-421 § Cross-project move: the source project's `sortOrder` is
   * discarded; each moved artifact is appended to the bottom of the
   * destination's stack rank in array order. New sortOrders are spaced by
   * `STACK_RANK_GAP` and start one gap above the destination's current MAX
   * (or `0` if the destination is empty).
   */
  batchMove(
    documentIds: string[],
    targetProjectId: string,
    organizationId: string
  ): Promise<string[]> {
    const uniqueIds = [...new Set(documentIds)];

    if (uniqueIds.length === 0) {
      return Promise.resolve([]);
    }

    return withDb.tx(async (tx) => {
      const targetProject = await tx.project.findFirst({
        where: { id: targetProjectId, organizationId },
        select: { id: true },
      });

      if (!targetProject) {
        throw new Error(
          "Invalid project ID: project not found in this organization"
        );
      }

      const artifacts = await tx.artifact.findMany({
        where: documentWhere({ id: { in: uniqueIds }, organizationId }),
        select: { id: true },
      });

      if (artifacts.length !== uniqueIds.length) {
        const foundIds = new Set(artifacts.map((a: { id: string }) => a.id));
        const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
        throw new Error(
          `Invalid artifact IDs: ${missingIds.join(", ")} not found in organization`
        );
      }

      const destStart = await computeNextSortOrder(
        tx,
        organizationId,
        targetProjectId
      );
      // Single `UPDATE … FROM (VALUES …)` rewrites projectId + sortOrder for
      // every moved artifact in one Postgres round-trip. Avoids the
      // interactive-transaction footgun of `Promise.all(tx.artifact.update)`,
      // which serialises on a single connection and was the pre-FEA-821
      // pattern. Same shape as `reorder` above, with an extra projectId
      // column in the VALUES tuple.
      const valueRows = uniqueIds.map(
        (id, index) =>
          Prisma.sql`(${id}::uuid, ${destStart + index * STACK_RANK_GAP}::int)`
      );
      await tx.$executeRaw(Prisma.sql`
        UPDATE "artifacts"
        SET "project_id" = ${targetProjectId}::uuid,
            "sort_order" = data.new_order
        FROM (VALUES ${Prisma.join(valueRows)}) AS data(id, new_order)
        WHERE "artifacts"."id" = data.id
          AND "artifacts"."organization_id" = ${organizationId}::uuid
          AND "artifacts"."type" = ${ArtifactType.Document}::"ArtifactType"
      `);

      return uniqueIds;
    });
  },

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
   * Update the status of multiple documents atomically. Validates that all
   * artifacts exist and belong to the organization.
   *
   * Returns both the full set of valid IDs (`updatedIds`, the caller-facing
   * response contract) and the subset whose status actually changed
   * (`changedIds`) — documents already at the requested status are excluded from
   * `changedIds`. The audit ledger emits only on real transitions, so it must
   * not treat a no-op re-apply as a `DocumentStatusChanged` event (mirrors the
   * single-document PUT route, which guards on `status !== existing.status`).
   */
  batchUpdateStatus(
    documentIds: string[],
    status: string,
    organizationId: string
  ): Promise<{ updatedIds: string[]; changedIds: string[] }> {
    const uniqueIds = [...new Set(documentIds)];

    return withDb.tx(async (tx) => {
      const artifacts = await tx.artifact.findMany({
        where: documentWhere({ id: { in: uniqueIds }, organizationId }),
        select: { id: true, subtype: true, status: true },
      });

      if (artifacts.length !== uniqueIds.length) {
        const foundIds = new Set(artifacts.map((a: { id: string }) => a.id));
        const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
        throw new Error(
          `Invalid artifact IDs: ${missingIds.join(", ")} not found in organization`
        );
      }

      // Documents and Features carry disjoint status vocabularies on the same
      // column (PRD-495). Reject the batch if the requested status is invalid
      // for any target artifact's subtype rather than persisting an
      // out-of-vocabulary value.
      const invalidIds = artifacts
        .filter((a) => !statusOptionsForSubtype(a.subtype).includes(status))
        .map((a) => a.id);
      if (invalidIds.length > 0) {
        throw new Error(
          `Status "${status}" is not valid for artifact(s): ${invalidIds.join(", ")}`
        );
      }

      // Only rows not already at the target status represent a real transition.
      const changedIds = artifacts
        .filter((a) => a.status !== status)
        .map((a) => a.id);

      if (changedIds.length > 0) {
        await tx.artifact.updateMany({
          // Scope on the DB-verified changed ids (mirrors batchDelete) rather
          // than the caller-supplied uniqueIds — self-documenting and robust if
          // the existence/validation guards above ever change. No-op rows are
          // excluded so `updateMany` touches only rows that actually change.
          where: documentWhere({ id: { in: changedIds }, organizationId }),
          data: { status },
        });
      }

      return { updatedIds: uniqueIds, changedIds };
    });
  },

  /**
   * Read the current status of a set of artifacts, org-scoped. Returns a map of
   * artifact id → status for every id that exists in the organization (ids not
   * found are simply absent from the map).
   *
   * Used by the batch-status write path to snapshot the "before" status for the
   * activity feed (FEA-3864). Best-effort: a race with a concurrent write only
   * affects the recorded before-value, never the mutation itself.
   */
  async getStatusesByIds(
    documentIds: string[],
    organizationId: string
  ): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(documentIds)];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const rows = await withDb((db) =>
      db.artifact.findMany({
        where: documentWhere({ id: { in: uniqueIds }, organizationId }),
        select: { id: true, status: true },
      })
    );
    return new Map(rows.map((row) => [row.id, row.status]));
  },

  /**
   * Delete multiple documents and their Liveblocks rooms. Returns the IDs that
   * were successfully deleted and any that were not found.
   */
  async batchDelete(
    documentIds: string[],
    organizationId: string
  ): Promise<{ deletedIds: string[]; failedIds: string[] }> {
    const uniqueIds = [...new Set(documentIds)];

    const foundArtifacts = await withDb.tx(async (tx) => {
      const artifacts = await tx.artifact.findMany({
        where: documentWhere({ id: { in: uniqueIds }, organizationId }),
        select: { id: true, slug: true },
      });

      const foundIds = artifacts.map((a: { id: string }) => a.id);

      await tx.artifact.deleteMany({
        where: { id: { in: foundIds }, organizationId },
      });

      return artifacts;
    });

    const foundIds = foundArtifacts.map(
      (a: { id: string; slug: string | null }) => a.id
    );
    const foundIdSet = new Set(foundIds);
    const missingIds = uniqueIds.filter((id) => !foundIdSet.has(id));

    // Clean up Liveblocks rooms after the transaction commits
    await Promise.all(
      foundArtifacts
        .filter(
          (a: {
            id: string;
            slug: string | null;
          }): a is { id: string; slug: string } => a.slug !== null
        )
        .map((a) => deleteDocumentRoom(organizationId, a.slug))
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
    await documentService.delete(documentId, organizationId);
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
