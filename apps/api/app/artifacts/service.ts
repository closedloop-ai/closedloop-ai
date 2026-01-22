import { createId } from "@paralleldrive/cuid2";
import type {
  Artifact,
  ArtifactType,
  ArtifactWithWorkstream,
  CreateArtifactInput,
  UpdateArtifactInput,
} from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import { getRepositoryInfo, triggerWorkflowDispatch } from "@repo/github";
import {
  artifactIncludeWithContext,
  buildArtifactScopeCondition,
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
};

export type FindWorkstreamArtifactsOptions = {
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
    } = options;

    const artifacts = await withDb((db) =>
      db.artifact.findMany({
        where: {
          ...(type ? { type } : {}),
          ...(latestOnly ? { isLatest: true } : {}),
          ...(workstreamId ? { workstreamId } : {}),
          ...(projectId ? { projectId } : {}),
          project: { organizationId },
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
    const { workstreamId, type, latestOnly = false } = options;

    return withDb((db) =>
      db.artifact.findMany({
        where: {
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
        where: { id, project: { organizationId } },
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
        where: { id, project: { organizationId } },
      })
    );
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
          where: { id: input.workstreamId },
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
        workstreamId: input.workstreamId,
        projectId,
        type: input.type,
        documentSlug,
      });
      const nextVersion = await prepareArtifactVersion(tx, scopeCondition);

      return tx.artifact.create({
        data: {
          workstreamId: input.workstreamId,
          projectId,
          type: input.type,
          title: input.title,
          fileName: input.fileName,
          approver: input.approver,
          status: input.status ?? "DRAFT",
          content: input.content,
          externalUrl: input.externalUrl,
          generatedBy: input.generatedBy,
          documentSlug,
          targetRepo: input.targetRepo,
          targetBranch: input.targetBranch,
          sourcePrdId: input.sourcePrdId,
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
    workstreamId: string,
    input: Omit<CreateArtifactInput, "workstreamId" | "projectId">
  ): Promise<Artifact> {
    return withDb.tx(async (tx) => {
      // Get projectId from workstream for proper org-scoped queries
      const workstream = await tx.workstream.findUnique({
        where: { id: workstreamId },
        select: { projectId: true },
      });
      const projectId = workstream?.projectId;

      // Auto-generate documentSlug if not provided (required for versioning)
      const documentSlug =
        input.documentSlug ?? generateDocumentSlug(input.fileName, input.title);

      // Build scope and get next version (marks existing as not latest)
      const scopeCondition = buildArtifactScopeCondition({
        workstreamId,
        projectId,
        type: input.type,
        documentSlug,
      });
      const nextVersion = await prepareArtifactVersion(tx, scopeCondition);

      return tx.artifact.create({
        data: {
          workstreamId,
          projectId,
          type: input.type,
          title: input.title,
          fileName: input.fileName,
          approver: input.approver,
          status: input.status ?? "DRAFT",
          content: input.content,
          externalUrl: input.externalUrl,
          generatedBy: input.generatedBy,
          documentSlug,
          targetRepo: input.targetRepo,
          targetBranch: input.targetBranch,
          sourcePrdId: input.sourcePrdId,
          version: nextVersion,
          isLatest: true,
        },
      });
    });
  },

  /**
   * Update an existing artifact
   */
  update(
    id: string,
    organizationId: string,
    input: Omit<UpdateArtifactInput, "id">
  ): Promise<Artifact> {
    return withDb((db) =>
      db.artifact.update({
        where: { id, project: { organizationId } },
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
        where: { id, project: { organizationId } },
      });
    });
  },

  /**
   * Find an artifact with full regeneration context (workstream, project, repositories, PRD)
   */
  findWithRegenerationContext(id: string, organizationId: string) {
    return withDb((db) =>
      db.artifact.findUnique({
        where: { id, project: { organizationId } },
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
          projectId: artifact.projectId as string,
          title: foundPrd.title,
          description: `Auto-created for: ${foundPrd.title}`,
          type: "FEATURE_DELIVERY",
          createdById: userId,
        },
      });

      // Link artifacts to workstream
      await tx.artifact.updateMany({
        where: { id: { in: [foundPrd.id, artifact.id] } },
        data: { workstreamId: newWorkstream.id },
      });

      // Fetch workstream with relations
      const workstream = await tx.workstream.findUnique({
        where: { id: newWorkstream.id },
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
          where: { id: artifactId },
          data: {
            version: currentVersion + 1,
            status: "DRAFT",
            generatedBy: `symphony-dispatch:${correlationId}`,
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
    currentVersion: number,
    content: string
  ): Promise<Artifact> {
    return withDb((db) =>
      db.artifact.update({
        where: { id },
        data: {
          version: currentVersion + 1,
          status: "DRAFT",
          content,
        },
      })
    );
  },

  /**
   * Duplicate an artifact (creates new version)
   */
  async duplicate(id: string, organizationId: string): Promise<Artifact> {
    const original = await withDb((db) =>
      db.artifact.findUnique({
        where: { id, project: { organizationId } },
      })
    );

    if (!original) {
      throw new Error("Artifact not found");
    }

    return withDb.tx(async (tx) => {
      // Build scope and get next version (marks existing as not latest)
      const scopeCondition = buildArtifactScopeCondition({
        workstreamId: original.workstreamId,
        projectId: original.projectId,
        type: original.type,
        documentSlug: original.documentSlug,
      });
      const nextVersion = await prepareArtifactVersion(tx, scopeCondition);

      // Create the new duplicate (preserving documentSlug to stay in same group)
      return tx.artifact.create({
        data: {
          workstreamId: original.workstreamId,
          projectId: original.projectId,
          type: original.type,
          title: `${original.title} (Copy)`,
          fileName: original.fileName
            ? original.fileName.replace(".md", "-copy.md")
            : null,
          approver: original.approver,
          status: "DRAFT",
          content: original.content,
          externalUrl: original.externalUrl,
          generatedBy: original.generatedBy,
          documentSlug: original.documentSlug,
          version: nextVersion,
          isLatest: true,
        },
      });
    });
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
    let repository = project.repositories[0];

    // Use PRD's target repo (fallback to project's primary)
    const targetRepo = prdArtifact.targetRepo ?? repository?.fullName;
    const targetBranch =
      prdArtifact.targetBranch ?? repository?.defaultBranch ?? "main";

    if (!targetRepo) {
      return {
        success: false,
        error: "No repository configured for this project or PRD",
        status: 400,
      };
    }

    // Auto-create repository if we have a targetRepo but no linked repository
    if (!repository) {
      const repoInfo = await getRepositoryInfo(targetRepo);
      if (!repoInfo) {
        return {
          success: false,
          error: `Could not fetch repository info for ${targetRepo}. Ensure the repository exists and the GitHub App has access.`,
          status: 400,
        };
      }

      repository = await withDb((db) =>
        db.repository.upsert({
          where: { owner_name: { owner: repoInfo.owner, name: repoInfo.name } },
          create: {
            projectId: project.id,
            githubId: repoInfo.githubId,
            owner: repoInfo.owner,
            name: repoInfo.name,
            fullName: repoInfo.fullName,
            defaultBranch: repoInfo.defaultBranch,
            isPrimary: true,
          },
          update: {}, // If exists, just use it
        })
      );
    }

    // Fall back to placeholder content when GitHub is not configured
    if (!isGitHubConfigured()) {
      const updatedArtifact = await this.updateWithPlaceholder(
        artifactId,
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
};

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
    process.env.SYMPHONY_APP_ID &&
      process.env.SYMPHONY_APP_PRIVATE_KEY &&
      process.env.GITHUB_WEBHOOK_SECRET &&
      process.env.SYMPHONY_DISPATCH_REPO
  );
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
- SYMPHONY_APP_ID
- SYMPHONY_APP_PRIVATE_KEY
- GITHUB_WEBHOOK_SECRET
- SYMPHONY_DISPATCH_REPO
- WEBAPP_ENV
`;
}
