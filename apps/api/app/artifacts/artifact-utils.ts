import type { Artifact, ArtifactType } from "@repo/database";
import type { TransactionClient } from "@repo/database/generated/internal/prismaNamespace";

/**
 * Typed error for artifact not found - maps to 404 HTTP status.
 */
export class ArtifactNotFoundError extends Error {
  readonly status = 404;
  constructor(message = "Artifact not found") {
    super(message);
    this.name = "ArtifactNotFoundError";
  }
}

/**
 * Options for creating a new artifact version from an existing one.
 */
export type CreateVersionOptions = {
  /** Override the title (e.g., append "(Copy)") */
  title?: string;
  /** Override the fileName */
  fileName?: string | null;
  /** Override the content */
  content?: string | null;
};

/**
 * Create a new version of an artifact within a transaction.
 * Handles scope building, version preparation, and artifact creation.
 */
export async function createArtifactVersion(
  tx: TransactionClient,
  original: Artifact,
  options: CreateVersionOptions = {}
): Promise<Artifact> {
  const scopeCondition = buildArtifactScopeCondition({
    organizationId: original.organizationId,
    workstreamId: original.workstreamId,
    projectId: original.projectId,
    type: original.type,
    documentSlug: original.documentSlug,
  });
  const nextVersion = await prepareArtifactVersion(tx, scopeCondition);

  return tx.artifact.create({
    data: {
      organizationId: original.organizationId,
      workstreamId: original.workstreamId,
      projectId: original.projectId,
      parentId: original.parentId,
      type: original.type,
      title: options.title ?? original.title,
      fileName:
        options.fileName === undefined ? original.fileName : options.fileName,
      approver: original.approver,
      status: "DRAFT",
      content:
        options.content === undefined ? original.content : options.content,
      externalUrl: original.externalUrl,
      generatedBy: original.generatedBy,
      documentSlug: original.documentSlug,
      targetRepo: original.targetRepo,
      targetBranch: original.targetBranch,
      version: nextVersion,
      isLatest: true,
    },
  });
}

// Regex patterns for slug generation (top-level for performance)
const MD_EXTENSION_REGEX = /\.md$/;
const NON_ALPHANUMERIC_REGEX = /[^a-z0-9]+/g;
const TRIM_HYPHENS_REGEX = /^-+|-+$/g;

/**
 * Generate a document slug from fileName or title.
 * Used to uniquely identify a document for versioning purposes.
 */
export function generateDocumentSlug(
  fileName?: string | null,
  title?: string | null
): string | null {
  const source = fileName || title;
  if (!source) {
    return null;
  }

  return source
    .toLowerCase()
    .replace(MD_EXTENSION_REGEX, "")
    .replaceAll(NON_ALPHANUMERIC_REGEX, "-")
    .replaceAll(TRIM_HYPHENS_REGEX, "");
}

/**
 * Get or create a default project for standalone artifacts in the user's organization.
 */
export async function getOrCreateDefaultProject(
  tx: TransactionClient,
  organizationId: string
): Promise<string> {
  const DEFAULT_PROJECT_NAME = "Default Project";

  // Try to find existing default project in user's org
  let project = await tx.project.findFirst({
    where: {
      organizationId,
      name: DEFAULT_PROJECT_NAME,
    },
  });

  // Create default project if it doesn't exist
  project ??= await tx.project.create({
    data: {
      organizationId,
      name: DEFAULT_PROJECT_NAME,
      description: "Default project for standalone PRDs and artifacts",
    },
  });

  return project.id;
}

/**
 * Standard include pattern for artifact queries with workstream and project info.
 */
export const artifactIncludeWithContext = {
  workstream: {
    select: {
      id: true,
      title: true,
      state: true,
    },
  },
  project: {
    select: {
      id: true,
      organizationId: true,
      name: true,
      teams: {
        select: {
          team: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        take: 1,
      },
    },
  },
} as const;

/**
 * Build scope condition for artifact versioning.
 * Used to determine which artifacts share the same version group.
 */
export function buildArtifactScopeCondition(params: {
  organizationId: string;
  workstreamId?: string | null;
  projectId?: string | null;
  type: ArtifactType;
  documentSlug?: string | null;
}): {
  organizationId: string;
  workstreamId?: string;
  projectId?: string;
  type: ArtifactType;
  documentSlug: string | null;
} {
  return {
    organizationId: params.organizationId,
    ...(params.workstreamId ? { workstreamId: params.workstreamId } : {}),
    ...(!params.workstreamId && params.projectId
      ? { projectId: params.projectId }
      : {}),
    type: params.type,
    documentSlug: params.documentSlug ?? null,
  };
}

/**
 * Get the next version number for an artifact within a scope.
 * Also marks existing latest artifacts in the scope as not latest.
 */
export async function prepareArtifactVersion(
  tx: TransactionClient,
  scopeCondition: ReturnType<typeof buildArtifactScopeCondition>
): Promise<number> {
  // Mark any existing artifacts of the same type/slug as not latest
  await tx.artifact.updateMany({
    where: { ...scopeCondition, isLatest: true },
    data: { isLatest: false },
  });

  // Get the latest version number for this scope
  const latestArtifact = await tx.artifact.findFirst({
    where: scopeCondition,
    orderBy: { version: "desc" },
  });

  return (latestArtifact?.version ?? 0) + 1;
}
