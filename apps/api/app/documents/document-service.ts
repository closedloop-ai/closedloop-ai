import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { JsonObject } from "@repo/api/src/types/common";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import {
  type ArtifactRepositorySnapshot,
  BATCH_META_MAX_SLUGS,
  type CreateDocumentInput,
  type Document,
  type DocumentMeta,
  type DocumentMetaMap,
  DocumentStatus,
  DocumentType,
  type DocumentWithProject,
  type FindDocumentsOptions,
  type GenerationStatus,
  type RepositorySelectionInput,
  SnapshotSource,
  type UpdateDocumentInput,
} from "@repo/api/src/types/document";
import {
  type MoveArtifactRequest,
  MovePosition,
} from "@repo/api/src/types/project-artifact-move";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import { mapTagRelations } from "@/app/tags/service";
import { documentWhere } from "@/lib/artifact-adapters";
import { generateArtifactSlug } from "@/lib/slug-generator";
import { resolveTemplatesSentinelProjectId } from "../templates/service";
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
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return {
    committerName: name || user.email,
    committerEmail: user.email,
  };
}

/**
 * Create a single artifact record within an existing transaction. Centralized
 * so the create() route AND the start-plan-loop-from-local helper share the
 * same artifact-shape contract (slug generation, version 1 seeding,
 * sentinel-project resolution, optional source link).
 *
 * Exported for use by `documentExecutionService.startPlanLoopFromLocal`.
 */
export async function createDocumentRecord(
  tx: TransactionClient,
  organizationId: string,
  userId: string,
  input: CreateDocumentInput
): Promise<Document | null> {
  const isTemplate = input.type === DocumentType.Template;

  let resolvedProjectId = input.projectId;

  if (isTemplate) {
    resolvedProjectId = await resolveTemplatesSentinelProjectId(
      organizationId,
      userId
    );
  } else if (!input.projectId) {
    return null;
  }

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
    status: documentInput.status ?? DocumentStatus.Draft,
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
  });

  if (sourceId) {
    await tx.artifactLink.create({
      data: {
        organizationId,
        sourceId,
        targetId: createdArtifact.id,
        linkType: LinkType.Produces,
      },
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

/**
 * Spacing between consecutive `sortOrder` values when reindexing artifacts.
 *
 * A gap larger than 1 lets `moveArtifact` insert a row between two existing
 * neighbours by writing a single midpoint value rather than rewriting the
 * entire affected window. The matching backfill migration
 * (`20260528220059_backfill_artifact_sort_order`) seeds existing rows on the
 * same grid, so every code path that produces a sortOrder uses this constant.
 */
export const STACK_RANK_GAP = 1000;

export const documentService = {
  /**
   * Find all DOCUMENT artifacts with optional filters (org-scoped). Returns
   * each document with its project (with teams), and generation status
   * (resolved from Loop records, with dismissed failures suppressed).
   */
  async findAll(
    options: FindDocumentsOptions & { organizationId: string }
  ): Promise<DocumentWithProject[]> {
    const { organizationId, type, projectId, assigneeId } = options;

    const artifacts = await withDb((db) =>
      db.artifact.findMany({
        where: documentWhere({
          organizationId,
          ...(projectId ? { projectId } : {}),
          ...(type ? { subtype: type } : {}),
          ...(assigneeId ? { assigneeId } : {}),
        }),
        include: documentIncludeWithContext,
        orderBy: { createdAt: "desc" },
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
    options: FindDocumentsOptions & { organizationId: string }
  ): Promise<DocumentWithProject[]> {
    const documents = await documentService.findAll(options);
    if (documents.length === 0) {
      return documents;
    }

    const allValues = await customFieldValuesService.getValuesForEntity(
      CustomFieldEntityType.Document,
      documents.map((d) => d.id),
      options.organizationId
    );

    const valuesByEntityId = new Map<string, typeof allValues>();
    for (const value of allValues) {
      const list = valuesByEntityId.get(value.entityId);
      if (list) {
        list.push(value);
      } else {
        valuesByEntityId.set(value.entityId, [value]);
      }
    }

    return documents.map((d) => ({
      ...d,
      customFields: valuesByEntityId.get(d.id) ?? [],
    }));
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
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { organizationId_slug: { organizationId, slug } },
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

    if (isTemplate && input.projectId) {
      throw new Error(
        "Templates are organization-level artifacts and cannot be associated with a project"
      );
    }
    if (!(isTemplate || input.projectId)) {
      throw new Error(
        "Artifacts (except templates) must be associated with a project"
      );
    }

    if (isTemplate && input.templateForType) {
      const duplicate = await withDb((db) =>
        db.documentDetail.findFirst({
          where: {
            templateForType: input.templateForType,
            artifact: {
              organizationId,
              type: ArtifactType.Document,
              subtype: DocumentType.Template,
            },
          },
          select: { artifactId: true },
        })
      );
      if (duplicate) {
        throw new Error(
          `A template already exists for ${input.templateForType} in this organization`
        );
      }
    }

    const createdDocument = await withDb.tx((tx) =>
      createDocumentRecord(tx, organizationId, userId, input)
    );

    if (createdDocument) {
      await createDocumentRoom(createdDocument);
    }

    return createdDocument;
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
    return toDocument(updated);
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
   * apps/api/CLAUDE.md "Errors as values"):
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
   */
  batchUpdateStatus(
    documentIds: string[],
    status: DocumentStatus,
    organizationId: string
  ): Promise<string[]> {
    const uniqueIds = [...new Set(documentIds)];

    return withDb.tx(async (tx) => {
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

      await tx.artifact.updateMany({
        where: documentWhere({ id: { in: uniqueIds }, organizationId }),
        data: { status },
      });

      return uniqueIds;
    });
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

/**
 * Compute the next sortOrder for a brand-new DOCUMENT artifact landing in
 * `projectId`: one full `STACK_RANK_GAP` past the current maximum. Returns
 * `0` when the project is empty.
 *
 * Must be called inside the same `withDb.tx` as the subsequent `create`. The
 * composite index on `(organization_id, project_id, sort_order)` keeps the
 * MAX read cheap. Two concurrent inserts under READ COMMITTED can read the
 * same MAX and write the same value; the project tree compare function
 * tiebreaks on `createdAt` so the visible order stays deterministic, and
 * subsequent user moves will spread the rows back out.
 */
async function computeNextSortOrder(
  tx: TransactionClient,
  organizationId: string,
  projectId: string
): Promise<number> {
  const max = await tx.artifact.aggregate({
    where: documentWhere({ projectId, organizationId }),
    _max: { sortOrder: true },
  });
  const current = max._max.sortOrder;
  return current === null ? 0 : current + STACK_RANK_GAP;
}

/**
 * Tagged error shape returned by `documentService.moveArtifact` (and its
 * internal `resolveInsertIndex` helper). `status` is the HTTP status the
 * route should map to; `message` is the descriptive payload safe to send
 * back to API clients.
 */
export type MoveArtifactError = {
  status: StatusCode;
  message: string;
};

/**
 * Compute the array index at which `input.artifactId` should land after the
 * move. `ids` is the current project ordering INCLUDING the target. The
 * returned index is into the array WITHOUT the target spliced out, ready for
 * `Array#slice`-based insertion.
 *
 * Returns `Result.err` (not a throw) for the validation cases documented in
 * `documentService.moveArtifact` so the route can map them to 4xx instead of
 * 500.
 */
function resolveInsertIndex(
  ids: readonly string[],
  input: MoveArtifactRequest,
  projectId: string
): Result<number, MoveArtifactError> {
  const withoutTarget = ids.filter((id) => id !== input.artifactId);

  if (input.position === MovePosition.Top) {
    return Result.ok(0);
  }
  if (input.position === MovePosition.Bottom) {
    return Result.ok(withoutTarget.length);
  }
  if (!input.referenceArtifactId) {
    return Result.err({
      status: Status.BadRequest,
      message: `referenceArtifactId is required for position "${input.position}"`,
    });
  }
  if (input.referenceArtifactId === input.artifactId) {
    return Result.err({
      status: Status.BadRequest,
      message: `referenceArtifactId must differ from artifactId (${input.artifactId})`,
    });
  }
  const refIndex = withoutTarget.indexOf(input.referenceArtifactId);
  if (refIndex < 0) {
    return Result.err({
      status: Status.NotFound,
      message: `Reference artifact ${input.referenceArtifactId} not found in project ${projectId}`,
    });
  }
  return Result.ok(
    input.position === MovePosition.Before ? refIndex : refIndex + 1
  );
}
