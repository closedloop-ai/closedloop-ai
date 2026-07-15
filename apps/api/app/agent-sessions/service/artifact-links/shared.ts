import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import type {
  SyncedArtifactRef,
  SyncedBranchArtifactRef,
  SyncedPullRequestArtifactRef,
  SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { GitHubInstallationStatus, type Prisma } from "@repo/database";
import { parseJsonObject } from "@/lib/json-schema";
import type { AgentSessionUpsertTx } from "../records";

/**
 * Resolve all installation repos referenced by `prRefs` in a single query,
 * keyed by `fullName`. Returns an empty map when there is no installation.
 */
export function resolveRepoIdsByFullName(
  tx: AgentSessionUpsertTx,
  installationId: string | undefined,
  prRefs: SyncedSessionPrRef[]
): Promise<Map<string, string>> {
  return resolveInstallationRepoIdsByFullName(
    tx,
    installationId,
    prRefs.map((ref) => ref.repositoryFullName)
  );
}

/**
 * Merge new unresolved refs into `SessionDetail.metadata[metadataKey]`, deduped
 * by `keyFn`, so a late-syncing target is retried on a later tick rather than
 * dropped. One implementation shared by the PR and branch lanes (FEA-2729) so a
 * future ref kind doesn't add a third near-identical copy.
 */
export async function storeUnresolvedRefs<T>(
  tx: AgentSessionUpsertTx,
  sessionArtifactId: string,
  metadataKey: string,
  isValidRef: (value: unknown) => value is T,
  keyFn: (ref: T) => string,
  newRefs: readonly T[]
): Promise<void> {
  const detail = await tx.sessionDetail.findUnique({
    where: { artifactId: sessionArtifactId },
    select: { metadata: true },
  });
  const currentMetadata = parseJsonObject(detail?.metadata) ?? {};
  const existing = Array.isArray(currentMetadata[metadataKey])
    ? (currentMetadata[metadataKey] as unknown[]).filter(isValidRef)
    : [];
  const seen = new Set(existing.map(keyFn));
  const merged = [...existing];
  let added = false;
  for (const ref of newRefs) {
    const key = keyFn(ref);
    if (!seen.has(key)) {
      merged.push(ref);
      seen.add(key);
      added = true;
    }
  }
  if (!added) {
    return;
  }
  await tx.sessionDetail.update({
    where: { artifactId: sessionArtifactId },
    data: {
      metadata: {
        ...currentMetadata,
        [metadataKey]: merged,
      } as Prisma.InputJsonValue,
    },
  });
}

/** The branch-kind subset of a session's artifact refs. */
export function collectBranchRefs(
  artifactRefs: SyncedArtifactRef[] | undefined
): SyncedBranchArtifactRef[] {
  if (!artifactRefs) {
    return [];
  }
  return artifactRefs.filter(
    (ref): ref is SyncedBranchArtifactRef =>
      ref.kind === ArtifactRefTargetKind.Branch
  );
}

/** The pull_request-kind subset of a session's artifact refs (FEA-2732). */
export function collectPullRequestRefs(
  artifactRefs: SyncedArtifactRef[] | undefined
): SyncedPullRequestArtifactRef[] {
  if (!artifactRefs) {
    return [];
  }
  return artifactRefs.filter(
    (ref): ref is SyncedPullRequestArtifactRef =>
      ref.kind === ArtifactRefTargetKind.PullRequest
  );
}

/**
 * Resolve installation-repository ids for the given repo full names (org-scoped,
 * active installs only). Single source for this query — shared by the PR lane
 * (`resolveRepoIdsByFullName`) and the branch lane (`resolveBranchRepoMap`).
 */
async function resolveInstallationRepoIdsByFullName(
  tx: AgentSessionUpsertTx,
  installationId: string | undefined,
  repoFullNames: readonly string[],
  options?: { normalize?: boolean }
): Promise<Map<string, string>> {
  const repoIdByFullName = new Map<string, string>();
  if (installationId === undefined || repoFullNames.length === 0) {
    return repoIdByFullName;
  }
  // PRD-510 D2: the branch lane (`normalize: true`) keys enrichment on the same
  // normalized full name as the identity, so a desktop ref carrying `.git` or a
  // slash artifact still matches its App installation repo. The stored full_name
  // uses GitHub's canonical casing, so match case-insensitively too. The PR lane
  // keeps the exact-name match it already relied on (normalize defaults off).
  const normalize = options?.normalize ?? false;
  const names = [
    ...new Set(
      normalize ? repoFullNames.map(normalizeRepoFullName) : [...repoFullNames]
    ),
  ];
  const repos = await tx.gitHubInstallationRepository.findMany({
    where: {
      installationId,
      removedAt: null,
      installation: { status: GitHubInstallationStatus.ACTIVE },
      ...(normalize
        ? {
            OR: names.map((fullName) => ({
              fullName: { equals: fullName, mode: "insensitive" as const },
            })),
          }
        : { fullName: { in: names } }),
    },
    select: { id: true, fullName: true },
  });
  for (const repo of repos) {
    repoIdByFullName.set(
      normalize ? normalizeRepoFullName(repo.fullName) : repo.fullName,
      repo.id
    );
  }
  return repoIdByFullName;
}

/**
 * Batch-resolve the repo-id map for every branch ref across the whole payload
 * in a single org+repo round-trip (both are invariant across the batch), so the
 * per-session branch lane only issues its own branch lookup. Returns an empty
 * map when no session references a branch — no installation query is made.
 */
export async function resolveBranchRepoMap(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessions: readonly SyncedAgentSession[]
): Promise<Map<string, string>> {
  const repoFullNames = new Set<string>();
  for (const session of sessions) {
    for (const ref of collectBranchRefs(session.artifactRefs)) {
      repoFullNames.add(ref.repositoryFullName);
    }
    // FEA-2732: PR refs need the same installation-repo resolution so their
    // PullRequestDetail rows carry a repositoryId for App repos.
    for (const ref of collectPullRequestRefs(session.artifactRefs)) {
      repoFullNames.add(ref.repositoryFullName);
    }
  }
  if (repoFullNames.size === 0) {
    return new Map();
  }
  const installation = await tx.gitHubInstallation.findFirst({
    where: { organizationId },
    select: { id: true },
  });
  return resolveInstallationRepoIdsByFullName(
    tx,
    installation?.id,
    [...repoFullNames],
    { normalize: true }
  );
}
