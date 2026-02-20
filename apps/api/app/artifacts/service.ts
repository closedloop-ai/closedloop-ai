import { createId } from "@paralleldrive/cuid2";
import {
  type Artifact,
  type ArtifactTitleMap,
  ArtifactType,
  type ArtifactWithWorkstream,
  BATCH_META_MAX_SLUGS,
  type BatchCreateArtifactInput,
  type CreateArtifactInput,
  type FindArtifactsOptions,
  type GenerationStatus,
  type PullRequestInfo,
  PullRequestState,
  ReviewDecision,
  type UpdateArtifactInput,
} from "@repo/api/src/types/artifact";
import type {
  JudgesFeedbackResponse,
  JudgesReport,
} from "@repo/api/src/types/evaluation";
import type { ExecutionTrace } from "@repo/api/src/types/execution-log";
import type { PerfSummary } from "@repo/api/src/types/performance";
import type { ArtifactRatingSummary } from "@repo/api/src/types/rating";
import {
  LinkType,
  ArtifactType as PrismaArtifactType,
  type TransactionClient,
  withDb,
} from "@repo/database";
import {
  downloadWorkflowArtifacts,
  getRepositoryInfo,
  triggerWorkflowDispatch,
} from "@repo/github";
import {
  createEmptyExecutionTrace,
  parseExecutionLogs,
} from "@repo/github/execution-log-parser";
import { SYMPHONY_RUN_ARTIFACT_PREFIXES } from "@repo/github/zip-utils";
import { log } from "@repo/observability/log";
import { entityLinksService } from "../entity-links/service";
import {
  ArtifactNotFoundError,
  artifactIncludeWithContext,
  artifactIncludeWithSnippet,
  artifactIncludeWithUser,
  generateSlug,
  parseTriggerData,
} from "./artifact-utils";
import { artifactVersionService } from "./artifact-version-service";
import { createArtifactRoom, deleteArtifactRoom } from "./room-utils";
import { PRD_TEMPLATE } from "./template-seeds";

/**
 * Validate that a user belongs to the given organization.
 * Throws if the user does not exist within the org.
 */
async function validateOwnerInOrg(
  ownerId: string,
  organizationId: string
): Promise<void> {
  const owner = await withDb((db) =>
    db.user.findFirst({
      where: { id: ownerId, organizationId },
      select: { id: true },
    })
  );
  if (!owner) {
    throw new Error("Invalid owner ID: user not found in this organization");
  }
}

/**
 * Look up the user's name and email for git commit attribution.
 * Used to set committer identity on bot commits so Vercel can
 * match the author to a team member and trigger preview deploys.
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
 * Create a single artifact record within an existing transaction.
 * Does NOT call withDb.tx internally - takes the tx parameter directly.
 * Used by both create() and batchCreate() to avoid code duplication.
 *
 * NOTE: validateOwnerInOrg uses withDb (non-transactional) and opens separate
 * connections. This matches the behavior of the existing create() method.
 */
async function createArtifactRecord(
  tx: TransactionClient,
  organizationId: string,
  userId: string,
  input: CreateArtifactInput
): Promise<Artifact | null> {
  const isTemplate = input.type === ArtifactType.Template;

  // Resolve projectId from workstream if needed (non-templates only)
  if (!(isTemplate || input.projectId)) {
    const workstream = await tx.workstream.findUnique({
      where: { id: input.workstreamId, organizationId },
    });
    if (!workstream) {
      return null;
    }
    input.projectId = workstream.projectId;
  }

  const resolvedOwnerId = input.ownerId ?? userId;
  await validateOwnerInOrg(resolvedOwnerId, organizationId);

  if (input.approverId) {
    await validateOwnerInOrg(input.approverId, organizationId);
  }

  const slug = generateSlug();
  const { sourceId, sourceType, sourceVersion, content, ...artifactInput } =
    input;

  const artifact = await tx.artifact.create({
    data: {
      ...artifactInput,
      organizationId,
      slug,
      latestVersion: 1,
      generatedBy: userId,
      ownerId: resolvedOwnerId,
    },
    include: artifactIncludeWithUser,
  });

  // Create initial artifact version
  await tx.artifactVersion.create({
    data: {
      artifactId: artifact.id,
      version: 1,
      content,
      createdById: userId,
    },
  });

  if (sourceId && sourceType) {
    await tx.entityLink.create({
      data: {
        organizationId,
        sourceId,
        sourceType,
        sourceVersion,
        targetId: artifact.id,
        targetType: "ARTIFACT",
        targetVersion: artifact.latestVersion,
        linkType: LinkType.PRODUCES,
      },
    });
  }

  return artifact;
}

// Result types for service operations
export type RegenerateResult =
  | { success: true; artifact: Artifact }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 };

/**
 * Artifacts service - handles database operations for artifact management
 */
export const artifactsService = {
  /**
   * Find all artifacts with optional filters (org-scoped)
   */
  async findAll(
    options: FindArtifactsOptions & { organizationId: string }
  ): Promise<ArtifactWithWorkstream[]> {
    const { organizationId, type, workstreamId, projectId, ownerId } = options;

    const artifacts = await withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId,
          ...(workstreamId ? { workstreamId } : {}),
          ...(!workstreamId && projectId ? { projectId } : {}),
          ...(type ? { type } : {}),
          ...(ownerId ? { ownerId } : {}),
        },
        include: artifactIncludeWithSnippet,
        orderBy: { createdAt: "desc" },
      })
    );

    // Collect unique workstream IDs for batch queries
    const uniqueWorkstreamIds = [
      ...new Set(
        artifacts
          .map((a) => a.workstreamId)
          .filter((id): id is string => id !== null)
      ),
    ];

    // Batch-fetch GitHubActionRun records for generation status
    let generationStatusMap: Map<string, GenerationStatus> = new Map();
    if (uniqueWorkstreamIds.length > 0) {
      const actionRuns = await withDb((db) =>
        db.gitHubActionRun.findMany({
          where: {
            workstreamId: { in: uniqueWorkstreamIds },
            workflowName: "symphony-dispatch",
          },
          orderBy: { createdAt: "desc" },
          take: 100,
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

      // Build map: artifactId -> most recent GenerationStatus
      generationStatusMap = new Map<string, GenerationStatus>();
      for (const run of actionRuns) {
        const triggerData = parseTriggerData(run.triggerData);
        if (!triggerData) {
          continue;
        }

        const artifactId = triggerData.artifactId;

        // Map Prisma GitHubActionStatus to GenerationStatus.
        // CANCELLED maps to FAILURE since both are terminal non-success states.
        const status: GenerationStatus["status"] =
          run.status === "CANCELLED" ? "FAILURE" : run.status;

        // Only set if this artifact doesn't have a status yet (first = most recent)
        if (!generationStatusMap.has(artifactId)) {
          generationStatusMap.set(artifactId, {
            status,
            command: triggerData.command,
            htmlUrl: run.htmlUrl || null,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            correlationId: triggerData.correlationId,
          });
        }
      }
    }

    // Batch-fetch GitHubPullRequest records for each workstream
    const pullRequestRecords =
      uniqueWorkstreamIds.length > 0
        ? await withDb((db) =>
            db.gitHubPullRequest.findMany({
              where: { workstreamId: { in: uniqueWorkstreamIds } },
              select: {
                id: true,
                number: true,
                title: true,
                htmlUrl: true,
                state: true,
                headBranch: true,
                baseBranch: true,
                createdAt: true,
                reviewDecision: true,
                workstreamId: true,
              },
              orderBy: { createdAt: "desc" },
              take: 100,
            })
          )
        : [];

    const pullRequestMap = buildPullRequestMap(pullRequestRecords);

    return artifacts.map((a) =>
      toArtifactWithWorkstream(a, { generationStatusMap, pullRequestMap })
    );
  },

  /**
   * Find an artifact by ID with context (org-scoped)
   */
  async findById(
    id: string,
    organizationId: string
  ): Promise<ArtifactWithWorkstream | null> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
        include: artifactIncludeWithContext,
      })
    );

    if (!artifact) {
      return null;
    }

    return toArtifactWithWorkstream(artifact, {});
  },

  /**
   * Find an artifact by slug with context (org-scoped)
   */
  async findBySlug(
    slug: string,
    organizationId: string
  ): Promise<ArtifactWithWorkstream | null> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { organizationId_slug: { organizationId, slug } },
        include: artifactIncludeWithContext,
      })
    );

    if (!artifact) {
      return null;
    }

    return toArtifactWithWorkstream(artifact, {});
  },

  /**
   * Find an artifact by ID without context (org-scoped)
   */
  async findByIdSimple(
    id: string,
    organizationId: string
  ): Promise<Artifact | null> {
    const result = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
        include: artifactIncludeWithUser,
      })
    );
    return result;
  },

  /**
   * Find an organization template for a specific artifact type.
   * Returns null if no template exists for the given type.
   * Pure read method - does NOT create templates automatically.
   */
  async findOrgTemplate(
    organizationId: string,
    templateForType: PrismaArtifactType
  ): Promise<Artifact | null> {
    const result = await withDb((db) =>
      db.artifact.findUnique({
        where: {
          organizationId_templateForType: {
            organizationId,
            templateForType,
          },
        },
        include: artifactIncludeWithUser,
      })
    );
    return result;
  },

  /**
   * Ensure default templates exist for an organization.
   * Creates/upserts the PRD template.
   * Uses upsert on the unique constraint (organizationId, templateForType) for concurrency safety.
   */
  async ensureDefaultTemplates(organizationId: string): Promise<void> {
    const template = await withDb((db) =>
      db.artifact.upsert({
        where: {
          organizationId_templateForType: {
            organizationId,
            templateForType: PrismaArtifactType.PRD,
          },
        },
        create: {
          type: PrismaArtifactType.TEMPLATE,
          templateForType: PrismaArtifactType.PRD,
          organizationId,
          title: "Product Requirements Document Template",
          slug: generateSlug(),
          latestVersion: 1,
        },
        // On conflict, do nothing - preserve existing template content
        // (user may have edited the template)
        update: {},
        select: { id: true },
      })
    );

    // Create the initial version with template content if it doesn't exist yet
    const existingVersion = await artifactVersionService.getLatest(template.id);
    if (!existingVersion) {
      await artifactVersionService.createVersion(
        template.id,
        null,
        PRD_TEMPLATE
      );
    }
  },

  /**
   * Get the most recent pull request for an artifact's workstream.
   * Returns null if artifact has no workstream or no PR exists.
   */
  async getArtifactPullRequest(
    artifactId: string,
    organizationId: string
  ): Promise<PullRequestInfo | null> {
    // Get the artifact to find its workstreamId
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id: artifactId, organizationId },
        select: { workstreamId: true },
      })
    );

    if (!artifact?.workstreamId) {
      return null;
    }

    // Find the most recent PR for this workstream, selecting only the fields we need
    const pr = await withDb((db) =>
      db.gitHubPullRequest.findFirst({
        where: { workstreamId: artifact.workstreamId as string },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          number: true,
          title: true,
          htmlUrl: true,
          state: true,
          headBranch: true,
          baseBranch: true,
          createdAt: true,
          reviewDecision: true,
        },
      })
    );

    if (!pr) {
      return null;
    }

    return toPullRequestInfo(pr);
  },

  /**
   * Create a new artifact (handles initial version and Liveblocks room creation)
   */
  async create(
    organizationId: string,
    userId: string,
    input: CreateArtifactInput
  ): Promise<Artifact | null> {
    const isTemplate = input.type === ArtifactType.Template;

    // Validate scope constraints
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

    const createdArtifact = await withDb.tx((tx) =>
      createArtifactRecord(tx, organizationId, userId, input)
    );

    if (createdArtifact) {
      // Create Liveblocks room for all artifacts
      await createArtifactRoom(createdArtifact);
    }

    return createdArtifact;
  },

  /**
   * Create multiple artifacts in a single transaction.
   * All items are created atomically - if any fails, the entire batch is rolled back.
   * Liveblocks rooms are created after the transaction completes.
   *
   * @param organizationId - Organization ID for all artifacts
   * @param userId - User ID for authorship attribution
   * @param input - Batch input with array of artifact creation inputs (1-50 items)
   */
  async batchCreate(
    organizationId: string,
    userId: string,
    input: BatchCreateArtifactInput
  ): Promise<Artifact[]> {
    const createdArtifacts = await withDb.tx(async (tx) => {
      const results: Artifact[] = [];
      for (const item of input.items) {
        const artifact = await createArtifactRecord(
          tx,
          organizationId,
          userId,
          item
        );
        if (!artifact) {
          throw new Error(
            `Failed to create artifact: workstream not found for item "${item.title}"`
          );
        }
        results.push(artifact);
      }
      return results;
    });

    // Create Liveblocks rooms after transaction completes
    await Promise.all(createdArtifacts.map((a) => createArtifactRoom(a)));

    return createdArtifacts;
  },

  /**
   * Update an existing artifact.
   */
  async update(
    id: string,
    organizationId: string,
    input: Omit<UpdateArtifactInput, "id">
  ): Promise<Artifact> {
    if (input.ownerId) {
      await validateOwnerInOrg(input.ownerId, organizationId);
    }
    if (input.approverId) {
      await validateOwnerInOrg(input.approverId, organizationId);
    }
    if (input.projectId) {
      const project = await withDb((db) =>
        db.project.findFirst({
          where: { id: input.projectId!, organizationId },
          select: { id: true },
        })
      );
      if (!project) {
        throw new Error(
          "Invalid project ID: project not found in this organization"
        );
      }
    }

    return withDb((db) =>
      db.artifact.update({
        where: { id, organizationId },
        data: input,
        include: artifactIncludeWithUser,
      })
    );
  },

  /**
   * Delete an artifact and its associated resources.
   */
  async delete(id: string, organizationId: string): Promise<void> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
        select: {
          slug: true,
          organizationId: true,
        },
      })
    );

    if (!artifact) {
      return;
    }

    // Delete entity links referencing this artifact, then delete the artifact
    await withDb.tx(async (tx) => {
      await tx.entityLink.deleteMany({
        where: {
          organizationId,
          OR: [
            { sourceId: id, sourceType: "ARTIFACT" },
            { targetId: id, targetType: "ARTIFACT" },
          ],
        },
      });
      await tx.artifact.delete({ where: { id } });
    });

    await deleteArtifactRoom(organizationId, artifact.slug);
  },

  /**
   * Find an artifact with full regeneration context (workstream, project, repositories, source artifact)
   */
  findWithRegenerationContext(id: string, organizationId: string) {
    return withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
        include: {
          workstream: {
            include: {
              project: {
                include: {
                  repositories: {
                    take: 1,
                  },
                },
              },
              // Find the PRD in this workstream (source artifact for plan generation)
              artifacts: {
                where: {
                  type: PrismaArtifactType.PRD,
                },
                take: 1,
              },
            },
          },
        },
      })
    );
  },

  /**
   * Find or create a workstream for the artifact.
   * If artifact has a workstream, returns it with source PRD looked up via entity links.
   * If no workstream, finds source PRD (entity links then title fallback),
   * auto-creates a workstream, and links both artifacts to it.
   */
  async findOrCreateWorkstream(
    organizationId: string,
    artifact: NonNullable<
      Awaited<ReturnType<typeof this.findWithRegenerationContext>>
    >,
    userId: string
  ): Promise<{
    workstream: NonNullable<typeof artifact.workstream> | null;
    sourceArtifact: {
      id: string;
      title: string;
      targetRepo: string | null;
      targetBranch: string | null;
      content: string | null;
    } | null;
  }> {
    // If workstream exists, find source via entity links
    if (artifact.workstream) {
      const sourceArtifact = await this.findSourceWithContent(artifact);
      return {
        workstream: artifact.workstream,
        sourceArtifact,
      };
    }

    if (!artifact.projectId) {
      return {
        workstream: null,
        sourceArtifact: null,
      };
    }

    // Try entity links first
    let foundSource = await this.findSourceWithContent(artifact);

    // Fallback: title matching (strips "Implementation Plan: " prefix)
    if (!foundSource?.content) {
      const titleFallback = artifact.title.replace("Implementation Plan: ", "");
      const matchedArtifact = await withDb((db) =>
        db.artifact.findFirst({
          where: {
            organizationId,
            projectId: artifact.projectId,
            type: PrismaArtifactType.PRD,
            title: titleFallback,
          },
        })
      );
      if (matchedArtifact) {
        const latestVersion = await artifactVersionService.getLatest(
          matchedArtifact.id
        );
        foundSource = {
          ...matchedArtifact,
          content: latestVersion?.content ?? null,
        };

        // Persist the PRODUCES link so subsequent calls resolve via findSourceWithContent
        await entityLinksService.createLink(organizationId, {
          sourceId: matchedArtifact.id,
          sourceType: "ARTIFACT",
          targetId: artifact.id,
          targetType: "ARTIFACT",
          linkType: LinkType.PRODUCES,
        });
      }
    }

    if (!foundSource?.content) {
      return {
        workstream: null,
        sourceArtifact: foundSource,
      };
    }

    // If the source PRD already belongs to a workstream, attach the orphan
    // artifact to it instead of creating a new workstream (avoids reassigning
    // the PRD away from its existing workstream and breaking related artifacts).
    if (foundSource.workstreamId) {
      return withDb.tx(async (tx) => {
        await tx.artifact.update({
          where: { id: artifact.id, organizationId },
          data: { workstreamId: foundSource.workstreamId },
        });

        const workstream = await tx.workstream.findUnique({
          where: { id: foundSource.workstreamId! },
          include: {
            project: {
              include: {
                repositories: { take: 1 },
              },
            },
            artifacts: {
              where: { type: PrismaArtifactType.PRD },
              take: 1,
            },
          },
        });

        return {
          workstream,
          sourceArtifact: foundSource,
        };
      });
    }

    // Auto-create workstream and link both artifacts
    return withDb.tx(async (tx) => {
      const newWorkstream = await tx.workstream.create({
        data: {
          organizationId,
          projectId: artifact.projectId as string,
          title: foundSource.title,
          description: `Auto-created for: ${foundSource.title}`,
          type: "FEATURE_DELIVERY",
          createdById: userId,
        },
      });

      await tx.artifact.updateMany({
        where: {
          id: { in: [foundSource.id, artifact.id] },
          organizationId,
        },
        data: { workstreamId: newWorkstream.id },
      });

      const workstream = await tx.workstream.findUnique({
        where: { id: newWorkstream.id },
        include: {
          project: {
            include: {
              repositories: { take: 1 },
            },
          },
          artifacts: {
            where: { type: PrismaArtifactType.PRD },
            take: 1,
          },
        },
      });

      return {
        workstream,
        sourceArtifact: foundSource,
      };
    });
  },

  /**
   * Check if a workflow is already running for a workstream
   */
  findPendingWorkflowRun(workstreamId: string, workflowName: string) {
    return withDb((db) =>
      db.gitHubActionRun.findFirst({
        where: {
          workstreamId,
          workflowName,
          status: { in: ["PENDING", "QUEUED", "RUNNING"] },
        },
      })
    );
  },

  /**
   * Find the source PRD in the workstream for the artifact.
   */
  async findSourceWithContent(
    artifact: NonNullable<
      Awaited<ReturnType<typeof this.findWithRegenerationContext>>
    >
  ) {
    const sourceLinks = await entityLinksService.findSourceLinks(
      artifact.organizationId,
      artifact.id,
      "ARTIFACT",
      LinkType.PRODUCES
    );
    if (!sourceLinks.length) {
      return null;
    }

    // TODO: Add issue support.
    const sourceArtifacts = await withDb((db) =>
      db.artifact.findMany({
        where: {
          id: { in: sourceLinks.map((link) => link.sourceId) },
          organizationId: artifact.organizationId,
        },
      })
    );
    const sourceArtifact = sourceArtifacts.find(
      (artifact) => artifact.type === PrismaArtifactType.PRD
    );

    // Load the latest version content for the source artifact
    let sourceContent: string | null = null;
    if (sourceArtifact) {
      const latestVersion = await artifactVersionService.getLatest(
        sourceArtifact.id
      );
      sourceContent = latestVersion?.content ?? null;
    }

    return sourceArtifact
      ? { ...sourceArtifact, content: sourceContent }
      : null;
  },

  /**
   * Build context for plan generation from source artifact content and optional initial instructions.
   * Appends "assume defaults" instruction to skip Q&A flow.
   */
  buildPlanContext(
    sourceContent: string,
    initialInstructions: string | null
  ): string {
    let context = sourceContent;

    // Add initial instructions if provided and not a failure message
    if (
      initialInstructions?.trim() &&
      !initialInstructions.startsWith("# Plan Generation Failed")
    ) {
      context += `

---

## Additional Instructions

${initialInstructions.trim()}`;
    }

    // Always append "assume defaults" instruction
    context += `

---

**Important:** For the implementation plan, please assume reasonable defaults for any questions that arise. You may document those as open questions in the plan for further iteration, but do not ask for clarification - proceed with your best judgment.`;

    return context;
  },

  /**
   * Create records for a triggered workflow (action run, artifact status update, event)
   */
  createWorkflowTriggerRecords(params: {
    organizationId: string;
    workstreamId: string;
    repositoryId: string;
    artifactId: string;
    prdId: string;
    correlationId: string;
    targetRepo: string;
    targetBranch: string;
  }): Promise<Artifact> {
    const {
      organizationId,
      workstreamId,
      repositoryId,
      artifactId,
      prdId,
      correlationId,
      targetRepo,
      targetBranch,
    } = params;

    return withDb(async (db) => {
      const [, updatedArtifact] = await Promise.all([
        db.gitHubActionRun.create({
          data: {
            workstreamId,
            repositoryId,
            runId: null, // Will be populated by webhook when GitHub provides the actual runId
            workflowName: "symphony-dispatch",
            status: "PENDING",
            htmlUrl: "",
            triggerEvent: "workflow_dispatch",
            triggerData: {
              correlationId: `${process.env.WEBAPP_ENV}-${correlationId}`,
              artifactId,
              prdId,
              command: "plan",
            },
            sessionId: prdId,
            jobType: "generate",
            startedAt: new Date(),
          },
        }),
        db.artifact.update({
          where: { id: artifactId, organizationId },
          data: {
            status: "DRAFT",
            // Correlation tracked via GitHubActionRun.triggerData.correlationId
          },
          include: artifactIncludeWithUser,
        }),
        db.workstreamEvent.create({
          data: {
            workstreamId,
            type: "GITHUB_ACTION_TRIGGERED",
            actorType: "system",
            data: {
              workflowName: "symphony-dispatch",
              command: "plan",
              correlationId,
              artifactId,
              prdId,
              targetRepo,
              targetBranch,
            },
          },
        }),
      ]);

      return updatedArtifact;
    });
  },

  /**
   * Update artifact with placeholder content (when GitHub is not configured).
   * Creates a new version with the placeholder content.
   */
  async updateWithPlaceholder(
    id: string,
    organizationId: string,
    userId: string | null,
    content: string
  ): Promise<Artifact> {
    await artifactVersionService.createVersion(id, userId, content);

    // Update status to DRAFT
    return withDb((db) =>
      db.artifact.update({
        where: { id, organizationId },
        data: { status: "DRAFT" },
        include: artifactIncludeWithUser,
      })
    );
  },

  /**
   * Create a new version of an artifact with updated content.
   * Used when saving edits - creates v(latestVersion+1) with the new content.
   */
  async createNewVersion(
    id: string,
    organizationId: string,
    userId: string | null,
    content: string
  ): Promise<Artifact> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
        include: artifactIncludeWithUser,
      })
    );

    if (!artifact) {
      throw new ArtifactNotFoundError();
    }

    await artifactVersionService.createVersion(id, userId, content);

    // Re-fetch the artifact to get the updated latestVersion
    const updated = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
        include: artifactIncludeWithUser,
      })
    );

    return updated!;
  },

  /**
   * Regenerate an implementation plan artifact.
   * Handles all business logic: validation, workstream setup, GitHub workflow trigger.
   */
  async regenerateImplementationPlan(
    artifactId: string,
    organizationId: string,
    userId: string
  ): Promise<RegenerateResult> {
    // Find artifact with regeneration context
    const artifact = await this.findWithRegenerationContext(
      artifactId,
      organizationId
    );

    if (!artifact) {
      return { success: false, error: "Artifact not found", status: 404 };
    }

    if (artifact.type !== PrismaArtifactType.IMPLEMENTATION_PLAN) {
      return {
        success: false,
        error: "Only implementation plans can be regenerated",
        status: 400,
      };
    }

    // Find or create workstream + source PRD
    const { workstream, sourceArtifact } = await this.findOrCreateWorkstream(
      organizationId,
      artifact,
      userId
    );

    if (!(workstream || artifact.projectId)) {
      return {
        success: false,
        error: "Artifact must have a project to regenerate",
        status: 400,
      };
    }

    if (!(workstream && sourceArtifact?.content)) {
      return {
        success: false,
        error: "No PRD found to generate plan from. Create one first.",
        status: 400,
      };
    }

    const project = workstream.project;
    const existingRepository = project.repositories[0];

    // Source artifact (PRD) target repo/branch take priority, then project default
    const targetRepo =
      sourceArtifact.targetRepo ?? existingRepository?.fullName;
    const targetBranch =
      sourceArtifact.targetBranch ??
      existingRepository?.defaultBranch ??
      "main";

    if (!targetRepo) {
      return {
        success: false,
        error: "No repository configured for this project or source artifact",
        status: 400,
      };
    }

    // Ensure repository record exists
    const repoResult = await ensureRepository(
      targetRepo,
      project.id,
      existingRepository
    );
    if (!repoResult.success) {
      return { success: false, error: repoResult.error, status: 400 };
    }
    const repository = repoResult.repository;

    // Fall back to placeholder content when GitHub is not configured
    if (!isGitHubConfigured()) {
      const updatedArtifact = await this.updateWithPlaceholder(
        artifactId,
        organizationId,
        userId,
        getPlaceholderContent(artifact.title, artifact.latestVersion + 1)
      );
      return { success: true, artifact: updatedArtifact };
    }

    // Check for existing running job
    const existingRun = await this.findPendingWorkflowRun(
      workstream.id,
      "symphony-dispatch"
    );

    if (existingRun) {
      return {
        success: false,
        error: "Plan generation already in progress",
        status: 409,
      };
    }

    const correlationId = createId();

    // Build context: source artifact content + initial instructions + "assume defaults"
    // Load the plan's latest version content as initial instructions
    const latestVersion = await artifactVersionService.getLatest(artifactId);
    const context = this.buildPlanContext(
      sourceArtifact.content,
      latestVersion?.content ?? null
    );

    // Look up triggering user for commit attribution
    const committer = await getCommitterInfo(userId);

    // Trigger the workflow
    const result = await triggerWorkflowDispatch({
      targetRepo,
      ref: targetBranch,
      command: "plan",
      context,
      correlationId,
      sessionId: sourceArtifact.id,
      ...committer,
    });

    if (!result.success) {
      return {
        success: false,
        error: `Failed to trigger plan generation: ${result.error}`,
        status: 500,
      };
    }

    // Create all workflow trigger records
    const updatedArtifact = await this.createWorkflowTriggerRecords({
      organizationId,
      workstreamId: workstream.id,
      repositoryId: repository.id,
      artifactId: artifact.id,
      prdId: sourceArtifact.id,
      correlationId,
      targetRepo,
      targetBranch,
    });

    return { success: true, artifact: updatedArtifact };
  },

  /**
   * Request changes to an implementation plan.
   * Triggers the chat workflow which routes to /symphony-core:amend-plan.
   */
  async requestPlanChanges(
    artifactId: string,
    organizationId: string,
    userId: string,
    changes: string
  ): Promise<RequestChangesResult> {
    // Find artifact with context
    const artifact = await this.findWithRegenerationContext(
      artifactId,
      organizationId
    );

    if (!artifact) {
      return { success: false, error: "Artifact not found", status: 404 };
    }

    if (artifact.type !== PrismaArtifactType.IMPLEMENTATION_PLAN) {
      return {
        success: false,
        error: "Only implementation plans can be amended",
        status: 400,
      };
    }

    // Find or create workstream + source PRD
    const { workstream, sourceArtifact } = await this.findOrCreateWorkstream(
      organizationId,
      artifact,
      userId
    );

    if (!(workstream || artifact.projectId)) {
      return {
        success: false,
        error: "Artifact must have a project to request changes",
        status: 400,
      };
    }

    if (!(workstream && sourceArtifact?.content)) {
      return {
        success: false,
        error: "No PRD found for this plan. Cannot request changes.",
        status: 400,
      };
    }

    const project = workstream.project;
    const existingRepository = project.repositories[0];

    // Source artifact (PRD) target repo/branch take priority, then project default
    const targetRepo =
      sourceArtifact.targetRepo ?? existingRepository?.fullName;
    const targetBranch =
      sourceArtifact.targetBranch ??
      existingRepository?.defaultBranch ??
      "main";

    if (!targetRepo) {
      return {
        success: false,
        error: "No repository configured for this project or source artifact",
        status: 400,
      };
    }

    // Ensure repository record exists
    const repoResult = await ensureRepository(
      targetRepo,
      project.id,
      existingRepository
    );
    if (!repoResult.success) {
      return { success: false, error: repoResult.error, status: 400 };
    }
    const repository = repoResult.repository;

    // Fall back to error when GitHub is not configured (no placeholder for chat)
    if (!isGitHubConfigured()) {
      return {
        success: false,
        error:
          "GitHub Actions integration is not configured. Cannot process change requests.",
        status: 500,
      };
    }

    // Check for existing running job
    const existingRun = await this.findPendingWorkflowRun(
      workstream.id,
      "symphony-dispatch"
    );

    if (existingRun) {
      return {
        success: false,
        error: "A workflow is already in progress for this plan",
        status: 409,
      };
    }

    const correlationId = createId();

    // IMPORTANT: Create GitHubActionRun and new artifact version BEFORE triggering workflow
    // This prevents race condition where webhook fires before records exist
    await this.createChatWorkflowTriggerRecords({
      workstreamId: workstream.id,
      repositoryId: repository.id,
      artifactId,
      prdId: sourceArtifact.id,
      correlationId,
      userId,
      targetRepo,
      targetBranch,
    });

    // Build the context with a clear instruction prefix
    const context = `Amend the implementation plan with the following changes:

${changes}`;

    // Look up triggering user for commit attribution
    const committer = await getCommitterInfo(userId);

    // Now trigger the workflow - records already exist for webhook to find
    const result = await triggerWorkflowDispatch({
      targetRepo,
      ref: targetBranch,
      command: "chat",
      context,
      correlationId,
      sessionId: sourceArtifact.id, // Same session for artifact continuity
      ...committer,
    });

    if (!result.success) {
      // Workflow trigger failed - update the version with error content
      await artifactVersionService.createVersion(
        artifactId,
        userId,
        `# Change Request Failed

Failed to trigger the workflow: ${result.error}

Please try again or contact support if the issue persists.`
      );

      return {
        success: false,
        error: `Failed to trigger change request: ${result.error}`,
        status: 500,
      };
    }

    return {
      success: true,
      message: "Change request submitted",
      artifactId,
    };
  },

  /**
   * Create records for a chat/amend workflow trigger.
   * Creates a NEW artifact version to preserve the original content.
   */
  async createChatWorkflowTriggerRecords(params: {
    workstreamId: string;
    repositoryId: string;
    artifactId: string;
    prdId: string;
    correlationId: string;
    userId: string | null;
    targetRepo: string;
    targetBranch: string;
  }): Promise<void> {
    const {
      workstreamId,
      repositoryId,
      artifactId,
      prdId,
      correlationId,
      userId,
      targetRepo,
      targetBranch,
    } = params;

    // Create a new version with placeholder content (preserves original in previous version)
    await artifactVersionService.createVersion(
      artifactId,
      userId,
      "# Generating...\n\nYour change request is being processed."
    );

    // Create workflow tracking records
    await withDb(async (db) => {
      await Promise.all([
        db.gitHubActionRun.create({
          data: {
            workstreamId,
            repositoryId,
            runId: null, // Will be populated by webhook when GitHub provides the actual runId
            workflowName: "symphony-dispatch",
            status: "PENDING",
            htmlUrl: "",
            triggerEvent: "workflow_dispatch",
            triggerData: {
              correlationId: `${process.env.WEBAPP_ENV}-${correlationId}`,
              artifactId,
              prdId,
              command: "chat",
            },
            sessionId: prdId,
            jobType: "amend",
            startedAt: new Date(),
          },
        }),
        db.workstreamEvent.create({
          data: {
            workstreamId,
            type: "GITHUB_ACTION_TRIGGERED",
            actorType: "system",
            data: {
              workflowName: "symphony-dispatch",
              command: "chat",
              correlationId,
              artifactId,
              prdId,
              targetRepo,
              targetBranch,
            },
          },
        }),
      ]);
    });
  },

  /**
   * Get execution logs for an artifact from its associated GitHub Action run.
   * Downloads workflow artifacts and parses agent conversation logs.
   */
  async getExecutionLog(
    artifactId: string,
    organizationId: string
  ): Promise<ExecutionTrace> {
    try {
      const artifact = await this.findByIdSimple(artifactId, organizationId);
      if (!artifact?.workstreamId) {
        return createEmptyExecutionTrace();
      }

      // Use workstreamId + status to leverage @@index([workstreamId, status])
      // before applying the JSON path filter on triggerData
      const actionRun = await withDb((db) =>
        db.gitHubActionRun.findFirst({
          where: {
            workstreamId: artifact.workstreamId!,
            status: "SUCCESS",
            triggerData: {
              path: ["artifactId"],
              equals: artifactId,
            },
          },
          orderBy: { completedAt: "desc" },
        })
      );

      if (!actionRun?.runId) {
        return createEmptyExecutionTrace();
      }

      const artifacts = await downloadWorkflowArtifacts(
        Number(actionRun.runId)
      );

      // Find the symphony run artifact (contains .claude/runs/ with conversation logs)
      const symphonyArtifact = artifacts.find((a) =>
        SYMPHONY_RUN_ARTIFACT_PREFIXES.some((prefix) =>
          a.name.startsWith(prefix)
        )
      );

      if (!symphonyArtifact) {
        return createEmptyExecutionTrace();
      }

      return parseExecutionLogs(symphonyArtifact.data);
    } catch (error) {
      log.error("[artifacts-service] Failed to get execution log", {
        error: error instanceof Error ? error.message : String(error),
      });
      return createEmptyExecutionTrace();
    }
  },

  /**
   * Get judges feedback for an artifact from its associated GitHub Action run.
   * Downloads workflow artifacts and parses the judges.json report.
   */
  async getJudgesFeedback(
    artifactId: string,
    organizationId: string
  ): Promise<JudgesFeedbackResponse> {
    try {
      // Verify artifact exists and belongs to organization
      const artifact = await this.findByIdSimple(artifactId, organizationId);
      if (!artifact) {
        return { status: "not_found", data: null };
      }

      // Query evaluation from database
      const evaluation = await withDb((db) =>
        db.artifactEvaluation.findFirst({
          where: { artifactId },
          orderBy: { createdAt: "desc" },
        })
      );

      if (!evaluation) {
        return { status: "not_found", data: null };
      }

      const reportData = evaluation.reportData as JudgesReport;
      return { status: "success", data: reportData };
    } catch (error) {
      log.error("[artifacts-service] Failed to get judges feedback", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  /**
   * Get performance data for an artifact from the GitHubActionRunPerformance table.
   * Org-scoping is enforced via Prisma relation filter on the artifact FK.
   * Returns null when no performance data is available for the artifact.
   */
  async getPerformanceData(
    artifactId: string,
    organizationId: string
  ): Promise<PerfSummary | null> {
    // Single query: join through artifact relation to enforce org-scoping
    const perfRecord = await withDb((db) =>
      db.gitHubActionRunPerformance.findFirst({
        where: {
          artifactId,
          artifact: { organizationId },
        },
        orderBy: { createdAt: "desc" },
      })
    );

    if (!perfRecord) {
      return null;
    }

    // Safe cast: summaryData was stored by parsePerfSummary() which always
    // produces a valid PerfSummary shape. Schema drift would require a deploy.
    return perfRecord.summaryData as PerfSummary;
  },

  /**
   * Execute an approved implementation plan.
   * Triggers the symphony-dispatch workflow with command="execute" to generate code and create a PR.
   */
  async executeImplementationPlan(
    artifactId: string,
    organizationId: string,
    userId: string
  ): Promise<ExecuteResult> {
    // Check GitHub configuration first to avoid unnecessary DB operations
    if (!isGitHubConfigured()) {
      return {
        success: false,
        error:
          "GitHub Actions integration is not configured. Cannot execute plan.",
        status: 500,
      };
    }

    // Find artifact with context
    const artifact = await this.findWithRegenerationContext(
      artifactId,
      organizationId
    );

    if (!artifact) {
      return { success: false, error: "Artifact not found", status: 404 };
    }

    if (artifact.type !== PrismaArtifactType.IMPLEMENTATION_PLAN) {
      return {
        success: false,
        error: "Only implementation plans can be executed",
        status: 400,
      };
    }

    if (artifact.status !== "APPROVED") {
      return {
        success: false,
        error: "Plan must be approved before execution",
        status: 400,
      };
    }

    // Find or create workstream + source PRD
    const { workstream, sourceArtifact } = await this.findOrCreateWorkstream(
      organizationId,
      artifact,
      userId
    );

    if (!(workstream || artifact.projectId)) {
      return {
        success: false,
        error: "Artifact must have a project to execute",
        status: 400,
      };
    }

    if (!(workstream && sourceArtifact?.content)) {
      return {
        success: false,
        error: "No PRD found for this plan. Cannot execute.",
        status: 400,
      };
    }

    const project = workstream.project;
    const existingRepository = project.repositories[0];

    // Source artifact (PRD) target repo/branch take priority, then project default
    const targetRepo =
      sourceArtifact.targetRepo ?? existingRepository?.fullName;
    const targetBranch =
      sourceArtifact.targetBranch ??
      existingRepository?.defaultBranch ??
      "main";

    if (!targetRepo) {
      return {
        success: false,
        error: "No repository configured for this project or source artifact",
        status: 400,
      };
    }

    // Ensure repository record exists
    const repoResult = await ensureRepository(
      targetRepo,
      project.id,
      existingRepository
    );
    if (!repoResult.success) {
      return { success: false, error: repoResult.error, status: 400 };
    }
    const repository = repoResult.repository;

    // Check for existing running job
    const existingRun = await this.findPendingWorkflowRun(
      workstream.id,
      "symphony-dispatch"
    );

    if (existingRun) {
      return {
        success: false,
        error: "A workflow is already in progress for this plan",
        status: 409,
      };
    }

    const correlationId = createId();

    // Build context: the implementation plan content (from latest version)
    const latestVersion = await artifactVersionService.getLatest(artifactId);
    const context = latestVersion?.content ?? "";

    // Create GitHubActionRun BEFORE triggering workflow (prevent race condition)
    await withDb(async (db) => {
      await Promise.all([
        db.gitHubActionRun.create({
          data: {
            workstreamId: workstream.id,
            repositoryId: repository.id,
            runId: null, // Will be populated by webhook
            workflowName: "symphony-dispatch",
            status: "PENDING",
            htmlUrl: "",
            triggerEvent: "workflow_dispatch",
            triggerData: {
              correlationId: `${process.env.WEBAPP_ENV}-${correlationId}`,
              artifactId,
              prdId: sourceArtifact.id,
              command: "execute",
            },
            sessionId: sourceArtifact.id,
            jobType: "execute",
            startedAt: new Date(),
          },
        }),
        db.workstreamEvent.create({
          data: {
            workstreamId: workstream.id,
            type: "GITHUB_ACTION_TRIGGERED",
            actorType: "system",
            data: {
              workflowName: "symphony-dispatch",
              command: "execute",
              correlationId,
              artifactId,
              prdId: sourceArtifact.id,
              targetRepo,
              targetBranch,
            },
          },
        }),
      ]);
    });

    // Look up triggering user for commit attribution
    const committer = await getCommitterInfo(userId);

    // Trigger the workflow
    const result = await triggerWorkflowDispatch({
      targetRepo,
      ref: targetBranch,
      command: "execute",
      context,
      correlationId,
      sessionId: sourceArtifact.id,
      ...committer,
    });

    if (!result.success) {
      return {
        success: false,
        error: `Failed to trigger plan execution: ${result.error}`,
        status: 500,
      };
    }

    return {
      success: true,
      correlationId,
    };
  },

  // TODO V2: Extract rating methods to dedicated RatingService when rating expands beyond
  // Implementation Plans (trigger: artifactsService > 2000 lines OR rating on 3+ artifact types)

  /**
   * Get rating summary for an artifact (org-scoped).
   * Returns aggregate statistics and the current user's rating if one exists.
   */
  async getRating(
    artifactId: string,
    userId: string,
    organizationId: string
  ): Promise<ArtifactRatingSummary> {
    // Fetch user's rating (if exists)
    const userRating = await withDb((db) =>
      db.artifactRating.findUnique({
        where: {
          artifactId_userId_organizationId: {
            artifactId,
            userId,
            organizationId,
          },
        },
      })
    );

    // Fetch aggregate statistics (MUST filter by both artifactId AND organizationId for multi-tenant isolation)
    const aggregate = await withDb((db) =>
      db.artifactRating.aggregate({
        where: { artifactId, organizationId },
        _avg: { score: true },
        _count: true,
      })
    );

    return {
      average: aggregate._avg.score ?? 0,
      count: aggregate._count,
      userRating: userRating
        ? {
            id: userRating.id,
            userId: userRating.userId,
            score: userRating.score,
            comment: userRating.comment ?? undefined,
            artifactVersion: userRating.artifactVersion,
            createdAt: userRating.createdAt,
            updatedAt: userRating.updatedAt,
          }
        : null,
    };
  },

  /**
   * Upsert a rating for an artifact (org-scoped).
   * Creates a new rating or updates an existing one, then returns updated aggregate statistics.
   * Atomically captures artifact version at time of rating to ensure traceability.
   */
  upsertRating(
    artifactId: string,
    userId: string,
    organizationId: string,
    score: number,
    comment?: string
  ): Promise<ArtifactRatingSummary> {
    // Use transaction for atomicity: artifact version must be captured atomically
    // even if version increments during operation. Single org-scoped lookup does both
    // authorization (artifact in org) and version fetch.
    return withDb.tx(async (tx) => {
      const currentArtifact = await tx.artifact.findFirst({
        where: { id: artifactId, organizationId },
        select: { latestVersion: true },
      });

      if (!currentArtifact) {
        throw new ArtifactNotFoundError(artifactId);
      }

      // Upsert rating
      const rating = await tx.artifactRating.upsert({
        where: {
          artifactId_userId_organizationId: {
            artifactId,
            userId,
            organizationId,
          },
        },
        update: {
          score,
          comment,
          artifactVersion: currentArtifact.latestVersion,
          updatedAt: new Date(),
        },
        create: {
          artifactId,
          userId,
          organizationId,
          score,
          comment,
          artifactVersion: currentArtifact.latestVersion,
        },
      });

      // Recalculate aggregate (same logic as getRating())
      const aggregate = await tx.artifactRating.aggregate({
        where: { artifactId, organizationId },
        _avg: { score: true },
        _count: true,
      });

      return {
        average: aggregate._avg.score ?? 0,
        count: aggregate._count,
        userRating: {
          id: rating.id,
          userId: rating.userId,
          score: rating.score,
          comment: rating.comment ?? undefined,
          artifactVersion: rating.artifactVersion,
          createdAt: rating.createdAt,
          updatedAt: rating.updatedAt,
        },
      };
    });
  },

  /**
   * Reorder artifacts by setting sortOrder values atomically.
   * Validates that all artifacts belong to the user's organization.
   * Sets sortOrder to index (0-based) for each artifact in the provided array.
   *
   * @param artifactIds - Array of artifact IDs in the desired order
   * @param organizationId - Organization ID for authorization
   * @returns Array of updated artifact IDs
   */
  reorder(artifactIds: string[], organizationId: string): Promise<string[]> {
    // Early return for empty array
    if (artifactIds.length === 0) {
      return Promise.resolve([]);
    }

    // Remove duplicates while preserving order
    const uniqueIds = [...new Set(artifactIds)];

    return withDb.tx(async (tx) => {
      // Verify all artifacts exist and belong to the organization
      const artifacts = await tx.artifact.findMany({
        where: {
          id: { in: uniqueIds },
          organizationId,
        },
        select: { id: true },
      });

      // Check if any artifacts were not found or don't belong to the org
      if (artifacts.length !== uniqueIds.length) {
        const foundIds = new Set(artifacts.map((a) => a.id));
        const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
        throw new Error(
          `Invalid artifact IDs: ${missingIds.join(", ")} not found in organization`
        );
      }

      // Update sortOrder for each artifact atomically
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
   * Move multiple artifacts to a target project atomically.
   * Validates that all artifacts and the target project belong to the user's organization.
   * Updates projectId for all specified artifacts in a single transaction.
   *
   * @param artifactIds - Array of artifact IDs to move
   * @param targetProjectId - Target project ID
   * @param organizationId - Organization ID for authorization
   * @returns Array of updated artifact IDs
   */
  batchMove(
    artifactIds: string[],
    targetProjectId: string,
    organizationId: string
  ): Promise<string[]> {
    // Remove duplicates while preserving order
    const uniqueIds = [...new Set(artifactIds)];

    return withDb.tx(async (tx) => {
      // Validate target project exists and belongs to organization
      const targetProject = await tx.project.findFirst({
        where: { id: targetProjectId, organizationId },
        select: { id: true },
      });

      if (!targetProject) {
        throw new Error(
          "Invalid project ID: project not found in this organization"
        );
      }

      // Verify all artifacts exist and belong to the organization
      const artifacts = await tx.artifact.findMany({
        where: {
          id: { in: uniqueIds },
          organizationId,
        },
        select: { id: true },
      });

      // Check if any artifacts were not found or don't belong to the org
      if (artifacts.length !== uniqueIds.length) {
        const foundIds = new Set(artifacts.map((a) => a.id));
        const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
        throw new Error(
          `Invalid artifact IDs: ${missingIds.join(", ")} not found in organization`
        );
      }

      // Batch update all artifacts to the target project
      await tx.artifact.updateMany({
        where: {
          id: { in: uniqueIds },
          organizationId,
        },
        data: {
          projectId: targetProjectId,
        },
      });

      return uniqueIds;
    });
  },

  /**
   * Find all approved PRDs for a project (org-scoped).
   * Used to enumerate PRDs before batch-regenerating implementation plans.
   */
  findApprovedPrds(
    projectId: string,
    organizationId: string
  ): Promise<Artifact[]> {
    return withDb((db) =>
      db.artifact.findMany({
        where: {
          projectId,
          organizationId,
          type: PrismaArtifactType.PRD,
          status: "APPROVED",
        },
        include: artifactIncludeWithUser,
        orderBy: { createdAt: "asc" },
      })
    );
  },

  /**
   * Batch-regenerate implementation plans for all approved PRDs in a project.
   * For each PRD, finds the linked IMPLEMENTATION_PLAN artifact via EntityLink PRODUCES
   * relationships and calls regenerateImplementationPlan on it.
   * Returns the count of triggered plans and their artifact IDs.
   */
  async batchRegenerateImplementationPlans(
    projectId: string,
    organizationId: string,
    userId: string
  ): Promise<{ triggered: number; artifactIds: string[] }> {
    const prds = await this.findApprovedPrds(projectId, organizationId);

    const artifactIds: string[] = [];
    for (const prd of prds) {
      // Find the implementation plan(s) that this PRD produced via PRODUCES links
      const targetLinks = await entityLinksService.findTargetLinks(
        organizationId,
        prd.id,
        "ARTIFACT",
        LinkType.PRODUCES
      );

      if (targetLinks.length === 0) {
        continue;
      }

      // Look up the linked artifacts and find the IMPLEMENTATION_PLAN
      const linkedArtifacts = await withDb((db) =>
        db.artifact.findMany({
          where: {
            id: { in: targetLinks.map((l) => l.targetId) },
            organizationId,
            type: PrismaArtifactType.IMPLEMENTATION_PLAN,
          },
          select: { id: true },
        })
      );

      for (const plan of linkedArtifacts) {
        const result = await this.regenerateImplementationPlan(
          plan.id,
          organizationId,
          userId
        );
        if (result.success) {
          artifactIds.push(result.artifact.id);
        }
      }
    }

    return { triggered: artifactIds.length, artifactIds };
  },

  /**
   * Batch fetch artifact titles by slug (org-scoped).
   * Returns a map of slug -> title for all slugs found in the organization.
   * Slugs not found are omitted from the result.
   *
   * @param organizationId - Organization ID for authorization
   * @param slugs - Array of artifact slugs to look up (max 50)
   * @returns Map of slug to artifact title for found artifacts
   */
  batchFetchArtifactTitles(
    organizationId: string,
    slugs: string[]
  ): Promise<ArtifactTitleMap> {
    if (slugs.length === 0) {
      return Promise.resolve({});
    }
    return withDb(async (db) => {
      if (slugs.length > BATCH_META_MAX_SLUGS) {
        throw new Error(
          `batchFetchArtifactTitles: too many slugs (max ${BATCH_META_MAX_SLUGS})`
        );
      }
      const artifacts = await db.artifact.findMany({
        where: {
          organizationId,
          slug: { in: slugs },
        },
        select: { slug: true, title: true },
      });

      return Object.fromEntries(artifacts.map((a) => [a.slug, a.title]));
    });
  },

  /**
   * Find all related artifacts by traversing EntityLink relationships.
   * Returns array of artifact IDs including:
   * - All ancestors (traverse up via EntityLink sourceId to find root)
   * - All descendants (traverse down from root to find all targets)
   *
   * Handles circular references with max depth limit.
   *
   * @param artifactId - Starting artifact ID
   * @param organizationId - Organization ID for authorization
   * @returns Array of related artifact IDs (including the starting artifact)
   */
  async findRelatedArtifacts(
    artifactId: string,
    organizationId: string
  ): Promise<string[]> {
    const MAX_DEPTH = 50; // Prevent infinite loops from circular references
    const visited = new Set<string>();
    const relatedIds = new Set<string>();

    // Helper: Traverse up the EntityLink chain to find root
    async function findRoot(currentId: string, depth = 0): Promise<string> {
      if (depth > MAX_DEPTH) {
        log.error(
          "[artifacts-service] Max depth exceeded traversing up hierarchy",
          {
            artifactId: currentId,
            depth,
          }
        );
        return currentId;
      }

      if (visited.has(currentId)) {
        log.error(
          "[artifacts-service] Circular reference detected in entity link chain",
          {
            artifactId: currentId,
          }
        );
        return currentId;
      }

      visited.add(currentId);

      // Find entity link where this artifact is the target (i.e., find its source/parent)
      const parentLink = await withDb((db) =>
        db.entityLink.findFirst({
          where: {
            organizationId,
            targetId: currentId,
            targetType: "ARTIFACT",
            sourceType: "ARTIFACT",
          },
          select: { sourceId: true },
        })
      );

      if (!parentLink) {
        return currentId; // No parent link, this is the root
      }

      return findRoot(parentLink.sourceId, depth + 1);
    }

    // Helper: Traverse down to collect all descendants
    async function collectDescendants(
      currentId: string,
      depth = 0
    ): Promise<void> {
      if (depth > MAX_DEPTH) {
        log.error(
          "[artifacts-service] Max depth exceeded traversing down hierarchy",
          {
            artifactId: currentId,
            depth,
          }
        );
        return;
      }

      relatedIds.add(currentId);

      // Find entity links where this artifact is the source (i.e., find its children)
      const childLinks = await withDb((db) =>
        db.entityLink.findMany({
          where: {
            organizationId,
            sourceId: currentId,
            sourceType: "ARTIFACT",
            targetType: "ARTIFACT",
          },
          select: { targetId: true },
        })
      );

      for (const link of childLinks) {
        if (!relatedIds.has(link.targetId)) {
          await collectDescendants(link.targetId, depth + 1);
        }
      }
    }

    // Verify starting artifact exists
    const startingArtifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id: artifactId, organizationId },
        select: { id: true },
      })
    );

    if (!startingArtifact) {
      return [];
    }

    // Step 1: Find the root by traversing up
    const rootId = await findRoot(artifactId);

    // Step 2: Collect all descendants from root (including root itself)
    await collectDescendants(rootId);

    return Array.from(relatedIds);
  },
};

export type ExecuteResult =
  | { success: true; correlationId: string }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 };

export type RequestChangesResult =
  | { success: true; message: string; artifactId: string }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 };

// Type for raw Prisma result before transformation.
// Must stay in sync with artifactIncludeWithContext / artifactIncludeWithSnippet
// in artifact-utils.ts. versions is optional because findAll uses
// artifactIncludeWithSnippet (includes versions) while findById/findBySlug use
// artifactIncludeWithContext (omits versions — they load content via /versions).
type RawArtifactWithContext = Omit<Artifact, "owner" | "approver"> & {
  workstream: { id: string; title: string; state: string } | null;
  project: {
    id: string;
    organizationId: string;
    name: string;
    teams: { team: { id: string; name: string } }[];
  } | null;
  owner: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  } | null;
  approver: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
  } | null;
  versions?: { content: string | null }[];
};

/**
 * Extract a plain-text snippet from markdown content for display in list views.
 * Strips markdown syntax and collapses whitespace to a single line.
 */
function extractContentSnippet(content: string): string | null {
  const stripped = content
    .replaceAll(/```[\s\S]*?```/g, " ")
    .replaceAll(/!\[.*?\]\(.*?\)/g, "")
    .replaceAll(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replaceAll(/^#{1,6}\s+/gm, "")
    .replaceAll(/[*_`]/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  if (!stripped) {
    return null;
  }
  return stripped.length > 300 ? `${stripped.slice(0, 300)}…` : stripped;
}

/** Transform Prisma result to flatten teams structure for API response */
function toArtifactWithWorkstream(
  artifact: RawArtifactWithContext,
  maps?: {
    generationStatusMap?: Map<string, GenerationStatus>;
    pullRequestMap?: Map<string, PullRequestInfo>;
  }
): ArtifactWithWorkstream {
  const generationStatus = maps?.generationStatusMap?.get(artifact.id);
  const pullRequest = artifact.workstreamId
    ? (maps?.pullRequestMap?.get(artifact.workstreamId) ?? null)
    : null;
  const rawContent = artifact.versions?.[0]?.content ?? null;
  const snippet = rawContent ? extractContentSnippet(rawContent) : null;

  return {
    ...artifact,
    project: artifact.project
      ? {
          id: artifact.project.id,
          name: artifact.project.name,
          teams: artifact.project.teams.map((pt) => pt.team),
        }
      : null,
    ...(generationStatus && { generationStatus }),
    // Three-state contract for pullRequest:
    //   - maps omitted          → field absent (caller didn't request PR data)
    //   - maps.pullRequestMap   → field set to PullRequestInfo | null
    ...(maps && "pullRequestMap" in maps && { pullRequest }),
    ...(snippet !== null && { snippet }),
  };
}

function isGitHubConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_APP_WEBHOOK_SECRET &&
      process.env.GITHUB_APP_DISPATCH_REPO
  );
}

type RepositoryRecord = {
  id: string;
  fullName: string;
  defaultBranch: string | null;
};

/**
 * Ensures a repository record exists for the given target repo.
 * Creates one if it doesn't exist by fetching info from GitHub.
 */
async function ensureRepository(
  targetRepo: string,
  projectId: string,
  existingRepository?: RepositoryRecord
): Promise<
  | { success: true; repository: RepositoryRecord }
  | { success: false; error: string }
> {
  if (existingRepository) {
    return { success: true, repository: existingRepository };
  }

  const repoInfo = await getRepositoryInfo(targetRepo);
  if (!repoInfo) {
    return {
      success: false,
      error: `Could not fetch repository info for ${targetRepo}. Ensure the repository exists and the GitHub App has access.`,
    };
  }

  const repository = await withDb((db) =>
    db.repository.upsert({
      where: { owner_name: { owner: repoInfo.owner, name: repoInfo.name } },
      create: {
        projectId,
        githubId: repoInfo.githubId,
        owner: repoInfo.owner,
        name: repoInfo.name,
        fullName: repoInfo.fullName,
        defaultBranch: repoInfo.defaultBranch,
        isPrimary: true,
      },
      update: {},
    })
  );

  return { success: true, repository };
}

function getPlaceholderContent(title: string, version: number): string {
  return `# Implementation Plan: ${title}

## Overview

This implementation plan outlines the technical approach for ${title}.

**Version:** v${version}
**Status:** Generating...

## Note

GitHub Actions integration is not configured. This is placeholder content.
Configure the following environment variables to enable plan generation:
- GITHUB_APP_ID
- GITHUB_APP_PRIVATE_KEY
- GITHUB_APP_WEBHOOK_SECRET
- GITHUB_APP_DISPATCH_REPO
- WEBAPP_ENV
`;
}

const VALID_PR_STATES = new Set<string>(Object.values(PullRequestState));
const VALID_REVIEW_DECISIONS = new Set<string>(Object.values(ReviewDecision));

/**
 * Convert a Prisma gitHubPullRequest record to the API PullRequestInfo type.
 * Returns null if the record contains invalid enum values (e.g. a new GitHub
 * state we don't yet map) so a single bad record doesn't break batch listings.
 */
function toPullRequestInfo(pr: {
  id: string;
  number: number;
  title: string;
  htmlUrl: string;
  state: string;
  headBranch: string;
  baseBranch: string;
  createdAt: Date;
  reviewDecision: string | null;
}): PullRequestInfo | null {
  if (!VALID_PR_STATES.has(pr.state)) {
    log.warn(`Skipping PR #${pr.number}: invalid state "${pr.state}"`);
    return null;
  }
  if (
    pr.reviewDecision !== null &&
    !VALID_REVIEW_DECISIONS.has(pr.reviewDecision)
  ) {
    log.warn(
      `Skipping PR #${pr.number}: invalid review decision "${pr.reviewDecision}"`
    );
    return null;
  }
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    htmlUrl: pr.htmlUrl,
    state: pr.state as PullRequestState,
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    createdAt: pr.createdAt,
    reviewDecision: pr.reviewDecision as ReviewDecision | null,
  };
}

/** Build Map keyed by workstreamId (one PR per workstream — most recent wins). */
function buildPullRequestMap(
  records: (Parameters<typeof toPullRequestInfo>[0] & {
    workstreamId: string | null;
  })[]
): Map<string, PullRequestInfo> {
  const map = new Map<string, PullRequestInfo>();
  for (const pr of records) {
    if (pr.workstreamId && !map.has(pr.workstreamId)) {
      const mapped = toPullRequestInfo(pr);
      if (mapped) {
        map.set(pr.workstreamId, mapped);
      }
    }
  }
  return map;
}
