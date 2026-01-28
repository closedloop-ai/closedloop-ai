import { createId } from "@paralleldrive/cuid2";
import type {
  Artifact,
  ArtifactType,
  ArtifactWithWorkstream,
  CreateArtifactInput,
  PullRequestInfo,
  UpdateArtifactInput,
} from "@repo/api/src/types/artifact";
import { type Artifact as PrismaArtifact, withDb } from "@repo/database";
import { getRepositoryInfo, triggerWorkflowDispatch } from "@repo/github";
import {
  ArtifactNotFoundError,
  artifactIncludeWithContext,
  buildArtifactScopeCondition,
  createArtifactVersion,
  generateDocumentSlug,
  getOrCreateDefaultProject,
  prepareArtifactVersion,
} from "./artifact-utils";

// Result types for service operations
export type RegenerateResult =
  | { success: true; artifact: Artifact }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 };

export type FindArtifactsOptions = {
  organizationId: string;
  type?: ArtifactType;
  latestOnly?: boolean;
  workstreamId?: string;
  projectId?: string;
  documentSlug?: string;
};

export type FindWorkstreamArtifactsOptions = {
  organizationId: string;
  workstreamId: string;
  type?: ArtifactType;
  latestOnly?: boolean;
};

/**
 * Artifacts service - handles database operations for artifact management
 */
export const artifactsService = {
  /**
   * Find all artifacts with optional filters (org-scoped)
   */
  async findAll(
    options: FindArtifactsOptions
  ): Promise<ArtifactWithWorkstream[]> {
    const {
      organizationId,
      type,
      latestOnly = true,
      workstreamId,
      projectId,
      documentSlug,
    } = options;

    const artifacts = await withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId,
          ...(workstreamId ? { workstreamId } : {}),
          ...(!workstreamId && projectId ? { projectId } : {}),
          ...(type ? { type } : {}),
          ...(latestOnly ? { isLatest: true } : {}),
          ...(documentSlug ? { documentSlug } : {}),
        },
        include: artifactIncludeWithContext,
        orderBy: { createdAt: "desc" },
      })
    );
    return artifacts.map((a) =>
      toArtifactWithWorkstream(a as RawArtifactWithContext)
    );
  },

  /**
   * Find artifacts for a specific workstream
   */
  findByWorkstream(
    options: FindWorkstreamArtifactsOptions
  ): Promise<Artifact[]> {
    const { organizationId, workstreamId, type, latestOnly = false } = options;

    return withDb((db) =>
      db.artifact.findMany({
        where: {
          organizationId,
          workstreamId,
          ...(type ? { type } : {}),
          ...(latestOnly ? { isLatest: true } : {}),
        },
        orderBy: { createdAt: "desc" },
      })
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

    return toArtifactWithWorkstream(artifact as RawArtifactWithContext);
  },

  /**
   * Find an artifact by ID without context (org-scoped)
   */
  findByIdSimple(id: string, organizationId: string): Promise<Artifact | null> {
    return withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
      })
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
  create(
    organizationId: string,
    input: CreateArtifactInput
  ): Promise<Artifact> {
    return withDb.tx(async (tx) => {
      // Ensure projectId is always set for proper org-scoped queries
      let projectId: string | undefined = input.projectId;
      if (!projectId && input.workstreamId) {
        // Get projectId from workstream
        const workstream = await tx.workstream.findUnique({
          where: { id: input.workstreamId, organizationId },
          select: { projectId: true },
        });
        projectId = workstream?.projectId;
      }
      if (!projectId) {
        // Auto-create default project if still no projectId
        projectId = await getOrCreateDefaultProject(tx, organizationId);
      }

      // Auto-generate documentSlug if not provided (required for versioning)
      const documentSlug =
        input.documentSlug ?? generateDocumentSlug(input.fileName, input.title);

      // Build scope and get next version (marks existing as not latest)
      const scopeCondition = buildArtifactScopeCondition({
        organizationId,
        workstreamId: input.workstreamId,
        projectId,
        type: input.type,
        documentSlug,
      });
      const nextVersion = await prepareArtifactVersion(tx, scopeCondition);

      return tx.artifact.create({
        data: {
          ...input,
          organizationId,
          projectId,
          documentSlug,
          version: nextVersion,
          isLatest: true,
        },
      });
    });
  },

  /**
   * Create an artifact for a workstream (handles versioning)
   */
  createForWorkstream(
    organizationId: string,
    workstreamId: string,
    input: Omit<CreateArtifactInput, "workstreamId" | "projectId">
  ): Promise<Artifact> {
    return withDb.tx(async (tx) => {
      // Get projectId from workstream for proper org-scoped queries
      const workstream = await tx.workstream.findUnique({
        where: { id: workstreamId, organizationId },
        select: { projectId: true },
      });
      const projectId = workstream?.projectId;

      // Auto-generate documentSlug if not provided (required for versioning)
      const documentSlug =
        input.documentSlug ?? generateDocumentSlug(input.fileName, input.title);

      // Build scope and get next version (marks existing as not latest)
      const scopeCondition = buildArtifactScopeCondition({
        organizationId,
        workstreamId,
        projectId,
        type: input.type,
        documentSlug,
      });
      const nextVersion = await prepareArtifactVersion(tx, scopeCondition);

      return tx.artifact.create({
        data: {
          ...input,
          organizationId,
          workstreamId,
          projectId,
          documentSlug,
          version: nextVersion,
          isLatest: true,
        },
      });
    });
  },

  /**
   * Update an existing artifact.
   * Auto-increments version when content is modified.
   */
  update(
    id: string,
    organizationId: string,
    input: Omit<UpdateArtifactInput, "id">
  ): Promise<Artifact> {
    return withDb((db) =>
      db.artifact.update({
        where: { id, organizationId },
        data: input,
      })
    );
  },

  /**
   * Delete an artifact (org-scoped)
   */
  delete(id: string, organizationId: string): Promise<void> {
    return withDb(async (db) => {
      await db.artifact.delete({
        where: { id, organizationId },
      });
    });
  },

  /**
   * Find an artifact with full regeneration context (workstream, project, repositories, PRD)
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
                where: { type: "PRD", isLatest: true },
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
   * If artifact has no workstream, finds PRD by title match and auto-creates one.
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
      const prdArtifact = await withDb((db) =>
        db.artifact.findFirst({
          where: {
            organizationId,
            workstreamId: artifact.workstream?.id as string,
            type: "PRD",
            isLatest: true,
          },
        })
      );
      return { workstream: artifact.workstream, prdArtifact };
    }

    // Find PRD by parentId or matching title
    const prdTitle = artifact.title.replace("Implementation Plan: ", "");
    const foundPrd = await withDb((db) =>
      db.artifact.findFirst({
        where: {
          organizationId,
          projectId: artifact.projectId,
          type: "PRD",
          isLatest: true,
          OR: [{ id: artifact.parentId ?? undefined }, { title: prdTitle }],
        },
      })
    );

    if (!(foundPrd?.content && artifact.projectId)) {
      return { workstream: null, prdArtifact: foundPrd };
    }

    // Auto-create workstream and link artifacts
    return withDb.tx(async (tx) => {
      const newWorkstream = await tx.workstream.create({
        data: {
          organizationId,
          projectId: artifact.projectId as string,
          title: foundPrd.title,
          description: `Auto-created for: ${foundPrd.title}`,
          type: "FEATURE_DELIVERY",
          createdById: userId,
        },
      });

      // Link artifacts to workstream
      await tx.artifact.updateMany({
        where: { id: { in: [foundPrd.id, artifact.id] }, organizationId },
        data: { workstreamId: newWorkstream.id },
      });

      // Fetch workstream with relations
      const workstream = await tx.workstream.findUnique({
        where: { id: newWorkstream.id, organizationId },
        include: {
          project: {
            include: {
              repositories: { take: 1 },
            },
          },
          artifacts: { where: { type: "PRD", isLatest: true }, take: 1 },
        },
      });

      return { workstream, prdArtifact: foundPrd };
    });
  },

  /**
   * Build context for plan generation from PRD content and optional initial instructions.
   * Appends "assume defaults" instruction to skip Q&A flow.
   */
  buildPlanContext(
    prdContent: string,
    initialInstructions: string | null
  ): string {
    let context = prdContent;

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
  updateWithPlaceholder(
    id: string,
    organizationId: string,
    currentVersion: number,
    content: string
  ): Promise<Artifact> {
    return withDb((db) =>
      db.artifact.update({
        where: { id, organizationId },
        data: {
          version: currentVersion + 1,
          status: "DRAFT",
          content,
        },
      })
    );
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

    return withDb.tx((tx) => createArtifactVersion(tx, original, { content }));
  },

  /**
   * Duplicate an artifact (creates new version with "(Copy)" suffix)
   */
  async duplicate(id: string, organizationId: string): Promise<Artifact> {
    const original = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, organizationId },
      })
    );

    if (!original) {
      throw new ArtifactNotFoundError();
    }

    return withDb.tx((tx) =>
      createArtifactVersion(tx, original, {
        title: `${original.title} (Copy)`,
        fileName: original.fileName
          ? original.fileName.replace(".md", "-copy.md")
          : null,
      })
    );
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

    if (artifact.type !== "IMPLEMENTATION_PLAN") {
      return {
        success: false,
        error: "Only implementation plans can be regenerated",
        status: 400,
      };
    }

    // Find or create workstream with PRD
    const { workstream, prdArtifact } = await this.findOrCreateWorkstream(
      organizationId,
      artifact,
      userId
    );

    if (!prdArtifact?.content) {
      return {
        success: false,
        error: "No PRD found to generate plan from. Create a PRD first.",
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

    // Use PRD's target repo (fallback to project's primary)
    const targetRepo = prdArtifact.targetRepo ?? existingRepository?.fullName;
    const targetBranch =
      prdArtifact.targetBranch ?? existingRepository?.defaultBranch ?? "main";

    if (!targetRepo) {
      return {
        success: false,
        error: "No repository configured for this project or PRD",
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

    // Build context: PRD content + initial instructions + "assume defaults"
    const context = this.buildPlanContext(
      prdArtifact.content,
      artifact.content
    );

    // Trigger the workflow
    const result = await triggerWorkflowDispatch({
      targetRepo,
      ref: targetBranch,
      command: "plan",
      context,
      correlationId,
      sessionId: prdArtifact.id,
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
      prdId: prdArtifact.id,
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

    if (artifact.type !== "IMPLEMENTATION_PLAN") {
      return {
        success: false,
        error: "Only implementation plans can be amended",
        status: 400,
      };
    }

    // Find or create workstream with PRD
    const { workstream, prdArtifact } = await this.findOrCreateWorkstream(
      organizationId,
      artifact,
      userId
    );

    if (!prdArtifact) {
      return {
        success: false,
        error: "No PRD found for this plan. Cannot request changes.",
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

    // Use PRD's target repo (fallback to project's primary)
    const targetRepo = prdArtifact.targetRepo ?? existingRepository?.fullName;
    const targetBranch =
      prdArtifact.targetBranch ?? existingRepository?.defaultBranch ?? "main";

    if (!targetRepo) {
      return {
        success: false,
        error: "No repository configured for this project or PRD",
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
      prdId: prdArtifact.id,
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
      sessionId: prdArtifact.id, // Same session for artifact continuity
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
  createChatWorkflowTriggerRecords(params: {
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

    return withDb.tx(async (tx) => {
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

    if (artifact.type !== "IMPLEMENTATION_PLAN") {
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

    // Find or create workstream with PRD
    const { workstream, prdArtifact } = await this.findOrCreateWorkstream(
      organizationId,
      artifact,
      userId
    );

    if (!prdArtifact) {
      return {
        success: false,
        error: "No PRD found for this plan. Cannot execute.",
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

    // Use PRD's target repo (fallback to project's primary)
    const targetRepo = prdArtifact.targetRepo ?? existingRepository?.fullName;
    const targetBranch =
      prdArtifact.targetBranch ?? existingRepository?.defaultBranch ?? "main";

    if (!targetRepo) {
      return {
        success: false,
        error: "No repository configured for this project or PRD",
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
              prdId: prdArtifact.id,
              command: "execute",
            },
            sessionId: prdArtifact.id,
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
              prdId: prdArtifact.id,
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
      sessionId: prdArtifact.id,
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
};

export type ExecuteResult =
  | { success: true; correlationId: string }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 };

export type RequestChangesResult =
  | { success: true; message: string; artifactId: string }
  | { success: false; error: string; status: 400 | 404 | 409 | 500 };

// Type for raw Prisma result before transformation
type RawArtifactWithContext = Artifact & {
  workstream: { id: string; title: string; state: string } | null;
  project: {
    id: string;
    organizationId: string;
    name: string;
    teams: { team: { id: string; name: string } }[];
  } | null;
};

/**
 * Transform Prisma result to flatten teams structure for API response
 */
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
