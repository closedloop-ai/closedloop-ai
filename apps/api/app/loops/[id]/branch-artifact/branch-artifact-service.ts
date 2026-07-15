import {
  BranchBaseBranchSource,
  BranchHeadShaSource,
} from "@repo/api/src/types/artifact";
import {
  type LoopBranchMaterializationEntry,
  type LoopBranchMaterializationEnvelope,
  LoopBranchMaterializationRole,
} from "@repo/api/src/types/loop-body";
import { Result, Status } from "@repo/api/src/types/result";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { z } from "zod";
import {
  branchService,
  SourceArtifactTargetRepoAuthorizationProvenance,
} from "@/app/branches/branch-service";
import { repoSchema } from "@/app/loops/validators";
import { branchMaterializationEnvelopeSchema } from "@/lib/loops/loop-branch-materialization";
import { isRunnerRequestPinnableStatus } from "@/lib/loops/loop-statuses";

const repoFullNameSchema = repoSchema.shape.fullName;
const branchNameSchema = repoSchema.shape.branch;
const gitShaSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^[a-fA-F0-9]{7,64}$/);
const legacyHeadShaSchema = z.string().trim().min(1).nullable().optional();

export const loopBranchArtifactSchema = z
  .object({
    repositoryFullName: repoFullNameSchema,
    branchName: branchNameSchema,
    defaultBranch: branchNameSchema,
    baseBranch: branchNameSchema.nullable().optional(),
    headSha: legacyHeadShaSchema,
  })
  .strict();

export type LoopBranchArtifactInput = z.infer<typeof loopBranchArtifactSchema>;

export type LoopBranchArtifactResult = {
  id: string;
};

const loopAdditionalReposSchema = z.array(repoSchema);
/**
 * Materialize a branch artifact from an authenticated loop-runner callback.
 * The loop row owns source artifact, project, and allowed repo context;
 * body-supplied source artifacts are rejected instead of trusted.
 */
export async function createLoopBranchArtifact({
  loopId,
  organizationId,
  body,
}: {
  loopId: string;
  organizationId: string;
  body: LoopBranchArtifactInput;
}): Promise<Result<LoopBranchArtifactResult>> {
  if ((body as { sourceArtifactId?: unknown }).sourceArtifactId) {
    return Result.err(Status.Forbidden);
  }

  const loop = await withDb((db) =>
    db.loop.findFirst({
      where: { id: loopId, organizationId },
      select: {
        artifactId: true,
        status: true,
        repo: true,
        additionalRepos: true,
        metadata: true,
      },
    })
  );

  if (!loop?.artifactId) {
    return Result.err(Status.NotFound);
  }
  if (!isRunnerRequestPinnableStatus(loop.status)) {
    return Result.err(Status.Forbidden);
  }

  const allowedRepoResult = findAllowedLoopRepo({
    primaryRepo: loop.repo,
    additionalRepos: loop.additionalRepos,
    repositoryFullName: body.repositoryFullName,
  });
  if (!allowedRepoResult.ok) {
    return allowedRepoResult;
  }
  const allowedRepo = allowedRepoResult.value;
  if (!allowedRepo) {
    return Result.err(Status.Forbidden);
  }
  if (body.branchName === body.defaultBranch) {
    return Result.err(Status.BadRequest);
  }

  const branchMaterializationResult = parseStoredBranchMaterialization(
    loop.metadata
  );
  if (!branchMaterializationResult.ok) {
    return branchMaterializationResult;
  }
  const materializedFields = resolveBranchMaterializationFields({
    branchMaterialization: branchMaterializationResult.value,
    body,
    allowedRepo,
  });
  if (!materializedFields.ok) {
    return materializedFields;
  }

  const repository = await withDb((db) =>
    db.gitHubInstallationRepository.findFirst({
      where: {
        fullName: allowedRepo.fullName,
        removedAt: null,
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: { id: true, fullName: true },
    })
  );
  if (!repository) {
    return Result.err(Status.Forbidden);
  }

  // Look up the source artifact's projectId — needed to scope the branch
  // artifact to the same project as the loop's source.
  const sourceArtifact = await withDb((db) =>
    db.artifact.findFirst({
      where: { id: loop.artifactId ?? undefined, organizationId },
      select: { projectId: true },
    })
  );
  if (!sourceArtifact) {
    return Result.err(Status.NotFound);
  }

  const result = await branchService.upsertBranchArtifact({
    organizationId,
    repositoryId: repository.id,
    repositoryFullName: repository.fullName,
    branchName: body.branchName,
    defaultBranch: body.defaultBranch,
    projectId: sourceArtifact.projectId,
    sourceArtifactId: loop.artifactId,
    sourceArtifactTargetRepoAuthorization: {
      provenance:
        SourceArtifactTargetRepoAuthorizationProvenance.LoopBranchArtifactCallback,
      repositoryFullNames: allowedRepo.allAllowedFullNames,
    },
    baseBranch: materializedFields.value.baseBranch,
    baseBranchSource: materializedFields.value.baseBranchSource,
    headSha: materializedFields.value.headSha,
    headShaSource: materializedFields.value.headShaSource,
  });

  return result.ok
    ? Result.ok({ id: result.value.id })
    : Result.err(result.error);
}

function findAllowedLoopRepo({
  primaryRepo,
  additionalRepos,
  repositoryFullName,
}: {
  primaryRepo: unknown;
  additionalRepos: unknown;
  repositoryFullName: string;
}): Result<
  | ({
      role: LoopBranchMaterializationRole;
      fullName: string;
      branch: string;
    } & { allAllowedFullNames: string[] })
  | null
> {
  const candidates: Array<{
    role: LoopBranchMaterializationRole;
    fullName: string;
    branch: string;
  }> = [];
  const primary = repoSchema.safeParse(primaryRepo);
  if (primary.success) {
    candidates.push({
      role: LoopBranchMaterializationRole.Primary,
      ...primary.data,
    });
  } else if (primaryRepo !== null) {
    return Result.err(Status.BadRequest);
  }
  const additional = loopAdditionalReposSchema.safeParse(additionalRepos);
  if (additional.success) {
    candidates.push(
      ...additional.data.map((repo) => ({
        role: LoopBranchMaterializationRole.Additional,
        ...repo,
      }))
    );
  } else if (additionalRepos !== null) {
    return Result.err(Status.BadRequest);
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeRepoFullName(candidate.fullName);
    if (seen.has(normalized)) {
      return Result.err(Status.BadRequest);
    }
    seen.add(normalized);
  }
  const normalizedRequested = normalizeRepoFullName(repositoryFullName);
  const allowedFullNames = candidates.map((repo) => repo.fullName);
  const match =
    candidates.find(
      (repo) => normalizeRepoFullName(repo.fullName) === normalizedRequested
    ) ?? null;
  return Result.ok(
    match ? { ...match, allAllowedFullNames: allowedFullNames } : null
  );
}

function normalizeRepoFullName(fullName: string): string {
  return fullName.trim().toLowerCase();
}

function findExpectedBranchMaterialization({
  branchMaterialization,
  role,
  repositoryFullName,
  baseBranch,
}: {
  branchMaterialization: LoopBranchMaterializationEnvelope;
  role: LoopBranchMaterializationRole;
  repositoryFullName: string;
  baseBranch: string;
}): Result<LoopBranchMaterializationEntry | null> {
  const normalizedRequested = normalizeRepoFullName(repositoryFullName);
  const matches = branchMaterialization.branches.filter(
    (branch) =>
      branch.role === role &&
      branch.baseBranch === baseBranch &&
      normalizeRepoFullName(branch.repositoryFullName) === normalizedRequested
  );
  if (matches.length > 1) {
    return Result.err(Status.BadRequest);
  }
  return Result.ok(matches[0] ?? null);
}

function parseStoredBranchMaterialization(
  metadata: unknown
): Result<LoopBranchMaterializationEnvelope | null> {
  const metadataObject =
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata)
      ? (metadata as { branchMaterialization?: unknown })
      : null;
  const stored = metadataObject?.branchMaterialization;
  if (stored === undefined) {
    return Result.ok(null);
  }
  const parsed = branchMaterializationEnvelopeSchema.safeParse(stored);
  if (!parsed.success) {
    return Result.err(Status.BadRequest);
  }
  return Result.ok(parsed.data);
}

function resolveBranchMaterializationFields({
  allowedRepo,
  body,
  branchMaterialization,
}: {
  allowedRepo: {
    role: LoopBranchMaterializationRole;
    fullName: string;
    branch: string;
  };
  body: LoopBranchArtifactInput;
  branchMaterialization: LoopBranchMaterializationEnvelope | null;
}): Result<{
  baseBranch: string | null;
  baseBranchSource: BranchBaseBranchSource | null;
  headSha: string | null;
  headShaSource: BranchHeadShaSource | null;
}> {
  if (!branchMaterialization) {
    if (allowedRepo.branch !== body.branchName) {
      return Result.err(Status.BadRequest);
    }
    return Result.ok({
      baseBranch: body.baseBranch ?? null,
      baseBranchSource: body.baseBranch
        ? BranchBaseBranchSource.HarnessInput
        : null,
      headSha: body.headSha ?? null,
      headShaSource: body.headSha ? BranchHeadShaSource.HarnessInput : null,
    });
  }

  if (!(body.baseBranch && body.headSha)) {
    return Result.err(Status.BadRequest);
  }
  const parsedHeadSha = gitShaSchema.safeParse(body.headSha);
  if (!parsedHeadSha.success) {
    return Result.err(Status.BadRequest);
  }
  if (allowedRepo.branch !== body.baseBranch) {
    return Result.err(Status.BadRequest);
  }
  const materializationResult = findExpectedBranchMaterialization({
    branchMaterialization,
    role: allowedRepo.role,
    repositoryFullName: allowedRepo.fullName,
    baseBranch: body.baseBranch,
  });
  if (!materializationResult.ok) {
    return materializationResult;
  }
  const expectedBranch = materializationResult.value;
  if (!expectedBranch || expectedBranch.branchName !== body.branchName) {
    return Result.err(Status.BadRequest);
  }

  return Result.ok({
    baseBranch: body.baseBranch,
    baseBranchSource: BranchBaseBranchSource.HarnessInput,
    headSha: parsedHeadSha.data,
    headShaSource: BranchHeadShaSource.HarnessInput,
  });
}
