import type {
  Artifact,
  ArtifactType,
  ArtifactWithWorkstream,
  CreateArtifactInput,
  UpdateArtifactInput,
} from "@repo/api/src/types/artifact";
import { withDb } from "@repo/database";
import {
  artifactIncludeWithContext,
  buildArtifactScopeCondition,
  generateDocumentSlug,
  getOrCreateDefaultProject,
  prepareArtifactVersion,
} from "./artifact-utils";

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
  findAll(options: FindArtifactsOptions): Promise<ArtifactWithWorkstream[]> {
    const {
      organizationId,
      type,
      latestOnly = true,
      workstreamId,
      projectId,
    } = options;

    return withDb((db) =>
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
  findById(
    id: string,
    organizationId: string
  ): Promise<ArtifactWithWorkstream | null> {
    return withDb((db) =>
      db.artifact.findUnique({
        where: { id, project: { organizationId } },
        include: artifactIncludeWithContext,
      })
    );
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
      // Auto-create default project if no projectId or workstreamId provided
      let projectId: string | undefined = input.projectId;
      if (!(projectId || input.workstreamId)) {
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
      // Auto-generate documentSlug if not provided (required for versioning)
      const documentSlug =
        input.documentSlug ?? generateDocumentSlug(input.fileName, input.title);

      // Build scope and get next version (marks existing as not latest)
      const scopeCondition = buildArtifactScopeCondition({
        workstreamId,
        type: input.type,
        documentSlug,
      });
      const nextVersion = await prepareArtifactVersion(tx, scopeCondition);

      return tx.artifact.create({
        data: {
          workstreamId,
          type: input.type,
          title: input.title,
          content: input.content,
          externalUrl: input.externalUrl,
          generatedBy: input.generatedBy,
          documentSlug,
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
                    where: { isPrimary: true },
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
          status: { in: ["PENDING", "RUNNING"] },
        },
      })
    );
  },

  /**
   * Create records for a triggered workflow (action run, artifact update, event)
   */
  createWorkflowTriggerRecords(params: {
    workstreamId: string;
    repositoryId: string;
    artifactId: string;
    correlationId: string;
    currentVersion: number;
  }): Promise<Artifact> {
    const {
      workstreamId,
      repositoryId,
      artifactId,
      correlationId,
      currentVersion,
    } = params;

    return withDb(async (db) => {
      const [, updatedArtifact] = await Promise.all([
        db.gitHubActionRun.create({
          data: {
            workstreamId,
            repositoryId,
            runId: BigInt(0),
            workflowName: "symphony-dispatch",
            status: "PENDING",
            htmlUrl: "",
            triggerEvent: "workflow_dispatch",
            triggerData: {
              correlationId,
              artifactId,
              command: "plan",
            },
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
};
