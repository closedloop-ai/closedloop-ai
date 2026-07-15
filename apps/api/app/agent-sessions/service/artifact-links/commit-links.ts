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

  const unresolved: UnresolvedCommitRef[] = [];
  for (const ref of commitRefs) {
    const repositoryFullName = normalizeRepoFullName(ref.repositoryFullName);
    const branch = await tx.branchDetail.findFirst({
      where: { organizationId, repositoryFullName, branchName: ref.branchName },
      select: { artifactId: true },
    });
    if (branch === null) {
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
      branchArtifactId: branch.artifactId,
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
