import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import {
  type Artifact,
  ArtifactType,
  type DeploymentDetail,
  type Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";

/**
 * Deployment artifact service. Owns CRUD on DEPLOYMENT artifacts and their
 * 1:1 DeploymentDetail rows.
 *
 * Deployment state is carried on the parent `Artifact.status` (plain text)
 * and the vendor-specific metadata lives on DeploymentDetail. Writes go
 * through nested Prisma writes so the parent and detail rows stay
 * consistent.
 */

export type ArtifactWithDeploymentDetail = Artifact & {
  deployment: DeploymentDetail | null;
};

export type RecordDeploymentInput = {
  organizationId: string;
  projectId: string;
  workstreamId?: string | null;
  environment?: string | null;
  ref?: string | null;
  sha?: string | null;
  state: string;
  externalUrl: string;
  githubStatusUrl?: string | null;
  githubDeploymentUrl?: string | null;
  transient?: boolean | null;
  production?: boolean | null;
  pullRequestArtifactId?: string | null;
  title: string;
};

export type ListDeploymentsInput = {
  organizationId: string;
  projectId?: string;
  workstreamId?: string;
  state?: string;
};

const deploymentInclude = { deployment: true } as const;

function buildDeploymentDetailCreate(
  input: RecordDeploymentInput
): Prisma.DeploymentDetailCreateWithoutArtifactInput {
  return {
    environment: input.environment ?? null,
    ref: input.ref ?? null,
    sha: input.sha ?? null,
    githubStatusUrl: input.githubStatusUrl ?? null,
    githubDeploymentUrl: input.githubDeploymentUrl ?? null,
    transient: input.transient ?? null,
    production: input.production ?? null,
    ...(input.pullRequestArtifactId
      ? {
          pullRequestArtifact: {
            connect: { id: input.pullRequestArtifactId },
          },
        }
      : {}),
  };
}

function buildDeploymentDetailUpdate(
  input: RecordDeploymentInput
): Prisma.DeploymentDetailUpdateWithoutArtifactInput {
  const base: Prisma.DeploymentDetailUpdateWithoutArtifactInput = {
    environment: input.environment ?? null,
    ref: input.ref ?? null,
    sha: input.sha ?? null,
    githubStatusUrl: input.githubStatusUrl ?? null,
    githubDeploymentUrl: input.githubDeploymentUrl ?? null,
    transient: input.transient ?? null,
    production: input.production ?? null,
  };
  if (input.pullRequestArtifactId !== undefined) {
    base.pullRequestArtifact = input.pullRequestArtifactId
      ? { connect: { id: input.pullRequestArtifactId } }
      : { disconnect: true };
  }
  return base;
}

async function updateExistingDeployment(
  db: TransactionClient,
  artifactId: string,
  input: RecordDeploymentInput
): Promise<ArtifactWithDeploymentDetail> {
  const data: Prisma.ArtifactUpdateInput = {
    name: input.title,
    status: input.state,
    deployment: { update: buildDeploymentDetailUpdate(input) },
  };
  if (input.workstreamId !== undefined) {
    data.workstream = input.workstreamId
      ? { connect: { id: input.workstreamId } }
      : { disconnect: true };
  }
  if (input.projectId) {
    data.project = { connect: { id: input.projectId } };
  }
  const updated = await db.artifact.update({
    where: { id: artifactId },
    data,
    include: deploymentInclude,
  });
  return updated;
}

async function createDeployment(
  db: TransactionClient,
  input: RecordDeploymentInput
): Promise<ArtifactWithDeploymentDetail> {
  const created = await db.artifact.create({
    data: {
      type: ArtifactType.DEPLOYMENT,
      organizationId: input.organizationId,
      projectId: input.projectId,
      workstreamId: input.workstreamId ?? null,
      name: input.title,
      status: input.state,
      externalUrl: input.externalUrl,
      deployment: { create: buildDeploymentDetailCreate(input) },
    },
    include: deploymentInclude,
  });
  return created;
}

/**
 * Create (or update, if a deployment artifact already exists for the same
 * `externalUrl` within the org) a DEPLOYMENT artifact + DeploymentDetail
 * atomically.
 *
 * The "same externalUrl" dedup mirrors the legacy external_links upsert
 * path: Vercel (et al) reuse the preview URL for subsequent deploys to the
 * same branch, so we update in place instead of stacking rows.
 */
function recordDeployment(
  input: RecordDeploymentInput
): Promise<ArtifactWithDeploymentDetail> {
  return withDb.tx(async (db) => {
    const existing = await db.artifact.findFirst({
      where: {
        organizationId: input.organizationId,
        type: ArtifactType.DEPLOYMENT,
        externalUrl: input.externalUrl,
      },
      select: { id: true },
    });
    if (existing) {
      return updateExistingDeployment(db, existing.id, input);
    }
    return createDeployment(db, input);
  });
}

/**
 * Find a single deployment artifact + its detail by id within an
 * organization. Returns null when no matching row exists.
 */
async function findById(
  id: string,
  organizationId: string
): Promise<ArtifactWithDeploymentDetail | null> {
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: { id, organizationId, type: ArtifactType.DEPLOYMENT },
      include: deploymentInclude,
    })
  );
  return artifact;
}

/**
 * List deployment artifacts within an organization, optionally scoped by
 * project, workstream, or state.
 */
async function list(
  options: ListDeploymentsInput
): Promise<ArtifactWithDeploymentDetail[]> {
  const { organizationId, projectId, workstreamId, state } = options;
  const artifacts = await withDb((db) =>
    db.artifact.findMany({
      where: {
        organizationId,
        type: ArtifactType.DEPLOYMENT,
        ...(projectId ? { projectId } : {}),
        ...(workstreamId ? { workstreamId } : {}),
        ...(state ? { status: state } : {}),
      },
      include: deploymentInclude,
      orderBy: { createdAt: "desc" },
    })
  );
  return artifacts;
}

/**
 * Hard-delete a deployment artifact. The parent `artifact` row is the
 * system of record; DeploymentDetail and ArtifactLink rows that reference
 * it cascade automatically (see schema: `onDelete: Cascade`).
 *
 * Returns `Status.NotFound` when no deployment artifact with this id
 * exists in the caller's organization.
 */
async function deleteDeployment(
  id: string,
  organizationId: string
): Promise<Result<void, StatusCode>> {
  const { count } = await withDb((db) =>
    db.artifact.deleteMany({
      where: { id, organizationId, type: ArtifactType.DEPLOYMENT },
    })
  );
  if (count === 0) {
    return Result.err(Status.NotFound);
  }
  return Result.ok(undefined);
}

/**
 * Look up a deployment artifact + detail by the preview URL within an
 * organization.
 */
async function findByExternalUrl(
  externalUrl: string,
  organizationId: string
): Promise<ArtifactWithDeploymentDetail | null> {
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: {
        organizationId,
        type: ArtifactType.DEPLOYMENT,
        externalUrl,
      },
      include: deploymentInclude,
    })
  );
  return artifact;
}

export const deploymentService = {
  recordDeployment,
  findById,
  list,
  delete: deleteDeployment,
  findByExternalUrl,
};
