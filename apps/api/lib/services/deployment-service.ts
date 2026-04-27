import {
  type Artifact,
  ArtifactType,
  type DeploymentDetail,
  type Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";

/**
 * Per-type deployment artifact service (Chunk 2a of PLN-321, decision #12).
 *
 * Owns the atomic create/update of DEPLOYMENT artifacts with their
 * DeploymentDetail row. Deployment state is carried on the parent
 * `Artifact.status` (plain text) and the vendor-specific metadata lives on
 * DeploymentDetail. Write paths go through `pullRequest`/`deployment`
 * nested Prisma writes so the pair stays consistent.
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

const deploymentInclude = { deployment: true } as const;

function runWithOptionalTx<T>(
  tx: TransactionClient | undefined,
  fn: (db: TransactionClient) => Promise<T>
): Promise<T> {
  if (tx) {
    return fn(tx);
  }
  return withDb.tx(fn);
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
  return updated as ArtifactWithDeploymentDetail;
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
  return created as ArtifactWithDeploymentDetail;
}

function recordDeployment(
  input: RecordDeploymentInput,
  tx?: TransactionClient
): Promise<ArtifactWithDeploymentDetail> {
  return runWithOptionalTx(tx, async (db) => {
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
 * Look up a deployment artifact + detail by the preview URL within an
 * organization.
 */
async function findByExternalUrl(
  externalUrl: string,
  organizationId: string,
  tx?: TransactionClient
): Promise<ArtifactWithDeploymentDetail | null> {
  const exec = (db: TransactionClient) =>
    db.artifact.findFirst({
      where: {
        organizationId,
        type: ArtifactType.DEPLOYMENT,
        externalUrl,
      },
      include: deploymentInclude,
    });
  const artifact = await (tx ? exec(tx) : withDb(exec));
  return artifact as ArtifactWithDeploymentDetail | null;
}

/**
 * Update only the deployment state on the parent artifact. Deployment state
 * lives on `Artifact.status` (plain TEXT) so vendor-specific values like
 * `success`, `failure`, `in_progress` round-trip verbatim.
 */
function updateState(
  artifactId: string,
  state: string,
  tx?: TransactionClient
): Promise<Artifact> {
  const exec = (db: TransactionClient) =>
    db.artifact.update({
      where: { id: artifactId },
      data: { status: state },
    });
  return tx ? exec(tx) : withDb.tx(exec);
}

export const deploymentService = {
  recordDeployment,
  findByExternalUrl,
  updateState,
};
