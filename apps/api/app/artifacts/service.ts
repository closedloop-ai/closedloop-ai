import type {
  Artifact,
  ArtifactType,
  ArtifactWithWorkstream,
  CreateArtifactInput,
  UpdateArtifactInput,
} from "@repo/api/src/types/artifact";
import { database } from "@repo/database";
import {
  artifactIncludeWithContext,
  buildArtifactScopeCondition,
  generateDocumentSlug,
  getOrCreateDefaultProject,
  prepareArtifactVersion,
  type TransactionClient,
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

    return await database.artifact.findMany({
      where: {
        ...(type ? { type } : {}),
        ...(latestOnly ? { isLatest: true } : {}),
        ...(workstreamId ? { workstreamId } : {}),
        ...(projectId ? { projectId } : {}),
        project: { organizationId },
      },
      include: artifactIncludeWithContext,
      orderBy: { createdAt: "desc" },
    });
  },

  /**
   * Find artifacts for a specific workstream
   */
  async findByWorkstream(
    options: FindWorkstreamArtifactsOptions
  ): Promise<Artifact[]> {
    const { workstreamId, type, latestOnly = false } = options;

    return await database.artifact.findMany({
      where: {
        workstreamId,
        ...(type ? { type } : {}),
        ...(latestOnly ? { isLatest: true } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
  },

  /**
   * Find an artifact by ID with context (org-scoped)
   */
  async findById(
    id: string,
    organizationId: string
  ): Promise<ArtifactWithWorkstream | null> {
    return await database.artifact.findUnique({
      where: { id, project: { organizationId } },
      include: artifactIncludeWithContext,
    });
  },

  /**
   * Find an artifact by ID without context (org-scoped)
   */
  async findByIdSimple(
    id: string,
    organizationId: string
  ): Promise<Artifact | null> {
    return await database.artifact.findUnique({
      where: { id, project: { organizationId } },
    });
  },

  /**
   * Create a new artifact (handles versioning and default project creation)
   */
  async create(
    organizationId: string,
    input: CreateArtifactInput
  ): Promise<Artifact> {
    return await database.$transaction(async (tx) => {
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
  async createForWorkstream(
    workstreamId: string,
    input: Omit<CreateArtifactInput, "workstreamId" | "projectId">
  ): Promise<Artifact> {
    return await database.$transaction(async (tx) => {
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
  async update(
    id: string,
    organizationId: string,
    input: Omit<UpdateArtifactInput, "id">
  ): Promise<Artifact> {
    return await database.artifact.update({
      where: { id, project: { organizationId } },
      data: input,
    });
  },

  /**
   * Delete an artifact (org-scoped)
   */
  async delete(id: string, organizationId: string): Promise<void> {
    await database.artifact.delete({
      where: { id, project: { organizationId } },
    });
  },

  /**
   * Duplicate an artifact (creates new version)
   */
  async duplicate(id: string, organizationId: string): Promise<Artifact> {
    const original = await database.artifact.findUnique({
      where: { id, project: { organizationId } },
    });

    if (!original) {
      throw new Error("Artifact not found");
    }

    return await database.$transaction(async (tx: TransactionClient) => {
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
