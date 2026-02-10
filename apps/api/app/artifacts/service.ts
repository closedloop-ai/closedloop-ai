import { createId } from "@paralleldrive/cuid2";
import {
  type Artifact,
  type ArtifactWithWorkstream,
  type CreateArtifactInput,
  type FindArtifactsOptions,
  getArtifactType,
  type PreviewDeployment,
  type PullRequestInfo,
  shouldGenerateDocumentSlug,
  type UpdateArtifactInput,
} from "@repo/api/src/types/artifact";
import type {
  JudgesFeedbackResponse,
  JudgesReport,
} from "@repo/api/src/types/evaluation";
import type { ExecutionTrace } from "@repo/api/src/types/execution-log";
import type { ArtifactRatingSummary } from "@repo/api/src/types/rating";
import {
  ArtifactSubtype,
  type Artifact as PrismaArtifact,
  withDb,
} from "@repo/database";
import {
  downloadWorkflowArtifacts,
  getLatestDeploymentStatusForRef,
  getRepositoryInfo,
  triggerWorkflowDispatch,
} from "@repo/github";
import {
  createEmptyExecutionTrace,
  parseExecutionLogs,
} from "@repo/github/execution-log-parser";
import { log } from "@repo/observability/log";
import { githubService } from "@/app/integrations/github/service";
import {
  ArtifactNotFoundError,
  artifactIncludeWithContext,
  createArtifactVersion,
  generateDocumentSlug,
  previewDeploymentSelect,
} from "./artifact-utils";
import { createArtifactRoom, deleteArtifactRoom } from "./room-utils";
import { BUG_TEMPLATE, ISSUE_TEMPLATE, PRD_TEMPLATE } from "./template-seeds";

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
    const {
      organizationId,
      subtype,
      type,
      latestOnly = true,
      workstreamId,
      projectId,
      documentSlug,
      version,
    } = options;

    // Build version filter: specific version takes precedence over latestOnly
    function getVersionFilter() {
      if (version !== undefined) {
        return { version };
      }
      if (latestOnly) {
        return { isLatest: true };
      }
      return {};
    }

    const artifacts = await withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId,
          ...(workstreamId ? { workstreamId } : {}),
          ...(!workstreamId && projectId ? { projectId } : {}),
          ...(documentSlug ? { documentSlug } : {}),
          ...(subtype ? { subtype } : {}),
          ...(type ? { type } : {}),
          ...getVersionFilter(),
        },
        include: artifactIncludeWithContext,
        orderBy: { createdAt: "desc" },
      })
    );

    return artifacts.map((a) => toArtifactWithWorkstream(a));
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

    return toArtifactWithWorkstream(artifact);
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
      })
    );
    return result;
  },

  /**
   * Find an organization template for a specific artifact subtype.
   * Returns null if no template exists for the given subtype.
   * Pure read method - does NOT create templates automatically.
   */
  async findOrgTemplate(
    organizationId: string,
    templateForSubtype: ArtifactSubtype
  ): Promise<Artifact | null> {
    const result = await withDb((db) =>
      db.artifact.findUnique({
        where: {
          organizationId_templateForSubtype: {
            organizationId,
            templateForSubtype,
          },
        },
      })
    );
    return result;
  },

  /**
   * Ensure default templates exist for an organization.
   * Creates/upserts templates for PRD, Issue, and Bug subtypes.
   * Uses upsert on the unique constraint (organizationId, templateForSubtype) for concurrency safety.
   *
   * Templates have subtype=TEMPLATE with templateForSubtype pointing to the target subtype (PRD/Issue/Bug).
   * This ensures templates are queryable via `subtype: TEMPLATE` and don't pollute normal PRD/Issue/Bug queries.
   */
  async ensureDefaultTemplates(organizationId: string): Promise<void> {
    const templates = [
      {
        subtype: ArtifactSubtype.TEMPLATE,
        templateForSubtype: ArtifactSubtype.PRD,
        title: "Product Requirements Document Template",
        content: PRD_TEMPLATE,
      },
      {
        subtype: ArtifactSubtype.TEMPLATE,
        templateForSubtype: ArtifactSubtype.ISSUE,
        title: "Issue Template",
        content: ISSUE_TEMPLATE,
      },
      {
        subtype: ArtifactSubtype.TEMPLATE,
        templateForSubtype: ArtifactSubtype.BUG,
        title: "Bug Report Template",
        content: BUG_TEMPLATE,
      },
    ];

    // Use individual upserts for concurrency safety - multiple requests can run this simultaneously
    await Promise.all(
      templates.map((template) =>
        withDb((db) =>
          db.artifact.upsert({
            where: {
              organizationId_templateForSubtype: {
                organizationId,
                templateForSubtype: template.templateForSubtype,
              },
            },
            create: {
              ...template,
              type: getArtifactType(template.subtype),
              organizationId,
              documentSlug: null, // Templates are not navigable in MVP
              version: 1,
              isLatest: true,
            },
            // On conflict, do nothing - preserve existing template content
            // (user may have edited the template)
            update: {},
          })
        )
      )
    );
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
        },
      })
    );

    if (!pr) {
      return null;
    }

    // Cast state enum to literal union type
    return pr as PullRequestInfo;
  },

  /**
   * Create a new artifact (handles versioning and default project creation)
   */
  async create(
    organizationId: string,
    userId: string,
    input: CreateArtifactInput
  ): Promise<Artifact | null> {
    const isTemplate = input.subtype === ArtifactSubtype.TEMPLATE;

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

    const createdArtifact = await withDb.tx(async (tx) => {
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

      const documentSlug = shouldGenerateDocumentSlug(input.subtype)
        ? generateDocumentSlug()
        : null;

      const artifact = await tx.artifact.create({
        data: {
          ...input,
          type: getArtifactType(input.subtype),
          organizationId,
          documentSlug,
          version: 1,
          isLatest: true,
          generatedBy: userId,
          ownerId: resolvedOwnerId,
        },
      });
      return artifact;
    });

    if (createdArtifact?.documentSlug) {
      // Create Liveblocks room for document artifacts (PRDs, plans, issues, etc.)
      createArtifactRoom(createdArtifact);
    }

    return createdArtifact;
  },

  /**
   * Update an existing artifact.
   * Auto-increments version when content is modified.
   */
  async update(
    id: string,
    organizationId: string,
    input: Omit<UpdateArtifactInput, "id">
  ): Promise<Artifact> {
    if (input.ownerId) {
      await validateOwnerInOrg(input.ownerId, organizationId);
    }

    const result = await withDb((db) =>
      db.artifact.update({
        where: { id, organizationId },
        data: input,
      })
    );
    return result;
  },

  /**
   * Delete all versions of an artifact.
   */
  async delete(id: string, organizationId: string): Promise<void> {
    const result = await withDb(async (db) => {
      // First get the artifact to check for a document slug
      const artifact = await db.artifact.findUnique({
        where: { id, organizationId },
        select: {
          documentSlug: true,
          organizationId: true,
        },
      });

      if (!artifact) {
        return;
      }

      if (artifact.documentSlug) {
        // Delete all versions with the same document slug
        await db.artifact.deleteMany({
          where: {
            organizationId,
            documentSlug: artifact.documentSlug,
          },
        });
      } else {
        // No document slug means no versions - just delete this one artifact
        await db.artifact.delete({
          where: { id, organizationId },
        });
      }

      return {
        documentSlug: artifact.documentSlug,
      };
    });

    // Asynchronously delete Liveblocks room (fire and forget)
    if (result?.documentSlug) {
      deleteArtifactRoom(organizationId, result.documentSlug);
    }
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
              artifacts: {
                where: {
                  subtype: {
                    in: [
                      ArtifactSubtype.PRD,
                      ArtifactSubtype.ISSUE,
                      ArtifactSubtype.BUG,
                    ],
                  },
                  isLatest: true,
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
   * Find or create a workstream for the artifact.
   * If artifact has no workstream, finds a source artifact (PRD or Issue) and auto-creates one.
   */
  async findOrCreateWorkstream(
    organizationId: string,
    // TODO: use a real type here.
    artifact: {
      id: string;
      title: string;
      projectId: string | null;
      parentId: string | null;
      workstream: {
        id: string;
        project: {
          id: string;
          repositories: {
            id: string;
            fullName: string;
            defaultBranch: string | null;
          }[];
        };
      } | null;
    },
    userId: string
  ) {
    // If workstream exists, fetch it with project relation
    if (artifact.workstream) {
      const sourceArtifact = await withDb((db) =>
        db.artifact.findFirst({
          where: {
            organizationId,
            workstreamId: artifact.workstream?.id as string,
            subtype: {
              in: [
                ArtifactSubtype.PRD,
                ArtifactSubtype.ISSUE,
                ArtifactSubtype.BUG,
              ],
            },
            isLatest: true,
            // Prefer the explicit parent when set; fall back to any PRD/Issue/Bug in the workstream.
            ...(artifact.parentId ? { id: artifact.parentId } : {}),
          },
        })
      );
      return { workstream: artifact.workstream, sourceArtifact };
    }

    // Find PRD, Issue, or Bug by parentId or matching title.
    // Title matching is a PRD-only heuristic for legacy plans without parentId.
    const titleFallback = artifact.title.replace("Implementation Plan: ", "");
    const foundSource = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          organizationId,
          projectId: artifact.projectId,
          subtype: {
            in: [
              ArtifactSubtype.PRD,
              ArtifactSubtype.ISSUE,
              ArtifactSubtype.BUG,
            ],
          },
          isLatest: true,
          OR: [
            { id: artifact.parentId ?? undefined },
            { title: titleFallback },
          ],
        },
      })
    );

    if (!(foundSource?.content && artifact.projectId)) {
      return { workstream: null, sourceArtifact: foundSource };
    }

    // Auto-create workstream and link artifacts
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
        where: { id: { in: [foundSource.id, artifact.id] }, organizationId },
        data: { workstreamId: newWorkstream.id },
      });

      const workstream = await tx.workstream.findUnique({
        where: { id: newWorkstream.id, organizationId },
        include: {
          project: {
            include: {
              repositories: { take: 1 },
            },
          },
          artifacts: {
            where: {
              subtype: {
                in: [
                  ArtifactSubtype.PRD,
                  ArtifactSubtype.ISSUE,
                  ArtifactSubtype.BUG,
                ],
              },
              isLatest: true,
            },
            take: 1,
          },
        },
      });

      return { workstream, sourceArtifact: foundSource };
    });
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
   * Create records for a triggered workflow (action run, artifact update, event)
   */
  createWorkflowTriggerRecords(params: {
    organizationId: string;
    workstreamId: string;
    repositoryId: string;
    artifactId: string;
    prdId: string;
    correlationId: string;
    currentVersion: number;
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
      currentVersion,
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
            version: currentVersion + 1,
            status: "DRAFT",
            // Correlation tracked via GitHubActionRun.triggerData.correlationId
          },
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
   * Update artifact with placeholder content (when GitHub is not configured)
   */
  async updateWithPlaceholder(
    id: string,
    organizationId: string,
    currentVersion: number,
    content: string
  ): Promise<Artifact> {
    const result = await withDb((db) =>
      db.artifact.update({
        where: { id, organizationId },
        data: {
          version: currentVersion + 1,
          status: "DRAFT",
          content,
        },
      })
    );
    return result;
  },

  /**
   * Create a new version of an artifact with updated content.
   * Used when saving edits from an older version - creates v(max+1) with the new content.
   */
  async createNewVersion(
    id: string,
    organizationId: string,
    content: string
  ): Promise<Artifact> {
    const original = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
      })
    );

    if (!original) {
      throw new ArtifactNotFoundError();
    }

    const newVersion = await withDb.tx((tx) =>
      createArtifactVersion(tx, original, { content })
    );

    // Create Liveblocks room for the new version
    if (newVersion.documentSlug) {
      createArtifactRoom(newVersion);
    }

    return newVersion;
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

    if (artifact.subtype !== ArtifactSubtype.IMPLEMENTATION_PLAN) {
      return {
        success: false,
        error: "Only implementation plans can be regenerated",
        status: 400,
      };
    }

    // Find or create workstream with PRD or Issue
    const { workstream, sourceArtifact } = await this.findOrCreateWorkstream(
      organizationId,
      artifact,
      userId
    );

    if (!sourceArtifact?.content) {
      return {
        success: false,
        error:
          "No PRD, Issue, or Bug found to generate plan from. Create one first.",
        status: 400,
      };
    }

    if (!workstream) {
      return {
        success: false,
        error: "Artifact must have a project to regenerate",
        status: 400,
      };
    }

    const project = workstream.project;
    const existingRepository = project.repositories[0];

    // Use source artifact's target repo (fallback to project's primary)
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
        artifact.version,
        getPlaceholderContent(artifact.title, artifact.version + 1)
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
    const context = this.buildPlanContext(
      sourceArtifact.content,
      artifact.content
    );

    // Trigger the workflow
    const result = await triggerWorkflowDispatch({
      targetRepo,
      ref: targetBranch,
      command: "plan",
      context,
      correlationId,
      sessionId: sourceArtifact.id,
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
      currentVersion: artifact.version,
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

    if (artifact.subtype !== ArtifactSubtype.IMPLEMENTATION_PLAN) {
      return {
        success: false,
        error: "Only implementation plans can be amended",
        status: 400,
      };
    }

    // Find or create workstream with PRD or Issue
    const { workstream, sourceArtifact } = await this.findOrCreateWorkstream(
      organizationId,
      artifact,
      userId
    );

    if (!sourceArtifact) {
      return {
        success: false,
        error:
          "No PRD, Issue, or Bug found for this plan. Cannot request changes.",
        status: 400,
      };
    }

    if (!workstream) {
      return {
        success: false,
        error: "Artifact must have a project to request changes",
        status: 400,
      };
    }

    const project = workstream.project;
    const existingRepository = project.repositories[0];

    // Use source artifact's target repo (fallback to project's primary)
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

    // Update artifact with current workstream ID (may have been set by findOrCreateWorkstream)
    const artifactForVersion = {
      ...artifact,
      workstreamId: workstream.id,
      projectId: artifact.projectId ?? workstream.project.id,
    };

    // IMPORTANT: Create GitHubActionRun and new artifact version BEFORE triggering workflow
    // This prevents race condition where webhook fires before records exist
    const newArtifact = await this.createChatWorkflowTriggerRecords({
      workstreamId: workstream.id,
      repositoryId: repository.id,
      artifact: artifactForVersion as PrismaArtifact,
      prdId: sourceArtifact.id,
      correlationId,
      targetRepo,
      targetBranch,
    });

    // Build the context with a clear instruction prefix
    const context = `Amend the implementation plan with the following changes:

${changes}`;

    // Now trigger the workflow - records already exist for webhook to find
    const result = await triggerWorkflowDispatch({
      targetRepo,
      ref: targetBranch,
      command: "chat",
      context,
      correlationId,
      sessionId: sourceArtifact.id, // Same session for artifact continuity
    });

    if (!result.success) {
      // Workflow trigger failed - update the artifact with error status
      // The GitHubActionRun will remain in PENDING but that's acceptable
      await withDb((db) =>
        db.artifact.update({
          where: { id: newArtifact.id },
          data: {
            content: `# Change Request Failed

Failed to trigger the workflow: ${result.error}

Please try again or contact support if the issue persists.`,
          },
        })
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
      artifactId: newArtifact.id,
    };
  },

  /**
   * Create records for a chat/amend workflow trigger.
   * Creates a NEW artifact version to preserve the original content.
   */
  async createChatWorkflowTriggerRecords(params: {
    workstreamId: string;
    repositoryId: string;
    artifact: PrismaArtifact;
    prdId: string;
    correlationId: string;
    targetRepo: string;
    targetBranch: string;
  }): Promise<PrismaArtifact> {
    const {
      workstreamId,
      repositoryId,
      artifact,
      prdId,
      correlationId,
      targetRepo,
      targetBranch,
    } = params;

    const newArtifact = await withDb.tx(async (tx) => {
      // Create a NEW artifact version (preserves original content in previous version)
      const newArtifact = await createArtifactVersion(tx, artifact, {
        // Content starts empty - will be populated by webhook when workflow completes
        // This ensures original content is preserved in the previous version
        content: "# Generating...\n\nYour change request is being processed.",
      });

      // Note: Correlation tracked via GitHubActionRun.triggerData.correlationId
      // No need to update generatedBy (it's a UUID field, not for correlation strings)

      // Create workflow tracking records
      await Promise.all([
        tx.gitHubActionRun.create({
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
              artifactId: newArtifact.id, // Reference the NEW version
              prdId,
              command: "chat",
            },
            sessionId: prdId,
            jobType: "amend",
            startedAt: new Date(),
          },
        }),
        tx.workstreamEvent.create({
          data: {
            workstreamId,
            type: "GITHUB_ACTION_TRIGGERED",
            actorType: "system",
            data: {
              workflowName: "symphony-dispatch",
              command: "chat",
              correlationId,
              artifactId: newArtifact.id,
              prdId,
              targetRepo,
              targetBranch,
            },
          },
        }),
      ]);

      return newArtifact;
    });

    // Create Liveblocks room for the new version after transaction commits
    if (newArtifact.documentSlug) {
      createArtifactRoom(newArtifact);
    }

    return newArtifact;
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
        Number(actionRun.runId),
        "execution-logs"
      );

      if (artifacts.length === 0 || !artifacts[0]) {
        return createEmptyExecutionTrace();
      }

      return parseExecutionLogs(artifacts[0].data);
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
   * Get the preview deployment for an artifact.
   */
  async getArtifactPreviewDeployment(
    artifactId: string,
    organizationId: string
  ): Promise<PreviewDeployment | null> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id: artifactId, organizationId },
        include: {
          previewDeployment: {
            select: previewDeploymentSelect,
          },
        },
      })
    );

    return toPreviewDeploymentFromArtifact(artifact?.previewDeployment ?? null);
  },

  /**
   * Refresh preview deployment status by fetching latest from GitHub.
   * Returns updated PreviewDeployment or null if no deployment info available.
   */
  async refreshPreviewDeployment(
    artifactId: string,
    organizationId: string
  ): Promise<PreviewDeployment | null> {
    const artifact = await withDb((db) =>
      db.artifact.findUnique({
        where: { id: artifactId, organizationId },
        include: {
          previewDeployment: true,
          workstream: {
            include: {
              project: {
                include: { repositories: { take: 1 } },
              },
            },
          },
        },
      })
    );

    if (!artifact?.previewDeployment?.ref) {
      return toPreviewDeploymentFromArtifact(
        artifact?.previewDeployment ?? null
      );
    }

    const repoFullName =
      artifact.targetRepo ??
      artifact.workstream?.project?.repositories?.[0]?.fullName;

    if (!repoFullName) {
      return toPreviewDeploymentFromArtifact(artifact.previewDeployment);
    }

    const installationId = await githubService.findInstallationForRepoFullName(
      organizationId,
      repoFullName
    );
    let deploymentStatus = await getLatestDeploymentStatusForRef(
      repoFullName,
      artifact.previewDeployment.ref,
      {
        installationId: installationId ?? undefined,
        environment: "preview",
      }
    );
    if (!deploymentStatus) {
      deploymentStatus = await getLatestDeploymentStatusForRef(
        repoFullName,
        artifact.previewDeployment.ref,
        {
          installationId: installationId ?? undefined,
          environment: undefined,
        }
      );
    }

    if (!deploymentStatus) {
      return toPreviewDeploymentFromArtifact(artifact.previewDeployment);
    }

    const updated = await withDb((db) =>
      db.previewDeployment.update({
        where: { artifactId },
        data: {
          url: deploymentStatus.url,
          state: deploymentStatus.state,
          environment: deploymentStatus.environment,
          updatedAt: deploymentStatus.updatedAt
            ? new Date(deploymentStatus.updatedAt)
            : new Date(),
        },
        select: previewDeploymentSelect,
      })
    );

    return toPreviewDeploymentFromArtifact(updated);
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

    if (artifact.subtype !== ArtifactSubtype.IMPLEMENTATION_PLAN) {
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

    // Find or create workstream with PRD or Issue
    const { workstream, sourceArtifact } = await this.findOrCreateWorkstream(
      organizationId,
      artifact,
      userId
    );

    if (!sourceArtifact) {
      return {
        success: false,
        error: "No PRD, Issue, or Bug found for this plan. Cannot execute.",
        status: 400,
      };
    }

    if (!workstream) {
      return {
        success: false,
        error: "Artifact must have a project to execute",
        status: 400,
      };
    }

    const project = workstream.project;
    const existingRepository = project.repositories[0];

    // Use source artifact's target repo (fallback to project's primary)
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

    // Build context: the implementation plan content
    const context = artifact.content ?? "";

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

    // Trigger the workflow
    const result = await triggerWorkflowDispatch({
      targetRepo,
      ref: targetBranch,
      command: "execute",
      context,
      correlationId,
      sessionId: sourceArtifact.id,
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

  // TODO V2: Extract rating methods to dedicated RatingService when rating expands beyond Implementation Plans (trigger: artifactsService > 2000 lines OR rating on 3+ artifact types)
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
        select: { version: true },
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
          artifactVersion: currentArtifact.version,
          updatedAt: new Date(),
        },
        create: {
          artifactId,
          userId,
          organizationId,
          score,
          comment,
          artifactVersion: currentArtifact.version,
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
};

export type ExecuteResult =
  | { success: true; correlationId: string }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 };

export type RequestChangesResult =
  | { success: true; message: string; artifactId: string }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 };

// Type for raw Prisma result before transformation.
// Must stay in sync with artifactIncludeWithContext in artifact-utils.ts.
type RawArtifactWithContext = Artifact & {
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
  parent: {
    id: string;
    title: string;
    subtype: ArtifactSubtype;
    documentSlug: string | null;
  } | null;
  previewDeployment: {
    url: string | null;
    state: string | null;
    environment: string | null;
    ref: string | null;
    sha: string | null;
    updatedAt: Date | null;
  } | null;
};

/** Transform Prisma result to flatten teams structure for API response */
function toArtifactWithWorkstream(
  artifact: RawArtifactWithContext
): ArtifactWithWorkstream {
  return {
    ...artifact,
    project: artifact.project
      ? {
          id: artifact.project.id,
          name: artifact.project.name,
          teams: artifact.project.teams.map((pt) => pt.team),
        }
      : null,
    previewDeployment: toPreviewDeploymentFromArtifact(
      artifact.previewDeployment
    ),
  };
}

function toPreviewDeploymentFromArtifact(
  pd: RawArtifactWithContext["previewDeployment"]
): PreviewDeployment | null {
  if (!pd) {
    return null;
  }
  return {
    url: pd.url,
    state: pd.state,
    environment: pd.environment,
    ref: pd.ref,
    sha: pd.sha,
    updatedAt: pd.updatedAt,
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
