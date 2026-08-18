import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  normalizePersistedRepositoryDefaultAuthority,
} from "@repo/api/src/types/repository-default-identity";
import type {
  SyncedArtifactRef,
  SyncedBranchArtifactRef,
  SyncedBranchLifecycleEvent,
  SyncedPullRequestArtifactRef,
  SyncedSessionPrRef,
} from "@repo/api/src/types/session-artifact-link";
import {
  ArtifactRefTargetKind,
  MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS,
  syncedBranchLifecycleEventSchema,
} from "@repo/api/src/types/session-artifact-link";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { GitHubInstallationStatus, Prisma } from "@repo/database";
import { parseJsonObject } from "@/lib/json-schema";
import type { AgentSessionUpsertTx } from "../records";

/** Server-owned repository identity and default authority resolved once per sync payload. */
export type SessionBranchRepositoryAuthority = {
  repositoryId: string | null;
  providerRepositoryId?: string;
  identityConflict?: boolean;
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[];
};

export type SessionBranchRepositoryAuthorityMap = Map<
  string,
  SessionBranchRepositoryAuthority
>;

/**
 * Resolve all installation repos referenced by `prRefs` in a single query,
 * keyed by `fullName`. Returns an empty map when there is no installation.
 */
export function resolveRepoIdsByFullName(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  prRefs: SyncedSessionPrRef[]
): Promise<Map<string, string>> {
  return resolveInstallationRepoIdsByFullName(
    tx,
    organizationId,
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
      ref.kind === ArtifactRefTargetKind.Branch &&
      ref.monitoredActivityOnly !== true
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
      ref.kind === ArtifactRefTargetKind.PullRequest &&
      ref.monitoredActivityOnly !== true
  );
}

export function readBranchLifecycleEventsFromMetadata(
  metadata: unknown
): SyncedBranchLifecycleEvent[] {
  const object = parseJsonObject(metadata);
  const events = object?.branchLifecycleEvents;
  if (!Array.isArray(events)) {
    return [];
  }
  const valid: SyncedBranchLifecycleEvent[] = [];
  for (const event of events) {
    const parsed = syncedBranchLifecycleEventSchema.safeParse(event);
    if (parsed.success) {
      valid.push(parsed.data);
    }
  }
  return valid;
}

export function mergeBranchLifecycleEvents(
  ...groups: readonly (readonly SyncedBranchLifecycleEvent[] | undefined)[]
): SyncedBranchLifecycleEvent[] {
  // `evidenceId` is the DURABLE identity of one lifecycle boundary (e.g.
  // `desktop-artifact-link:<linkId>`, stable across re-derivation); `kind` is
  // its MUTABLE classification. When a session re-syncs after the desktop
  // extractor corrects a PR-review method (FEA-3851), the same boundary arrives
  // with a new `kind` (e.g. ReviewFeedback → ReadOnlyReference) under the same
  // `evidenceId`. Keying purely on `kind|observedAt|evidenceId` would keep BOTH
  // — leaving the stale ReviewFeedback beside the corrected read-only event — so
  // an evidence-bearing event REPLACES any earlier one with the same
  // `evidenceId`, last-group-wins. Evidence-less events (no durable id) keep the
  // composite-key dedupe so distinct boundaries don't collapse into one.
  const byEvidenceId = new Map<string, SyncedBranchLifecycleEvent>();
  const evidenceOrder: string[] = [];
  const evidencelessOrder: SyncedBranchLifecycleEvent[] = [];
  const seenEvidenceless = new Set<string>();
  for (const group of groups) {
    for (const event of group ?? []) {
      if (event.evidenceId === undefined) {
        const key = branchLifecycleEventKey(event);
        if (!seenEvidenceless.has(key)) {
          seenEvidenceless.add(key);
          evidencelessOrder.push(event);
        }
        continue;
      }
      if (!byEvidenceId.has(event.evidenceId)) {
        evidenceOrder.push(event.evidenceId);
      }
      byEvidenceId.set(event.evidenceId, event);
    }
  }
  const merged: SyncedBranchLifecycleEvent[] = [...evidencelessOrder];
  for (const evidenceId of evidenceOrder) {
    const event = byEvidenceId.get(evidenceId);
    if (event) {
      merged.push(event);
    }
  }
  return merged
    .sort(compareBranchLifecycleEvents)
    .slice(-MAX_SYNCED_BRANCH_LIFECYCLE_EVENTS)
    .sort(compareBranchLifecycleEvents);
}

/**
 * Resolve installation-repository ids for the given repo full names (org-scoped,
 * active installs only). Single source for this query — shared by the PR lane
 * (`resolveRepoIdsByFullName`) and the branch lane (`resolveBranchRepoMap`).
 */
async function resolveInstallationRepoIdsByFullName(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  repoFullNames: readonly string[]
): Promise<Map<string, string>> {
  const repoIdByFullName = new Map<string, string>();
  if (repoFullNames.length === 0) {
    return repoIdByFullName;
  }
  const names = [...new Set(repoFullNames)];
  const ambiguousNames = new Set<string>();
  for (const nameChunk of chunksOf(names, REPOSITORY_NAME_QUERY_CHUNK_SIZE)) {
    const repos = await tx.gitHubInstallationRepository.findMany({
      where: {
        removedAt: null,
        fullName: { in: nameChunk },
        installation: {
          organizationId,
          status: GitHubInstallationStatus.ACTIVE,
        },
      },
      select: { id: true, fullName: true },
    });
    for (const repo of repos) {
      const existingId = repoIdByFullName.get(repo.fullName);
      if (existingId && existingId !== repo.id) {
        ambiguousNames.add(repo.fullName);
        repoIdByFullName.delete(repo.fullName);
      } else if (!ambiguousNames.has(repo.fullName)) {
        repoIdByFullName.set(repo.fullName, repo.id);
      }
    }
  }
  return repoIdByFullName;
}

function branchLifecycleEventKey(event: SyncedBranchLifecycleEvent): string {
  return `${event.kind}|${event.observedAt ?? ""}|${event.evidenceId ?? ""}`;
}

function compareBranchLifecycleEvents(
  left: SyncedBranchLifecycleEvent,
  right: SyncedBranchLifecycleEvent
): number {
  const leftTime = timestampSortValue(left.observedAt);
  const rightTime = timestampSortValue(right.observedAt);
  if (leftTime !== rightTime) {
    return leftTime < rightTime ? -1 : 1;
  }
  return branchLifecycleEventKey(left).localeCompare(
    branchLifecycleEventKey(right)
  );
}

function timestampSortValue(value: string | undefined): number {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Batch-resolve server-owned repository identity and default authority for
 * every branch/PR ref in the supplied session slice. Active installation and
 * org-scoped public rows are read in bounded chunks and locked until the write
 * transaction completes. Returns an empty map without querying repositories
 * when no refs need it.
 */
export async function resolveBranchRepoMap(
  tx: Pick<AgentSessionUpsertTx, "$queryRaw">,
  organizationId: string,
  sessions: readonly SyncedAgentSession[]
): Promise<SessionBranchRepositoryAuthorityMap> {
  const normalizedNames = collectNormalizedRepositoryNames(sessions);
  const identityOnlyNames = collectIdentityOnlyRepositoryNames(
    sessions,
    normalizedNames
  );
  if (normalizedNames.length === 0 && identityOnlyNames.length === 0) {
    return new Map();
  }
  const [authorityRows, identityRows] = await Promise.all([
    readLockedAuthorityRows(tx, organizationId, normalizedNames),
    readLockedIdentityRows(tx, organizationId, identityOnlyNames),
  ]);
  const resolved = reconcileAuthorityRows(authorityRows);
  mergeIdentityOnlyRows(resolved, identityRows);
  return resolved;
}

/**
 * Identity-only counterpart to `readLockedAuthorityRows`: the installation
 * lookup alone, without the two default-branch authority queries.
 *
 * `reconcileAuthorityRows` only ever takes `repositoryId` from the installation
 * rows — the public and PR-head rows contribute `repositoryId: null` — so this
 * one query is the whole of what an identity-only name needs. Same org scope,
 * chunking, and `FOR SHARE` lock as the authority read, so a resolved id cannot
 * be relinked out from under the write that follows.
 */
async function readLockedIdentityRows(
  tx: Pick<AgentSessionUpsertTx, "$queryRaw">,
  organizationId: string,
  normalizedNames: readonly string[]
): Promise<SessionRepositoryIdentityRow[]> {
  const rows: SessionRepositoryIdentityRow[] = [];
  for (const nameChunk of chunksOf(
    normalizedNames,
    REPOSITORY_NAME_QUERY_CHUNK_SIZE
  )) {
    const names = Prisma.join(nameChunk);
    const chunkRows = await tx.$queryRaw<SessionRepositoryIdentityRow[]>(
      Prisma.sql`
        SELECT
          repository.id,
          repository.github_repo_id AS "githubRepoId",
          repository.full_name AS "fullName"
        FROM github_installation_repositories repository
        INNER JOIN github_installations installation
          ON installation.id = repository.installation_id
        WHERE installation.organization_id = ${organizationId}
          AND installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
          AND repository.removed_at IS NULL
          AND LOWER(repository.full_name) IN (${names})
        FOR SHARE OF repository, installation
      `
    );
    rows.push(...chunkRows);
  }
  return rows;
}

/**
 * Fold identity-only rows into the resolved map with NO authority evidence.
 *
 * These names were never read for default-branch authority, so they carry
 * `authorities: []` — an empty list here means "not looked up", and it must not
 * be mistaken for "looked up and found none". Nothing else reads them: by
 * construction they have neither a branch ref nor a PR-lane ref, so the only
 * consumer is the residual PR resolver's `repositoryId` lookup. Two ACTIVE
 * installs claiming one full name is the same unresolvable identity the
 * authority reconciler flags, so it is marked the same way and the id is
 * dropped rather than picked arbitrarily.
 */
function mergeIdentityOnlyRows(
  resolved: SessionBranchRepositoryAuthorityMap,
  identityRows: readonly SessionRepositoryIdentityRow[]
): void {
  for (const row of identityRows) {
    const normalizedFullName = normalizeRepoFullName(row.fullName);
    const existing = resolved.get(normalizedFullName);
    if (!existing) {
      resolved.set(normalizedFullName, {
        repositoryId: row.id,
        ...(row.githubRepoId?.trim()
          ? { providerRepositoryId: row.githubRepoId.trim() }
          : {}),
        authorities: [],
      });
      continue;
    }
    if (existing.repositoryId !== row.id) {
      resolved.set(normalizedFullName, {
        repositoryId: null,
        identityConflict: true,
        authorities: [],
      });
    }
  }
}

async function readLockedAuthorityRows(
  tx: Pick<AgentSessionUpsertTx, "$queryRaw">,
  organizationId: string,
  normalizedNames: readonly string[]
): Promise<SessionAuthoritySourceRow[]> {
  const installationRepositories: SessionRepositoryAuthorityRow[] = [];
  const publicRepositories: SessionRepositoryAuthorityRow[] = [];
  const pullRequestRepositories: SessionRepositoryAuthorityRow[] = [];
  for (const nameChunk of chunksOf(
    normalizedNames,
    REPOSITORY_NAME_QUERY_CHUNK_SIZE
  )) {
    const names = Prisma.join(nameChunk);
    const [installedChunk, publicChunk, pullRequestChunk] = await Promise.all([
      tx.$queryRaw<SessionRepositoryAuthorityRow[]>(Prisma.sql`
        SELECT
          repository.id,
          repository.github_repo_id AS "githubRepoId",
          repository.full_name AS "fullName",
          repository.default_branch_name AS "defaultBranchName",
          repository.default_branch_availability AS "defaultBranchAvailability",
          repository.default_branch_completeness AS "defaultBranchCompleteness",
          repository.default_branch_reason AS "defaultBranchReason",
          repository.default_branch_source AS "defaultBranchSource",
          repository.default_branch_mechanism AS "defaultBranchMechanism",
          repository.default_branch_trigger AS "defaultBranchTrigger",
          repository.default_branch_credential_type AS "defaultBranchCredentialType",
          repository.default_branch_credential_owner_id AS "defaultBranchCredentialOwnerId",
          repository.default_branch_observation_key AS "defaultBranchObservationKey",
          repository.default_branch_observed_at AS "defaultBranchObservedAt",
          repository.default_branch_event_at AS "defaultBranchEventAt"
        FROM github_installation_repositories repository
        INNER JOIN github_installations installation
          ON installation.id = repository.installation_id
        WHERE installation.organization_id = ${organizationId}
          AND installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
          AND repository.removed_at IS NULL
          AND LOWER(repository.full_name) IN (${names})
        FOR SHARE OF repository, installation
      `),
      tx.$queryRaw<SessionRepositoryAuthorityRow[]>(Prisma.sql`
        SELECT
          repository.id,
          repository.github_repo_id AS "githubRepoId",
          repository.full_name AS "fullName",
          repository.default_branch_name AS "defaultBranchName",
          repository.default_branch_availability AS "defaultBranchAvailability",
          repository.default_branch_completeness AS "defaultBranchCompleteness",
          repository.default_branch_reason AS "defaultBranchReason",
          repository.default_branch_source AS "defaultBranchSource",
          repository.default_branch_mechanism AS "defaultBranchMechanism",
          repository.default_branch_trigger AS "defaultBranchTrigger",
          repository.default_branch_credential_type AS "defaultBranchCredentialType",
          repository.default_branch_credential_owner_id AS "defaultBranchCredentialOwnerId",
          repository.default_branch_observation_key AS "defaultBranchObservationKey",
          repository.default_branch_observed_at AS "defaultBranchObservedAt",
          repository.default_branch_event_at AS "defaultBranchEventAt"
        FROM public_repositories repository
        WHERE repository.organization_id = ${organizationId}
          AND LOWER(repository.full_name) IN (${names})
        FOR SHARE OF repository
      `),
      tx.$queryRaw<SessionRepositoryAuthorityRow[]>(Prisma.sql`
        WITH candidate_authorities AS (
          SELECT
            pull_request.id,
            COALESCE(
              pull_request.head_repository_default_branch_event_at,
              pull_request.head_repository_default_branch_observed_at
            ) AS authority_at,
            MAX(COALESCE(
              pull_request.head_repository_default_branch_event_at,
              pull_request.head_repository_default_branch_observed_at
            )) OVER (
              PARTITION BY LOWER(pull_request.head_repository_full_name)
            ) AS latest_authority_at
          FROM pull_request_detail pull_request
          WHERE pull_request.organization_id = ${organizationId}
            AND LOWER(pull_request.head_repository_full_name) IN (${names})
            AND (
              pull_request.head_repository_default_branch_name IS NOT NULL
              OR pull_request.head_repository_default_branch_availability IS NOT NULL
              OR pull_request.head_repository_default_branch_completeness IS NOT NULL
              OR pull_request.head_repository_default_branch_reason IS NOT NULL
              OR pull_request.head_repository_default_branch_source IS NOT NULL
              OR pull_request.head_repository_default_branch_mechanism IS NOT NULL
              OR pull_request.head_repository_default_branch_trigger IS NOT NULL
              OR pull_request.head_repository_default_branch_credential_type IS NOT NULL
              OR pull_request.head_repository_default_branch_credential_owner_id IS NOT NULL
              OR pull_request.head_repository_default_branch_observation_key IS NOT NULL
              OR pull_request.head_repository_default_branch_observed_at IS NOT NULL
              OR pull_request.head_repository_default_branch_event_at IS NOT NULL
            )
        )
        SELECT
          pull_request.id,
          pull_request.head_repository_github_id AS "githubRepoId",
          pull_request.head_repository_full_name AS "fullName",
          pull_request.head_repository_default_branch_name AS "defaultBranchName",
          pull_request.head_repository_default_branch_availability AS "defaultBranchAvailability",
          pull_request.head_repository_default_branch_completeness AS "defaultBranchCompleteness",
          pull_request.head_repository_default_branch_reason AS "defaultBranchReason",
          pull_request.head_repository_default_branch_source AS "defaultBranchSource",
          pull_request.head_repository_default_branch_mechanism AS "defaultBranchMechanism",
          pull_request.head_repository_default_branch_trigger AS "defaultBranchTrigger",
          pull_request.head_repository_default_branch_credential_type AS "defaultBranchCredentialType",
          pull_request.head_repository_default_branch_credential_owner_id AS "defaultBranchCredentialOwnerId",
          pull_request.head_repository_default_branch_observation_key AS "defaultBranchObservationKey",
          pull_request.head_repository_default_branch_observed_at AS "defaultBranchObservedAt",
          pull_request.head_repository_default_branch_event_at AS "defaultBranchEventAt"
        FROM pull_request_detail pull_request
        INNER JOIN candidate_authorities candidate
          ON candidate.id = pull_request.id
        WHERE candidate.authority_at IS NULL
          OR candidate.authority_at = candidate.latest_authority_at
        FOR SHARE OF pull_request
      `),
    ]);
    installationRepositories.push(...installedChunk);
    publicRepositories.push(...publicChunk);
    pullRequestRepositories.push(...pullRequestChunk);
  }
  return [
    ...installationRepositories.map((repository) => ({
      repository,
      repositoryId: repository.id,
    })),
    ...publicRepositories.map((repository) => ({
      repository,
      repositoryId: null,
    })),
    ...pullRequestRepositories.map((repository) => ({
      repository,
      repositoryId: null,
    })),
  ];
}

function reconcileAuthorityRows(
  authorityRows: readonly SessionAuthoritySourceRow[]
): SessionBranchRepositoryAuthorityMap {
  const resolved: SessionBranchRepositoryAuthorityMap = new Map();
  const ambiguousIdentities = new Set<string>();
  for (const { repository, repositoryId } of authorityRows) {
    const normalizedFullName = normalizeRepoFullName(repository.fullName);
    const providerRepositoryId = repository.githubRepoId?.trim();
    if (!providerRepositoryId) {
      ambiguousIdentities.add(normalizedFullName);
    }
    const authority = normalizeSessionAuthority(
      repository,
      normalizedFullName,
      providerRepositoryId
    );
    const existing = resolved.get(normalizedFullName);
    if (
      authorityIdentityConflicts(existing, repositoryId, providerRepositoryId)
    ) {
      ambiguousIdentities.add(normalizedFullName);
    }
    const authorities = authority
      ? [...(existing?.authorities ?? []), authority]
      : (existing?.authorities ?? []);
    const identityIsAmbiguous = ambiguousIdentities.has(normalizedFullName);
    resolved.set(normalizedFullName, {
      repositoryId: repositoryId ?? existing?.repositoryId ?? null,
      ...(identityIsAmbiguous || !providerRepositoryId
        ? {}
        : { providerRepositoryId }),
      ...(identityIsAmbiguous ? { identityConflict: true } : {}),
      authorities: identityIsAmbiguous ? [] : authorities,
    });
  }
  return resolved;
}

function normalizeSessionAuthority(
  repository: SessionRepositoryAuthorityRow,
  normalizedFullName: string,
  providerRepositoryId: string | undefined
): NormalizedPersistedRepositoryDefaultAuthority | undefined {
  if (!providerRepositoryId) {
    return undefined;
  }
  return normalizePersistedRepositoryDefaultAuthority(
    {
      provider: VcsProviderKind.GitHub,
      providerRepositoryId,
      fullName: normalizedFullName,
    },
    repository
  );
}

function authorityIdentityConflicts(
  existing: SessionBranchRepositoryAuthority | undefined,
  repositoryId: string | null,
  providerRepositoryId: string | undefined
): boolean {
  return Boolean(
    (existing?.providerRepositoryId &&
      existing.providerRepositoryId !== providerRepositoryId) ||
      (existing?.repositoryId &&
        repositoryId &&
        existing.repositoryId !== repositoryId)
  );
}

function collectNormalizedRepositoryNames(
  sessions: readonly SyncedAgentSession[]
): string[] {
  const repoFullNames = new Set<string>();
  for (const session of sessions) {
    for (const ref of collectBranchRefs(session.artifactRefs)) {
      repoFullNames.add(normalizeRepoFullName(ref.repositoryFullName));
    }
    for (const ref of collectPullRequestRefs(session.artifactRefs)) {
      repoFullNames.add(normalizeRepoFullName(ref.repositoryFullName));
    }
  }
  return [...repoFullNames];
}

/**
 * Repos referenced ONLY by a monitored-activity PR ref — a PR URL seen in a
 * message, which `collectPullRequestRefs` filters out of the PR lane.
 *
 * These need `repositoryId` and nothing else: it is the key that lets
 * `resolveResidualPullRequestTargets` find their PullRequestDetail row on the
 * `(repositoryId, number)` index (ISS-6450). Feeding them through
 * `collectNormalizedRepositoryNames` would also send them through the two
 * authority queries they have no use for — and the PR-head one is served only
 * by the organization index on `LOWER(head_repository_full_name)`, so every
 * added name makes another chunk filter the org's whole PR history inside the
 * write transaction (wongk, #5103). Names already in the authority set are
 * excluded: those are read there, with their authority.
 */
function collectIdentityOnlyRepositoryNames(
  sessions: readonly SyncedAgentSession[],
  authorityNames: readonly string[]
): string[] {
  const authoritySet = new Set(authorityNames);
  const repoFullNames = new Set<string>();
  for (const session of sessions) {
    for (const ref of session.artifactRefs ?? []) {
      if (ref.kind !== ArtifactRefTargetKind.PullRequest) {
        continue;
      }
      const normalizedFullName = normalizeRepoFullName(ref.repositoryFullName);
      if (!authoritySet.has(normalizedFullName)) {
        repoFullNames.add(normalizedFullName);
      }
    }
  }
  return [...repoFullNames];
}

const REPOSITORY_NAME_QUERY_CHUNK_SIZE = 100;

type SessionRepositoryAuthorityRow = {
  id: string;
  githubRepoId: string | null;
  fullName: string;
  defaultBranchName: string | null;
  defaultBranchAvailability: string | null;
  defaultBranchCompleteness: string | null;
  defaultBranchReason: string | null;
  defaultBranchSource: string | null;
  defaultBranchMechanism: string | null;
  defaultBranchTrigger: string | null;
  defaultBranchCredentialType: string | null;
  defaultBranchCredentialOwnerId: string | null;
  defaultBranchObservationKey: string | null;
  defaultBranchObservedAt: Date | null;
  defaultBranchEventAt: Date | null;
};

type SessionAuthoritySourceRow = {
  repository: SessionRepositoryAuthorityRow;
  repositoryId: string | null;
};

/** Installation-repository identity with no default-branch authority columns. */
type SessionRepositoryIdentityRow = {
  id: string;
  githubRepoId: string | null;
  fullName: string;
};

function chunksOf<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
