import { LinkType } from "@repo/api/src/types/artifact";
import {
  BATCH_META_MAX_SLUGS,
  type CreateDocumentInput,
  type Document,
  DocumentStatus,
  type DocumentTitleMap,
  DocumentType,
  type DocumentWithWorkstream,
  type FindDocumentsOptions,
  type GenerationStatus,
  type UpdateDocumentInput,
} from "@repo/api/src/types/document";
import {
  ArtifactType,
  type Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { documentWhere } from "@/lib/artifact-adapters";
import { generateArtifactSlug } from "@/lib/slug-generator";
import { resolveTemplatesSentinelProjectId } from "../templates/service";
import {
  documentIncludeWithContext,
  documentIncludeWithUser,
  parseTriggerData,
  type RawDocumentWithContext,
  splitDocumentPayload,
  toDocument,
} from "./document-utils";
import {
  mergeLoopStatuses,
  suppressDismissedFailuresForDocumentMap,
  withRunKey,
} from "./generation-status-helpers";
import { createDocumentRoom, deleteDocumentRoom } from "./room-utils";

/**
 * Document general/CRUD service. Owns reads, writes, deletes, listing,
 * template handling, related-document graph traversal, batch utilities, and
 * the workstream-resolution helpers that the generation/execution flows
 * compose with.
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
 * Look up the GitHubInstallationRepository record id for a given repo full
 * name. Returns null if the repo isn't linked to an ACTIVE installation.
 *
 * Exported for use by generation/execution flows.
 */
export async function findInstallationRepoId(
  organizationId: string,
  repoFullName: string
): Promise<string | null> {
  const repo = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        fullName: repoFullName,
        installation: { organizationId, status: "ACTIVE" },
      },
      select: { id: true },
    })
  );
  return repo?.id ?? null;
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
    const workstream = await tx.workstream.findUnique({
      where: { id: input.workstreamId, organizationId },
    });
    if (!workstream) {
      return null;
    }
    resolvedProjectId = workstream.projectId;
  }

  const resolvedAssigneeId = input.assigneeId ?? userId;
  await validateUserInOrg(resolvedAssigneeId, organizationId);

  if (input.approverId) {
    await validateUserInOrg(input.approverId, organizationId);
  }

  const slug = await generateArtifactSlug(organizationId, input.type);
  const { sourceId, content, ...documentInput } = input;

  const { artifact: artifactData, detail: detailData } = splitDocumentPayload({
    ...documentInput,
    slug,
    latestVersion: 1,
    projectId: resolvedProjectId,
    assigneeId: resolvedAssigneeId,
    status: documentInput.status ?? DocumentStatus.Draft,
  });

  const createdArtifact = await tx.artifact.create({
    data: {
      ...artifactData,
      organizationId,
      createdById: userId,
      document: { create: detailData },
    } as Prisma.ArtifactUncheckedCreateInput,
    include: documentIncludeWithUser,
  });

  await tx.documentVersion.create({
    data: {
      documentId: createdArtifact.id,
      version: 1,
      content,
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

/** Transform Artifact + detail into the DocumentWithWorkstream wire shape. */
function toDocumentWithWorkstream(
  artifact: RawDocumentWithContext,
  maps?: {
    generationStatusMap?: Map<string, GenerationStatus>;
  }
): DocumentWithWorkstream {
  const generationStatus = maps?.generationStatusMap?.get(artifact.id);
  const base = toDocument(artifact);

  return {
    ...base,
    workstream: artifact.workstream ?? null,
    project: artifact.project
      ? {
          id: artifact.project.id,
          name: artifact.project.name,
          teams: artifact.project.teams.map(
            (pt: { team: { id: string; name: string } }) => pt.team
          ),
        }
      : null,
    ...(generationStatus && { generationStatus }),
  };
}

export const documentService = {
  /**
   * Find all DOCUMENT artifacts with optional filters (org-scoped). Returns
   * each document with its workstream, project (with teams), and generation
   * status (resolved from GitHub Actions + Loop records, with dismissed
   * failures suppressed).
   */
  async findAll(
    options: FindDocumentsOptions & { organizationId: string }
  ): Promise<DocumentWithWorkstream[]> {
    const { organizationId, type, workstreamId, projectId, assigneeId } =
      options;

    const artifacts = await withDb((db) =>
      db.artifact.findMany({
        where: documentWhere({
          organizationId,
          ...(workstreamId ? { workstreamId } : {}),
          ...(!workstreamId && projectId ? { projectId } : {}),
          ...(type ? { subtype: type } : {}),
          ...(assigneeId ? { assigneeId } : {}),
        }),
        include: documentIncludeWithContext,
        orderBy: { createdAt: "desc" },
      })
    );

    const uniqueWorkstreamIds = [
      ...new Set(
        artifacts
          .map((a: { workstreamId: string | null }) => a.workstreamId)
          .filter((id: string | null): id is string => id !== null)
      ),
    ];

    const generationStatusMap = new Map<string, GenerationStatus>();
    if (uniqueWorkstreamIds.length > 0) {
      const actionRuns = await withDb((db) =>
        db.gitHubActionRun.findMany({
          where: {
            workstreamId: { in: uniqueWorkstreamIds },
            workflowName: "symphony-dispatch",
          },
          orderBy: { createdAt: "desc" },
          take: uniqueWorkstreamIds.length,
          select: {
            workstreamId: true,
            status: true,
            htmlUrl: true,
            startedAt: true,
            completedAt: true,
            triggerData: true,
          },
        })
      );

      for (const run of actionRuns) {
        const triggerData = parseTriggerData(run.triggerData);
        if (!triggerData) {
          continue;
        }

        const documentId = triggerData.documentId;

        // CANCELLED maps to FAILURE since both are terminal non-success states.
        const status: GenerationStatus["status"] =
          run.status === "CANCELLED" ? "FAILURE" : run.status;

        if (!generationStatusMap.has(documentId)) {
          generationStatusMap.set(
            documentId,
            withRunKey({
              status,
              command: triggerData.command,
              htmlUrl: run.htmlUrl || null,
              startedAt: run.startedAt,
              completedAt: run.completedAt,
              correlationId: triggerData.correlationId,
              source: "github_actions",
            })
          );
        }
      }
    }

    await mergeLoopStatuses(
      artifacts.map((a) => a.id),
      generationStatusMap
    );

    await suppressDismissedFailuresForDocumentMap(
      artifacts.map((a) => a.id),
      generationStatusMap
    );

    return artifacts.map((a: RawDocumentWithContext) =>
      toDocumentWithWorkstream(a, { generationStatusMap })
    );
  },

  /** Find a DOCUMENT artifact by id (org-scoped) with workstream + project context. */
  async findById(
    id: string,
    organizationId: string
  ): Promise<DocumentWithWorkstream | null> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
        include: documentIncludeWithContext,
      })
    );

    if (artifact?.type !== ArtifactType.DOCUMENT) {
      return null;
    }

    return toDocumentWithWorkstream(artifact, {});
  },

  /** Find a DOCUMENT artifact by slug (org-scoped) with workstream + project context. */
  async findBySlug(
    slug: string,
    organizationId: string
  ): Promise<DocumentWithWorkstream | null> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { organizationId_slug: { organizationId, slug } },
        include: documentIncludeWithContext,
      })
    );

    if (artifact?.type !== ArtifactType.DOCUMENT) {
      return null;
    }

    return toDocumentWithWorkstream(artifact, {});
  },

  /** Find a DOCUMENT artifact by id (org-scoped) without workstream context. */
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
    if (artifact?.type !== ArtifactType.DOCUMENT) {
      return null;
    }
    return toDocument(artifact);
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

    if (isTemplate && (input.projectId || input.workstreamId)) {
      throw new Error(
        "Templates are organization-level artifacts and cannot be associated with a project or workstream"
      );
    }
    if (!(isTemplate || input.projectId || input.workstreamId)) {
      throw new Error(
        "Artifacts (except templates) must be associated with a project or workstream"
      );
    }

    if (isTemplate && input.templateForType) {
      const duplicate = await withDb((db) =>
        db.documentDetail.findFirst({
          where: {
            templateForType: input.templateForType,
            artifact: {
              organizationId,
              type: ArtifactType.DOCUMENT,
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

    if (artifact?.type !== ArtifactType.DOCUMENT) {
      return;
    }

    await withDb((db) => db.artifact.delete({ where: { id, organizationId } }));

    if (artifact.slug) {
      await deleteDocumentRoom(organizationId, artifact.slug);
    }
  },

  /**
   * Reorder documents by setting sortOrder values atomically. Validates that
   * all artifacts belong to the user's organization.
   */
  reorder(documentIds: string[], organizationId: string): Promise<string[]> {
    if (documentIds.length === 0) {
      return Promise.resolve([]);
    }

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

      await Promise.all(
        uniqueIds.map((id, index) =>
          tx.artifact.update({
            where: { id, organizationId },
            data: { sortOrder: index },
          })
        )
      );

      return uniqueIds;
    });
  },

  /**
   * Move multiple documents to a target project atomically. Validates that
   * all artifacts and the target project belong to the user's organization.
   */
  batchMove(
    documentIds: string[],
    targetProjectId: string,
    organizationId: string
  ): Promise<string[]> {
    const uniqueIds = [...new Set(documentIds)];

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

      await tx.artifact.updateMany({
        where: documentWhere({ id: { in: uniqueIds }, organizationId }),
        data: { projectId: targetProjectId },
      });

      return uniqueIds;
    });
  },

  /**
   * Batch-fetch document titles by slug (org-scoped). Returns a map of slug
   * → title for all slugs found. Slugs not found are omitted.
   */
  batchFetchDocumentTitles(
    organizationId: string,
    slugs: string[]
  ): Promise<DocumentTitleMap> {
    if (slugs.length === 0) {
      return Promise.resolve({});
    }
    return withDb(async (db) => {
      if (slugs.length > BATCH_META_MAX_SLUGS) {
        throw new Error(
          `batchFetchDocumentTitles: too many slugs (max ${BATCH_META_MAX_SLUGS})`
        );
      }
      const artifacts = await db.artifact.findMany({
        where: documentWhere({ organizationId, slug: { in: slugs } }),
        select: { slug: true, name: true },
      });

      return Object.fromEntries(
        artifacts
          .filter(
            (a: { slug: string | null }): a is { slug: string; name: string } =>
              a.slug !== null
          )
          .map((a: { slug: string; name: string }) => [a.slug, a.name])
      );
    });
  },
};
