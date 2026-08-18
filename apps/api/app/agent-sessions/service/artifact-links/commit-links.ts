import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import { CommitProvenanceSource } from "@repo/api/src/types/commit";
import type {
  SyncedArtifactRef,
  SyncedCommitArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import { reconcileCommitOnTx } from "@/app/commits/commit-service";
import type { AgentSessionUpsertTx } from "../records";
import { storeUnresolvedRefs } from "./shared";

/**
 * A commit ref deferred because its branch row hasn't synced yet. `sha` is part
 * of the dedup key so distinct commits on the same late branch all survive.
 */
type UnresolvedCommitRef = {
  repositoryFullName: string;
  branchName: string;
  sha: string;
};

/** The commit-kind subset of a session's artifact refs. */
function collectCommitRefs(
  artifactRefs: SyncedArtifactRef[] | undefined
): SyncedCommitArtifactRef[] {
  if (!artifactRefs) {
    return [];
  }
  return artifactRefs.filter(
    (ref): ref is SyncedCommitArtifactRef =>
      ref.kind === ArtifactRefTargetKind.Commit
  );
}

/** Persist deferred commit refs (branch row not yet synced) for retry on a later tick. */
function storeUnresolvedCommitRefs(
  tx: AgentSessionUpsertTx,
  sessionArtifactId: string,
  unresolvedCommitRefs: UnresolvedCommitRef[]
): Promise<void> {
  return storeUnresolvedRefs<UnresolvedCommitRef>(
    tx,
    sessionArtifactId,
    "_unresolvedCommitRefs",
    (value): value is UnresolvedCommitRef =>
      value != null &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).repositoryFullName ===
        "string" &&
      typeof (value as Record<string, unknown>).branchName === "string" &&
      typeof (value as Record<string, unknown>).sha === "string",
    (ref) => `${ref.repositoryFullName}#${ref.branchName}#${ref.sha}`,
    unresolvedCommitRefs
  );
}

/**
 * FEA-2731 desktop commit producer: upsert `CommitDetail` rows from a session's
 * `commit`-kind refs (PRD-510 D7). The desktop supplies the ABBREVIATED sha it
 * parsed from the git-commit summary line plus the observing `branchName`,
 * subject, timestamp and desktop-parsed LOC.
 *
 * Branch resolution is RESOLVE-ONLY on the D2 key `(organizationId, normalized
 * repositoryFullName, branchName)` — the branch lane above owns branch creation
 * (a commit is not a reason to mint a branch). A commit whose branch row hasn't
 * synced yet (un-pushed branch, or a late tick) is deferred into
 * `SessionDetail.metadata._unresolvedCommitRefs` and retried when the session
 * next re-sends its full ref set — never dropped, never orphaned (D3: sync scope
 * follows the branch lane).
 *
 * The write goes through `reconcileCommitOnTx` (source `desktop_sync`): it keys
 * on `(org, repo, sha)` with a git-style sha-prefix match so a later push
 * webhook (full sha) converges onto the same row, and GitHub stays authoritative
 * for author/date/LOC while desktop-parsed LOC fills only nulls. Idempotent —
 * re-sync/extractor re-derivation reconciles in place.
 */
export async function persistSessionCommitRefs(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  sessionArtifactId: string,
  artifactRefs: SyncedArtifactRef[] | undefined
): Promise<void> {
  // `undefined` means the client didn't send refs — leave commits untouched.
  if (artifactRefs === undefined) {
    return;
  }
  const commitRefs = collectCommitRefs(artifactRefs);
  if (commitRefs.length === 0) {
    return;
  }

  // ISS-4440: resolve every ref's branch artifact id in ONE org-scoped read
  // instead of a per-ref findFirst N+1 (those round-trips serialize inside the
  // agent-session upsert transaction, which runs under the 30s
  // AGENT_SESSION_UPSERT_TX_TIMEOUT_MS override — not Prisma's 5s default). The
  // per-ref reconcile writes below stay per-commit — they are genuinely
  // distinct rows.
  const branchArtifactIdByKey = await resolveBranchArtifactIds(
    tx,
    organizationId,
    commitRefs
  );

  const unresolved: UnresolvedCommitRef[] = [];
  for (const ref of commitRefs) {
    const repositoryFullName = normalizeRepoFullName(ref.repositoryFullName);
    const branchArtifactId = branchArtifactIdByKey.get(
      branchResolutionKey(repositoryFullName, ref.branchName)
    );
    if (branchArtifactId === undefined) {
      unresolved.push({
        repositoryFullName: ref.repositoryFullName,
        branchName: ref.branchName,
        sha: ref.sha,
      });
      continue;
    }
    await reconcileCommitOnTx(tx, {
      organizationId,
      repositoryFullName,
      sha: ref.sha,
      branchArtifactId,
      source: CommitProvenanceSource.DesktopSync,
      message: ref.message ?? null,
      committedAt: ref.committedAt ? new Date(ref.committedAt) : null,
      linesAdded: ref.linesAdded ?? null,
      linesRemoved: ref.linesRemoved ?? null,
      filesChanged: ref.filesChanged ?? null,
    });
  }

  if (unresolved.length > 0) {
    await storeUnresolvedCommitRefs(tx, sessionArtifactId, unresolved);
  }
}

/**
 * Map key for branch resolution: the (normalized repo full name, branch name)
 * pair that uniquely identifies a branch within the already-scoped org (PRD-510
 * D2 `@@unique([organizationId, repositoryFullName, branchName])`).
 *
 * The encoding must be STRUCTURALLY unambiguous — repo full names and branch
 * names are only length-checked upstream, never validated against a separator
 * character, so a plain-separator join (`repo + "\n" + branch`) could collapse
 * two distinct pairs onto one key if either field contained the separator
 * (e.g. `("a\nb", "c")` and `("a", "b\nc")` both → `"a\nb\nc"`), silently
 * attaching a commit to the WRONG branch artifact. `JSON.stringify` of the
 * tuple escapes every field and frames the boundary unambiguously, so distinct
 * pairs can never collide regardless of field contents.
 */
function branchResolutionKey(
  repositoryFullName: string,
  branchName: string
): string {
  return JSON.stringify([repositoryFullName, branchName]);
}

/**
 * Batch the commit lane's branch-artifact resolution (ISS-4440). Collect the
 * distinct (normalized repo, branch) pairs across `commitRefs`, fetch them with
 * ONE org-scoped `findMany`, and index the resolved artifact ids by
 * `branchResolutionKey` for O(1) lookup — replacing N serialized `findFirst`
 * round-trips with one. Absent branches are simply missing from the map, so the
 * caller defers those refs exactly as before.
 */
async function resolveBranchArtifactIds(
  tx: AgentSessionUpsertTx,
  organizationId: string,
  commitRefs: SyncedCommitArtifactRef[]
): Promise<Map<string, string>> {
  const pairByKey = new Map<
    string,
    { repositoryFullName: string; branchName: string }
  >();
  for (const ref of commitRefs) {
    const repositoryFullName = normalizeRepoFullName(ref.repositoryFullName);
    pairByKey.set(branchResolutionKey(repositoryFullName, ref.branchName), {
      repositoryFullName,
      branchName: ref.branchName,
    });
  }

  const branches = await tx.branchDetail.findMany({
    where: { organizationId, OR: [...pairByKey.values()] },
    select: {
      artifactId: true,
      repositoryFullName: true,
      branchName: true,
    },
  });

  const idByKey = new Map<string, string>();
  for (const branch of branches) {
    idByKey.set(
      branchResolutionKey(branch.repositoryFullName, branch.branchName),
      branch.artifactId
    );
  }
  return idByKey;
}
