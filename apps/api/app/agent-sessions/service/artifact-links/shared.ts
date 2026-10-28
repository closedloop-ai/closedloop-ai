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
  PROSE_MENTION_REF_METHODS,
  syncedBranchLifecycleEventSchema,
} from "@repo/api/src/types/session-artifact-link";
import { VcsProviderKind } from "@repo/api/src/types/vcs-provider-kind";
import { GitHubInstallationStatus, type Prisma } from "@repo/database";
import { chunksOf } from "@/lib/chunks-of";
import { parseJsonObject, parseProtoSafeJsonObject } from "@/lib/json-schema";
import { parseJsonArray } from "../coercion";
import type { AgentSessionUpsertTx } from "../records";
import {
  REPOSITORY_NAME_QUERY_CHUNK_SIZE,
  RepositoryIdentitySource,
  readLockedAuthorityRows,
  readLockedIdentityRows,
  type SessionAuthoritySourceRow,
  type SessionRepositoryAuthorityRow,
  type SessionRepositoryIdentityRow,
} from "./authority-source-queries";

/** Server-owned repository identity and default authority resolved once per sync payload. */
export type SessionBranchRepositoryAuthority = {
  repositoryId: string | null;
  providerRepositoryId?: string;
  identityConflict?: boolean;
  authorities: readonly NormalizedPersistedRepositoryDefaultAuthority[];
  /**
   * Which identity sources answered for this repository. The raw set rather
   * than a precomputed verdict, so the judgment of which source confers FETCH
   * authority lives in one place ({@link serverRepositoryFetchAuthority}) and
   * two callers cannot disagree about it.
   */
  identitySources: ReadonlySet<RepositoryIdentitySource>;
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
  // ISS-10177: the proto-safe parser, because the update below writes this blob
  // back whole. The lossy one would delete an own `__proto__` key that ingest
  // had just preserved, on the first session that also carries an unresolved
  // ref — undoing the fix for exactly the sessions that reach this lane.
  const currentMetadata = parseProtoSafeJsonObject(detail?.metadata) ?? {};
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
    select: { artifactId: true },
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

/** The pull_request-kind subset of a session's artifact refs. */
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

/**
 * ISS-7012/ISS-7062: this was the second hand-rolled member-wise reader in the
 * service. It now goes through the canonical {@link parseJsonArray}, which reads
 * exactly the same way — absent, non-array, and every-member-unreadable all read
 * as `[]`, and one bad member never discards its readable siblings.
 */
export function readBranchLifecycleEventsFromMetadata(
  metadata: unknown
): SyncedBranchLifecycleEvent[] {
  return parseJsonArray<SyncedBranchLifecycleEvent>(
    parseJsonObject(metadata)?.branchLifecycleEvents,
    syncedBranchLifecycleEventSchema
  );
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
  // ISS-8247: every boundary the wire schema ACCEPTED is stored. There is no
  // newest-N window here any more. A window on an already-acknowledged payload
  // cannot report what it discarded — the sync returns success, the sender never
  // retries, and the dropped boundaries are gone — so the acknowledgement was
  // claiming more than was stored.
  //
  // GROWTH IS NOW UNBOUNDED IN DISTINCT BOUNDARIES, deliberately. The dedupe
  // above collapses REPEATS only — an evidence-bearing boundary replaces its
  // predecessor under the same `evidenceId` — so a re-sync of the same
  // boundaries is idempotent, but each genuinely NEW boundary is retained
  // forever. `session-branch-link-writer.ts` merges the stored array with every
  // incoming sync and `pull-request-session-link-relink.ts` merges a target
  // link's array with each source link's on every relink, so the array is
  // monotonically non-decreasing and the `.slice()` removed here was its only
  // ceiling. That is the accepted cost: these live in `artifact_links.metadata`
  // (jsonb) and key no index (ISS-8070/ISS-8064), the array grows with real
  // branch activity rather than with poll or retry volume, and the alternative
  // is the silent discard of accepted input this change exists to remove. If a
  // ceiling is ever needed it belongs on total metadata SIZE, at the write
  // boundary, emitting a truncation marker — never a silent newest-N window.
  return merged.sort(compareBranchLifecycleEvents);
}

/**
 * Resolve installation-repository ids for the given repo full names (org-scoped,
 * active installs only). Single source for this query — shared by the PR lane
 * (`resolveRepoIdsByFullName`) and the branch lane (`resolveSessionRepositoryIdentity`).
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
 * every branch/PR ref in the supplied session slice, PAIRED with the names the
 * reads actually covered. Active installation and org-scoped public rows are
 * read in bounded chunks and locked until the write transaction completes.
 * Queries nothing when no ref needs it.
 *
 * The pairing is the point. An absent map entry answers "the server holds no
 * identity" only for a name a read asked about, and a caller holding the map
 * alone cannot tell that apart from a name nobody looked up. `probedNames` is
 * that difference handed over as a fact rather than left as a contract the
 * caller has to remember — see {@link serverRepositoryIdentity}, which is the
 * only way to ask the question and cannot be asked without it.
 */
export async function resolveSessionRepositoryIdentity(
  tx: Pick<AgentSessionUpsertTx, "$queryRaw">,
  organizationId: string,
  sessions: readonly SyncedAgentSession[]
): Promise<SessionRepositoryIdentityProbe> {
  const normalizedNames = collectNormalizedRepositoryNames(sessions);
  const identityOnlyNames = collectIdentityOnlyRepositoryNames(
    sessions,
    normalizedNames
  );
  const probedNames = new Set([...normalizedNames, ...identityOnlyNames]);
  if (probedNames.size === 0) {
    return { authorities: new Map(), probedNames };
  }
  const [authorities, identityRows] = await Promise.all([
    resolveRepositoryAuthorityByNames(tx, organizationId, normalizedNames),
    readLockedIdentityRows(tx, organizationId, identityOnlyNames),
  ]);
  mergeIdentityOnlyRows(authorities, identityRows);
  return { authorities, probedNames };
}

/**
 * The authority half of `resolveSessionRepositoryIdentity`, keyed by repository name rather
 * than by a session payload.
 *
 * Exported for branch-materialization retry drains, which only have repository
 * names from deferred branch identities. A local copy of "read the four sources,
 * then reconcile them" would be a second place precedence and identity-conflict
 * handling live, and the two would drift the first time a source is added.
 */
export async function resolveRepositoryAuthorityByNames(
  tx: Pick<AgentSessionUpsertTx, "$queryRaw">,
  organizationId: string,
  normalizedNames: readonly string[]
): Promise<SessionBranchRepositoryAuthorityMap> {
  if (normalizedNames.length === 0) {
    return new Map();
  }
  return reconcileAuthorityRows(
    await readLockedAuthorityRows(tx, organizationId, normalizedNames)
  );
}

/**
 * Fold identity rows into the resolved map with NO authority evidence.
 *
 * These names were never read for default-branch authority, so they carry
 * `authorities: []` — an empty list here means "not looked up", and it must not
 * be mistaken for "looked up and found none". Two sources claiming one full name
 * with different ids is the same unresolvable identity the authority reconciler
 * flags, so it is marked the same way and neither id is picked arbitrarily. So
 * is a row FOUND carrying neither id — see {@link foundRowIdentity}.
 */
function mergeIdentityOnlyRows(
  resolved: SessionBranchRepositoryAuthorityMap,
  identityRows: readonly SessionRepositoryIdentityRow[]
): void {
  for (const [normalizedFullName, rows] of groupIdentityRowsByName(
    identityRows
  )) {
    const existing = resolved.get(normalizedFullName);
    if (existing?.identityConflict) {
      continue;
    }
    let accumulated: SessionBranchRepositoryAuthority = existing ?? {
      repositoryId: null,
      authorities: [],
      identitySources: NO_IDENTITY_SOURCES,
    };
    let conflicted = false;
    for (const row of rows) {
      const providerRepositoryId = row.githubRepoId?.trim() || undefined;
      if (
        identityRowConflicts(
          accumulated,
          row.repositoryId,
          providerRepositoryId
        )
      ) {
        conflicted = true;
        break;
      }
      accumulated = {
        ...accumulated,
        repositoryId: accumulated.repositoryId ?? row.repositoryId,
        // Recorded even for a row that contributed no id: the question this
        // set answers is which table holds a record of the repository, not
        // which one won the identity race.
        identitySources: withIdentitySource(
          accumulated.identitySources,
          row.source
        ),
        ...(providerRepositoryId && !accumulated.providerRepositoryId
          ? { providerRepositoryId }
          : {}),
      };
    }
    if (conflicted) {
      resolved.set(normalizedFullName, {
        repositoryId: null,
        identityConflict: true,
        authorities: [],
        identitySources: NO_IDENTITY_SOURCES,
      });
      continue;
    }
    resolved.set(normalizedFullName, {
      ...accumulated,
      ...foundRowIdentity(
        accumulated.repositoryId,
        accumulated.providerRepositoryId,
        accumulated.identitySources
      ),
    });
  }
}

/**
 * Every identity row for one name, together.
 *
 * The sources are read in one order — installation, then public, PR-head and
 * observed — and only the PUBLIC arm does not filter a blank `github_repo_id`.
 * Folding row-by-row therefore let a blank public row reach
 * {@link foundRowIdentity} first, latch `identityConflict`, and make the
 * PR-head row carrying a REAL id unreachable behind the conflict early-return:
 * a repository the server can identify came back conflicted and retry-owned,
 * withheld indefinitely. "No id SO FAR" and "two ids disagree" are different
 * answers, and only the second may latch, so the whole group is reconciled
 * before either is decided.
 */
function groupIdentityRowsByName(
  identityRows: readonly SessionRepositoryIdentityRow[]
): Map<string, SessionRepositoryIdentityRow[]> {
  const byName = new Map<string, SessionRepositoryIdentityRow[]>();
  for (const row of identityRows) {
    const normalizedFullName = normalizeRepoFullName(row.fullName);
    const bucket = byName.get(normalizedFullName);
    if (bucket) {
      bucket.push(row);
      continue;
    }
    byName.set(normalizedFullName, [row]);
  }
  return byName;
}

/**
 * The identity fields for a row the read FOUND.
 *
 * A found row that pins NEITHER id is unresolvable identity, not absent
 * identity, and the difference is load-bearing: `serverRepositoryIdentity`
 * reads an entry with no id and no conflict as `None`, which is what authorizes
 * the ISS-9181 acknowledgement — so the Session is acked and its activity
 * evidence discarded for a repository the server demonstrably has a row for.
 * `reconcileAuthorityRows` already answers this shape with `identityConflict`;
 * this answers it the same way. A blank `github_repo_id` is a real row shape
 * and no query filters it out, so this cannot be fixed in the queries: an
 * absent entry reads as `None` too.
 */
function foundRowIdentity(
  repositoryId: string | null,
  providerRepositoryId: string | undefined,
  identitySources: ReadonlySet<RepositoryIdentitySource>
): Pick<
  SessionBranchRepositoryAuthority,
  | "repositoryId"
  | "providerRepositoryId"
  | "identityConflict"
  | "identitySources"
> {
  if (repositoryId || providerRepositoryId) {
    return {
      repositoryId,
      ...(providerRepositoryId ? { providerRepositoryId } : {}),
      identitySources,
    };
  }
  return {
    repositoryId: null,
    identityConflict: true,
    identitySources: NO_IDENTITY_SOURCES,
  };
}

function identityRowConflicts(
  existing: SessionBranchRepositoryAuthority,
  repositoryId: string | null,
  providerRepositoryId: string | undefined
): boolean {
  return Boolean(
    (existing.repositoryId &&
      repositoryId &&
      existing.repositoryId !== repositoryId) ||
      (existing.providerRepositoryId &&
        providerRepositoryId &&
        existing.providerRepositoryId !== providerRepositoryId)
  );
}

function reconcileAuthorityRows(
  authorityRows: readonly SessionAuthoritySourceRow[]
): SessionBranchRepositoryAuthorityMap {
  const resolved: SessionBranchRepositoryAuthorityMap = new Map();
  const ambiguousIdentities = new Set<string>();
  for (const { repository, repositoryId, source } of authorityRows) {
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
    const identitySources = withIdentitySource(
      existing?.identitySources ?? NO_IDENTITY_SOURCES,
      source
    );
    const identityIsAmbiguous = ambiguousIdentities.has(normalizedFullName);
    resolved.set(normalizedFullName, {
      repositoryId: repositoryId ?? existing?.repositoryId ?? null,
      ...(identityIsAmbiguous || !providerRepositoryId
        ? {}
        : { providerRepositoryId }),
      ...(identityIsAmbiguous ? { identityConflict: true } : {}),
      authorities: identityIsAmbiguous ? [] : authorities,
      identitySources: identityIsAmbiguous
        ? NO_IDENTITY_SOURCES
        : identitySources,
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
 * Repos referenced ONLY by a monitored-activity ref — a PR URL or a branch name
 * seen in a message, which `collectPullRequestRefs` and `collectBranchRefs`
 * filter out of their lanes.
 *
 * These need identity and nothing else — no default-branch authority — so they
 * go to {@link readLockedIdentityRows} rather than through
 * `collectNormalizedRepositoryNames`, which would also run the default-branch
 * queries they have no use for. `repositoryId` is what lets
 * `resolveResidualPullRequestTargets` find their PullRequestDetail row on the
 * `(repositoryId, number)` index (ISS-6450). Names already in the authority set
 * are excluded: those are read there, with their authority.
 *
 * ISS-9181 added the branch half. `monitoredActivityOnly` branch refs used to
 * reach NEITHER read, so their repository was absent from the map for want of
 * a lookup — indistinguishable from a repository the server holds no identity
 * for, which {@link serverRepositoryIdentity} would then have read as an answer
 * and acknowledged the Session on.
 */
function collectIdentityOnlyRepositoryNames(
  sessions: readonly SyncedAgentSession[],
  authorityNames: readonly string[]
): string[] {
  const authoritySet = new Set(authorityNames);
  const repoFullNames = new Set<string>();
  for (const session of sessions) {
    for (const ref of session.artifactRefs ?? []) {
      if (!isIdentityOnlyRef(ref)) {
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

function isIdentityOnlyRef(
  ref: SyncedArtifactRef
): ref is SyncedBranchArtifactRef | SyncedPullRequestArtifactRef {
  if (ref.kind === ArtifactRefTargetKind.PullRequest) {
    return true;
  }
  return (
    ref.kind === ArtifactRefTargetKind.Branch &&
    ref.monitoredActivityOnly === true
  );
}

/**
 * PLN-1775 M1 (ISS-7403): the repository names this slice referenced for which
 * the server holds NO record of the repository at all.
 *
 * Every source `resolveSessionRepositoryIdentity` reads is downstream of a GitHub App read
 * — installation rows, public rows, PR-head authority — so for an org with no
 * App installation this list is simply the repos it works in, and it is the
 * only place they are nameable. They become discovery candidates
 * (`github_observed_repository`); they do not become authority, which still
 * requires a verified GitHub read.
 * ISS-7888/PRD-683 P1-C: observation candidates are structural repository
 * evidence only. Prose-derived PR and branch mentions stay available to branch
 * and PR identity lanes, but never prove that an org works in that repository.
 *
 * A name is excluded the moment ANY server-owned identity exists for it, which
 * is {@link serverRepositoryIdentity}'s question.
 */
export function collectObservableRepositoryNames(
  sessions: readonly SyncedAgentSession[],
  probe: SessionRepositoryIdentityProbe
): string[] {
  return collectObservationRepositoryNames(sessions).filter(
    (fullName) =>
      serverRepositoryIdentity(probe, fullName) ===
      ServerRepositoryIdentity.None
  );
}

/**
 * PR refs backed by command/provider-verifiable evidence. Prose refs stay in
 * the weak PR lane, but they must not drive provider detail writes or locks.
 */
export function collectProviderVerifiablePullRequestRefs(
  artifactRefs: SyncedArtifactRef[] | undefined
): SyncedPullRequestArtifactRef[] {
  return collectPullRequestRefs(artifactRefs).filter(
    (ref) => !isProseRepositoryMention(ref)
  );
}

function isProseRepositoryMention(
  ref: Pick<SyncedBranchArtifactRef | SyncedPullRequestArtifactRef, "method">
): boolean {
  return PROSE_MENTION_REF_METHODS.has(ref.method);
}

function collectObservationRepositoryNames(
  sessions: readonly SyncedAgentSession[]
): string[] {
  const repoFullNames = new Set<string>();
  for (const session of sessions) {
    for (const ref of collectBranchRefs(session.artifactRefs)) {
      if (isProseRepositoryMention(ref)) {
        continue;
      }
      repoFullNames.add(normalizeRepoFullName(ref.repositoryFullName));
    }
    for (const ref of collectPullRequestRefs(session.artifactRefs)) {
      if (isProseRepositoryMention(ref)) {
        continue;
      }
      repoFullNames.add(normalizeRepoFullName(ref.repositoryFullName));
    }
  }
  return [...repoFullNames];
}

/**
 * What {@link resolveSessionRepositoryIdentity} read, and the names it read it
 * for. The two travel together because neither answers
 * {@link serverRepositoryIdentity} alone.
 */
export type SessionRepositoryIdentityProbe = {
  authorities: SessionBranchRepositoryAuthorityMap;
  /** Normalized names an identity source was actually queried for. */
  probedNames: ReadonlySet<string>;
};

/**
 * Whether the server holds an identity of its own for a repository.
 *
 * NOT whether the organization can READ that repository: an observation row
 * supplies a provider id and answers `Held` here while conferring no means of
 * fetching anything. That question is {@link serverRepositoryFetchAuthority}'s,
 * and conflating the two is the defect PLN-2061 exists to remove.
 *
 * Three-valued rather than a boolean because the two ways of holding none are
 * not the same fact, and one of the answers authorizes discarding the desktop's
 * evidence for good. A boolean collapsed "every source was read and none had
 * it" into "nobody asked", and the caller could not see which it had — here the
 * distinction is in the type, so a caller has to name the case it is handling.
 */
export const ServerRepositoryIdentity = {
  /**
   * An installation row id, a provider repository id from a public, PR-head, or
   * verified-observed row, or an unresolvable collision between two of them. A
   * collision is a repo the server already knows about TWICE, not one it has
   * never heard of, so it sits on this side.
   */
  Held: "held",
  /** Every identity source was read for this name and none carried one. */
  None: "none",
  /** No read covered this name. Nothing is known either way. */
  NotProbed: "not_probed",
} as const;
export type ServerRepositoryIdentity =
  (typeof ServerRepositoryIdentity)[keyof typeof ServerRepositoryIdentity];

export function serverRepositoryIdentity(
  probe: SessionRepositoryIdentityProbe,
  normalizedFullName: string
): ServerRepositoryIdentity {
  if (!probe.probedNames.has(normalizedFullName)) {
    return ServerRepositoryIdentity.NotProbed;
  }
  const authority = probe.authorities.get(normalizedFullName);
  return authority?.repositoryId ||
    authority?.providerRepositoryId ||
    authority?.identityConflict
    ? ServerRepositoryIdentity.Held
    : ServerRepositoryIdentity.None;
}

/** No identity source answered, or the ones that did cannot be told apart. */
const NO_IDENTITY_SOURCES: ReadonlySet<RepositoryIdentitySource> = new Set();

function withIdentitySource(
  sources: ReadonlySet<RepositoryIdentitySource>,
  source: RepositoryIdentitySource
): ReadonlySet<RepositoryIdentitySource> {
  return sources.has(source) ? sources : new Set([...sources, source]);
}

/**
 * Whether this organization can FETCH a repository, as distinct from holding
 * an identity for it.
 *
 * PLN-2061 M1 separates the two because the pipeline had been reading one as
 * the other. A verified `github_observed_repository` row carries a real
 * provider id, so {@link serverRepositoryIdentity} answers `Held` for a
 * repository the organization has no installation on. `verified` records that
 * a `repos.get` succeeded ONCE, through whichever credential was at hand when
 * the observation was written — not standing access this lane can reach for on
 * a later delivery. Confirmed against production on 2026-09-18: one org holds
 * exactly that shape for `prisma/prisma-engines`, and its PR-lane target was
 * deferred under the premise that a later delivery lands the row — which no
 * delivery can satisfy.
 *
 * The PR-head source fails the same test for a weaker reason, so two of the
 * four sources confer nothing: it names a repository nobody read at all, only
 * one the provider mentioned while answering about a different one.
 *
 * Three-valued for the same reason its identity sibling is: "every source was
 * read and none conferred authority" and "nobody asked" are different facts,
 * and only the first may decide that a lane must stop claiming a target.
 */
export const ServerRepositoryFetchAuthority = {
  /** A source the organization reaches the repository through answered. */
  Held: "held",
  /** Every source was read; none of the answering ones confers a fetch. */
  None: "none",
  /** No read covered this name. Nothing is known either way. */
  NotProbed: "not_probed",
} as const;
export type ServerRepositoryFetchAuthority =
  (typeof ServerRepositoryFetchAuthority)[keyof typeof ServerRepositoryFetchAuthority];

/**
 * Exhaustive rather than a set of the conferring members: a set built from
 * today's sources still compiles when a fifth is added, and that source would
 * silently fall to one side. Here it fails `tsc` until someone judges it.
 */
const REPOSITORY_IDENTITY_SOURCE_CONFERS_FETCH_AUTHORITY: Record<
  RepositoryIdentitySource,
  boolean
> = {
  // An ACTIVE, unremoved installation row: the org holds an installation token
  // scoped to this repository and mints a fresh one per delivery.
  [RepositoryIdentitySource.Installation]: true,
  // A row only `addPublicRepository` writes, and only once
  // `lookupGitHubRepository` reached THIS repository and found it public.
  [RepositoryIdentitySource.Public]: true,
  // Weaker than `Observed`, not stronger: nothing on this path ever read the
  // repository. `mapPullRequestHeadRepository` copies `full_name` and `id` out
  // of the `head.repo` object EMBEDDED in a read aimed at the BASE repository,
  // so a row appears for every fork that has opened a PR into one of the org's
  // repositories. `cloud-branch-eligibility` calls that same column "a foreign
  // head_repository_full_name" and refuses to substitute it (ISS-5827 /
  // PRD-600 COMMON-002); it cannot confer more than the verified `repos.get`
  // below, which confers nothing (ISS-9182 review r4053480977).
  [RepositoryIdentitySource.PullRequestHead]: false,
  // A record of one past read rather than a credential this lane holds, so it
  // never makes a target materializable (PLN-2061 M1).
  [RepositoryIdentitySource.Observed]: false,
};

export function serverRepositoryFetchAuthority(
  probe: SessionRepositoryIdentityProbe,
  normalizedFullName: string
): ServerRepositoryFetchAuthority {
  if (!probe.probedNames.has(normalizedFullName)) {
    return ServerRepositoryFetchAuthority.NotProbed;
  }
  const authority = probe.authorities.get(normalizedFullName);
  for (const source of authority?.identitySources ?? NO_IDENTITY_SOURCES) {
    if (REPOSITORY_IDENTITY_SOURCE_CONFERS_FETCH_AUTHORITY[source]) {
      return ServerRepositoryFetchAuthority.Held;
    }
  }
  return ServerRepositoryFetchAuthority.None;
}
