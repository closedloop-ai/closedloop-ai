import { normalizeRepoFullName } from "@repo/api/src/types/branch";
import {
  CommitProvenanceSource,
  isAuthoritativeCommitSource,
} from "@repo/api/src/types/commit";
import {
  type CommitDetail,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { getPrismaErrorCode } from "@/lib/db-utils";

/**
 * CommitDetail SSOT service (FEA-2731 / PRD-510 D7).
 *
 * `CommitDetail` is a standalone table — NOT an Artifact subtype — that attaches
 * to the platform via a `branchArtifactId` FK to the branch's Artifact. It is
 * fed by two producers reconciled on the identity key `(organizationId,
 * repositoryFullName, sha)`:
 *   - the desktop sync lane (`reconcileCommitOnTx`, source `desktop_sync`),
 *     which supplies the ABBREVIATED sha parsed from the git-commit summary line,
 *   - the GitHub `push` webhook (`recordWebhookCommits`, source `push_webhook`),
 *     which supplies the FULL 40-char sha.
 *
 * Identity is git-style: an abbreviated sha and a full sha are the same commit
 * when one is a prefix of the other, scoped to `(org, repo)` (git guarantees the
 * abbreviation is unambiguous within the repo at commit time). When the webhook
 * lands, the stored sha is EXPANDED to the full form. Field-level provenance
 * (Phase 4): GitHub is authoritative for author/date/LOC/message and overwrites;
 * desktop fills only nulls.
 */

type CommitTx = TransactionClient;

/**
 * One commit observation to reconcile onto the identity key. `repositoryFullName`
 * is normalized and `sha` lowercased inside `reconcileCommitOnTx`, so callers may
 * pass raw producer values.
 */
export type ReconcileCommitInput = {
  organizationId: string;
  repositoryFullName: string;
  /** Abbreviated (desktop) or full (webhook) — 7–40 lowercase hex. */
  sha: string;
  /** The branch the commit was observed on (its Artifact id). */
  branchArtifactId: string;
  source: CommitProvenanceSource;
  message?: string | null;
  committedAt?: Date | null;
  authoredAt?: Date | null;
  authorName?: string | null;
  authorEmail?: string | null;
  authorLogin?: string | null;
  linesAdded?: number | null;
  linesRemoved?: number | null;
  filesChanged?: number | null;
  isMerge?: boolean | null;
  mergeCommitSha?: string | null;
};

/** A single commit from a GitHub `push` payload, pre-mapped for the webhook lane. */
export type WebhookCommitInput = Omit<
  ReconcileCommitInput,
  "organizationId" | "repositoryFullName" | "branchArtifactId" | "source"
>;

export type RecordWebhookCommitsInput = {
  organizationId: string;
  repositoryFullName: string;
  branchArtifactId: string;
  commits: readonly WebhookCommitInput[];
};

/**
 * Field-level provenance pick. A GitHub-authoritative write overwrites with any
 * non-null incoming value; a desktop write fills only when the stored value is
 * null. An absent (undefined/null) incoming value never clobbers what's stored.
 */
function pickField<T>(
  existing: T | null,
  incoming: T | null | undefined,
  authoritative: boolean
): T | null {
  if (incoming === undefined || incoming === null) {
    return existing ?? null;
  }
  if (authoritative) {
    return incoming;
  }
  return existing ?? incoming;
}

/**
 * `isMerge` is a non-null boolean. Only a GitHub-authoritative write can set it
 * (the desktop never computes merge-ness and passes undefined) — keep the stored
 * value otherwise so the insert default (`false`) is never overwritten by a
 * desktop re-sync.
 */
function pickIsMerge(
  existing: boolean,
  incoming: boolean | null | undefined,
  authoritative: boolean
): boolean {
  if (incoming === undefined || incoming === null || !authoritative) {
    return existing;
  }
  return incoming;
}

/**
 * `source` records the last AUTHORITATIVE writer per the precedence rule: once a
 * GitHub write has stamped the row, a later desktop write (which only fills
 * nulls) must not demote it back to `desktop_sync`.
 */
function pickSource(
  existing: string,
  incoming: CommitProvenanceSource
): string {
  if (
    isAuthoritativeCommitSource(existing) &&
    !isAuthoritativeCommitSource(incoming)
  ) {
    return existing;
  }
  return incoming;
}

/**
 * Find the existing `CommitDetail` row that is git-identity-equal to `sha`
 * within `(org, repo)`: one sha is a prefix of the other. Narrowed by the shared
 * 7-char prefix (an index range scan on the `(org, repo, sha)` unique key — a
 * git abbreviation is always a prefix of the full sha, so both share their first
 * seven hex chars), then confirmed by an exact prefix test. Prefers the fullest
 * matching row so a webhook full-sha row is chosen over a desktop abbrev row,
 * avoiding a needless sha expansion.
 */
async function findCommitByShaPrefix(
  tx: CommitTx,
  organizationId: string,
  repositoryFullName: string,
  sha: string
): Promise<CommitDetail | null> {
  const candidates = await tx.commitDetail.findMany({
    where: {
      organizationId,
      repositoryFullName,
      sha: { startsWith: sha.slice(0, 7) },
    },
  });
  let match: CommitDetail | null = null;
  for (const candidate of candidates) {
    if (
      (sha.startsWith(candidate.sha) || candidate.sha.startsWith(sha)) &&
      (match === null || candidate.sha.length > match.sha.length)
    ) {
      match = candidate;
    }
  }
  return match;
}

/**
 * Reconcile one commit onto the `(org, repo, sha)` identity within a caller
 * transaction. Insert when absent; otherwise merge (field-level provenance) and
 * expand the stored sha to the longer/fuller form. Idempotent — a re-sync of the
 * same observation is a no-op.
 *
 * Runs on the caller's `tx`: inside the desktop sync lane this is the long-lived
 * multi-session transaction, so a concurrent-insert P2002 propagates and rolls
 * the batch back (the desktop re-sends its full ref set on the next tick — no
 * in-aborted-transaction recovery, per AGENTS.md). The webhook lane
 * (`recordWebhookCommits`) opens its own transaction and retries once.
 *
 * KNOWN LIMITATION (pre-PMF, accepted): the `(org, repo, sha)` unique index is an
 * EXACT match, so it catches a concurrent re-insert of the SAME literal sha
 * (two desktop abbrevs, or two webhook fulls) via P2002. It does NOT catch the
 * cross-form race — the desktop's abbreviated sha and the webhook's full sha for
 * the SAME commit reconciling concurrently: both read "no row" under READ
 * COMMITTED and both insert, leaving two prefix-compatible rows that never
 * self-heal (visible as a duplicate in branch history). This is only reachable on
 * a repo running BOTH producers (desktop app + GitHub App). Deferred with no
 * customers on that overlap; close it before then with a Postgres advisory
 * xact-lock keyed on `hashtext(org|repo|sha[:7])` (serializes same-prefix
 * reconciles so the read-then-write can't interleave), or SERIALIZABLE + retry.
 */
export async function reconcileCommitOnTx(
  tx: CommitTx,
  input: ReconcileCommitInput
): Promise<void> {
  const repositoryFullName = normalizeRepoFullName(input.repositoryFullName);
  const sha = input.sha.toLowerCase();
  const authoritative = isAuthoritativeCommitSource(input.source);

  const existing = await findCommitByShaPrefix(
    tx,
    input.organizationId,
    repositoryFullName,
    sha
  );

  if (existing === null) {
    await tx.commitDetail.create({
      data: {
        organizationId: input.organizationId,
        repositoryFullName,
        sha,
        branchArtifactId: input.branchArtifactId,
        source: input.source,
        message: input.message ?? null,
        committedAt: input.committedAt ?? null,
        authoredAt: input.authoredAt ?? null,
        authorName: input.authorName ?? null,
        authorEmail: input.authorEmail ?? null,
        authorLogin: input.authorLogin ?? null,
        linesAdded: input.linesAdded ?? null,
        linesRemoved: input.linesRemoved ?? null,
        filesChanged: input.filesChanged ?? null,
        isMerge: input.isMerge ?? false,
        mergeCommitSha: input.mergeCommitSha ?? null,
      },
    });
    return;
  }

  // Expand to the fuller sha (full 40-char beats a 7-char abbrev). Because
  // findCommitByShaPrefix prefers the longest existing row, an expansion here
  // means no full-sha row existed yet, so setting the full sha cannot collide.
  const canonicalSha = sha.length > existing.sha.length ? sha : existing.sha;

  await tx.commitDetail.update({
    where: { id: existing.id },
    data: {
      sha: canonicalSha,
      // branchArtifactId is set once (first observation's branch wins);
      // many-to-many commit↔branch is deferred (Q10).
      message: pickField(existing.message, input.message, authoritative),
      committedAt: pickField(
        existing.committedAt,
        input.committedAt,
        authoritative
      ),
      authoredAt: pickField(
        existing.authoredAt,
        input.authoredAt,
        authoritative
      ),
      authorName: pickField(
        existing.authorName,
        input.authorName,
        authoritative
      ),
      authorEmail: pickField(
        existing.authorEmail,
        input.authorEmail,
        authoritative
      ),
      authorLogin: pickField(
        existing.authorLogin,
        input.authorLogin,
        authoritative
      ),
      linesAdded: pickField(
        existing.linesAdded,
        input.linesAdded,
        authoritative
      ),
      linesRemoved: pickField(
        existing.linesRemoved,
        input.linesRemoved,
        authoritative
      ),
      filesChanged: pickField(
        existing.filesChanged,
        input.filesChanged,
        authoritative
      ),
      isMerge: pickIsMerge(existing.isMerge, input.isMerge, authoritative),
      mergeCommitSha: pickField(
        existing.mergeCommitSha,
        input.mergeCommitSha,
        authoritative
      ),
      source: pickSource(existing.source, input.source),
    },
  });
}

/**
 * GitHub `push`-webhook producer: reconcile the payload's commits for a resolved
 * branch artifact (full shas, GitHub-authoritative). Runs all commits in one
 * transaction and retries once on a concurrent-producer P2002 (mirroring
 * `branchService.upsertBranchArtifact`); reconciles are idempotent, so replaying
 * the batch on retry is safe. Returns the number written; a persistence failure
 * throws (the caller persists best-effort and never fails the webhook ack).
 */
async function recordWebhookCommits(
  input: RecordWebhookCommitsInput
): Promise<{ written: number }> {
  if (input.commits.length === 0) {
    return { written: 0 };
  }
  const run = (): Promise<{ written: number }> =>
    withDb.tx(async (tx) => {
      for (const commit of input.commits) {
        await reconcileCommitOnTx(tx, {
          organizationId: input.organizationId,
          repositoryFullName: input.repositoryFullName,
          branchArtifactId: input.branchArtifactId,
          source: CommitProvenanceSource.PushWebhook,
          ...commit,
        });
      }
      return { written: input.commits.length };
    });
  try {
    return await run();
  } catch (error) {
    if (getPrismaErrorCode(error) !== "P2002") {
      throw error;
    }
    return run();
  }
}

export const commitService = {
  recordWebhookCommits,
};
