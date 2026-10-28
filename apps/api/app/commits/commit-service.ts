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
import { bindParameterChunkSize } from "@/app/agent-sessions/service/write-chunking";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  type CommitUpdateData,
  updateCommitBatch,
} from "./commit-batch-updates";

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
export function reconcileCommitOnTx(
  tx: CommitTx,
  input: ReconcileCommitInput
): Promise<string[]> {
  return reconcileCommitsOnTx(tx, [input]);
}

/**
 * Reconcile MANY commit observations onto their identity keys (ISS-8145).
 *
 * The desktop sync lane calls this once per session instead of awaiting
 * `reconcileCommitOnTx` per ref. That loop was one read plus one write per
 * commit, serialized inside the session's write transaction and bounded only by
 * `MAX_SYNCED_ARTIFACT_REFS_PRODUCER` — a client-side courtesy, not a server
 * guarantee — so its round-trip count was the producer's to choose. ISS-4445 and
 * ISS-4440 batched this lane's READS; this is the other half.
 *
 * Round trips are now: one prefix read per (org, repo) scope, one `createMany`
 * for everything absent, and a bounded UPDATE FROM VALUES for changed rows. The last part is what makes a re-sync cheap — reconciling is
 * idempotent, so the steady state issues the read and nothing else, where it
 * previously issued 2N statements to write nothing.
 *
 * Semantics are unchanged and deliberately so: git-style prefix identity,
 * expansion to the fuller sha, field-level provenance, and `branchArtifactId`
 * set once. Observations in the SAME call that are prefix-compatible are folded
 * first, so two spellings of one commit still produce one row, exactly as the
 * serial loop produced when the second call read back the first's insert.
 *
 * Returns the distinct Branch ids the reconciled rows live on. A stored row
 * keeps the Branch it was first filed under, so that can be another Branch
 * than the observation names.
 */
export async function reconcileCommitsOnTx(
  tx: CommitTx,
  inputs: readonly ReconcileCommitInput[]
): Promise<string[]> {
  if (inputs.length === 0) {
    return [];
  }
  const branchArtifactIds = new Set<string>();
  const scopes = foldCommitObservations(inputs);
  const creates: CommitCreateData[] = [];
  const updates: {
    id: string;
    organizationId: string;
    data: CommitUpdateData;
  }[] = [];
  for (const [, scope] of scopes) {
    const existingRows = await loadExistingCommits(tx, scope);
    // One stored row can be prefix-compatible with SEVERAL observations here:
    // a 7-char `abc1234` matches both `abc1234a…` and `abc1234b…`, which are not
    // prefix-compatible with each OTHER and so survive the fold as the two
    // distinct commits they are. Git produces exactly that shape — it extends an
    // abbreviation past 7 chars precisely when 7 collides in the repo. The
    // serial loop re-read between writes, so the first observation expanded the
    // row and the second no longer matched it and inserted; claiming the row
    // reproduces that, instead of letting the second update clobber the first.
    const claimedRowIds = new Set<string>();
    for (const observation of scope.observations) {
      const existing = selectPrefixMatch(existingRows, observation.sha);
      if (existing === null || claimedRowIds.has(existing.id)) {
        creates.push(buildCommitCreateData(observation));
        branchArtifactIds.add(observation.branchArtifactId);
        continue;
      }
      claimedRowIds.add(existing.id);
      branchArtifactIds.add(existing.branchArtifactId);
      const data = buildCommitUpdateData(existing, observation);
      // `null` means every stored value already equals what this observation
      // would write. Issuing the update anyway is what made an idempotent
      // re-sync cost a round trip per commit.
      if (data !== null) {
        updates.push({
          id: existing.id,
          organizationId: scope.organizationId,
          data,
        });
      }
    }
  }
  if (creates.length > 0) {
    // Deliberately NO `skipDuplicates`. A racing insert of the same literal sha
    // must still raise P2002, because that error is load-bearing rather than
    // incidental: `recordWebhookCommits` catches exactly it and re-runs the
    // transaction, and the retry's identity read then applies the
    // GitHub-authoritative field merge onto the row that won the race.
    // Swallowing the conflict would drop that observation permanently — the
    // push webhook does not re-send — while still counting it as written.
    //
    // ISS-8145 (whitlockk review): ONE statement per bind-budget slice, not one per
    // call. `creates` is as wide as the producer's ref set, bounded only by the
    // client-side `MAX_SYNCED_ARTIFACT_REFS_PRODUCER` courtesy, so at
    // {@link COMMIT_CREATE_CHUNK} rows a single `createMany` crosses Prisma's
    // built-statement bind budget — where it is REFUSED outright and takes the
    // enclosing session transaction with it, rather than merely running slow.
    // Slicing stays all-or-nothing: every caller reconciles inside an
    // interactive transaction, so a later chunk's failure rolls back the
    // earlier ones.
    for (let index = 0; index < creates.length; index += COMMIT_CREATE_CHUNK) {
      await tx.commitDetail.createMany({
        data: creates.slice(index, index + COMMIT_CREATE_CHUNK),
      });
    }
  }
  await updateCommitBatch(tx, updates);
  return [...branchArtifactIds];
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
      const branchArtifactIds = new Set<string>();
      for (const commit of input.commits) {
        const filedUnder = await reconcileCommitOnTx(tx, {
          organizationId: input.organizationId,
          repositoryFullName: input.repositoryFullName,
          branchArtifactId: input.branchArtifactId,
          source: CommitProvenanceSource.PushWebhook,
          ...commit,
        });
        for (const branchArtifactId of filedUnder) {
          branchArtifactIds.add(branchArtifactId);
        }
      }
      // ISS-12463: the only writer of `commit_detail.author_login`, so the
      // commit-author rung can first resolve here, on every Branch the rows
      // live on.
      await seedBranchOwners(tx, input.organizationId, [...branchArtifactIds]);
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

/** Per-commit values this service writes; shared by the create and update paths. */
type CommitCreateData = {
  organizationId: string;
  repositoryFullName: string;
  sha: string;
  branchArtifactId: string;
  source: string;
  message: string | null;
  committedAt: Date | null;
  authoredAt: Date | null;
  authorName: string | null;
  authorEmail: string | null;
  authorLogin: string | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  filesChanged: number | null;
  isMerge: boolean;
  mergeCommitSha: string | null;
};

/** One commit observation, normalized and merged with any siblings in the call. */
type CommitObservation = ReconcileCommitInput & { sha: string };

type CommitScope = {
  organizationId: string;
  repositoryFullName: string;
  observations: CommitObservation[];
};

/**
 * The first seven hex chars two spellings of one commit must share.
 *
 * A git abbreviation is always a prefix of the full sha, so the shared prefix is
 * what narrows the identity read to an index range instead of the whole repo.
 */
const COMMIT_SHA_PREFIX_LENGTH = 7;

/**
 * Distinct prefixes per identity read. Bounds the predicate rather than the
 * payload: `apps/api/AGENTS.md` requires every predicate to be bounded, and the
 * only thing limiting the ref count today is a producer-side courtesy constant.
 */
export const COMMIT_PREFIX_QUERY_CHUNK = 100;

/**
 * Group observations by `(org, repo)` and fold the prefix-compatible ones.
 *
 * Folding reproduces what the serial loop did implicitly: the second reconcile
 * of one commit read back the first's row and merged onto it. Without this a
 * batch carrying both an abbreviated and a full sha for the same commit would
 * insert two rows that never self-heal.
 */
function foldCommitObservations(
  inputs: readonly ReconcileCommitInput[]
): Map<string, CommitScope> {
  const scopes = new Map<string, CommitScope>();
  for (const input of inputs) {
    const repositoryFullName = normalizeRepoFullName(input.repositoryFullName);
    const observation: CommitObservation = {
      ...input,
      repositoryFullName,
      sha: input.sha.toLowerCase(),
    };
    const key = `${input.organizationId}\u0000${repositoryFullName}`;
    const scope = scopes.get(key);
    if (!scope) {
      scopes.set(key, {
        organizationId: input.organizationId,
        repositoryFullName,
        observations: [observation],
      });
      continue;
    }
    const sibling = scope.observations.findIndex((candidate) =>
      isShaPrefixCompatible(candidate.sha, observation.sha)
    );
    if (sibling === -1) {
      scope.observations.push(observation);
      continue;
    }
    scope.observations[sibling] = mergeCommitObservations(
      scope.observations[sibling],
      observation
    );
  }
  return scopes;
}

/** Git identity: one sha is a prefix of the other, within an already-scoped repo. */
function isShaPrefixCompatible(left: string, right: string): boolean {
  return left.startsWith(right) || right.startsWith(left);
}

/**
 * Merge a later observation onto an earlier one, by the same field-level
 * provenance rules the stored-row update uses — so folding in memory and
 * reconciling through the database cannot disagree.
 */
function mergeCommitObservations(
  base: CommitObservation,
  incoming: CommitObservation
): CommitObservation {
  const authoritative = isAuthoritativeCommitSource(incoming.source);
  return {
    ...base,
    sha: incoming.sha.length > base.sha.length ? incoming.sha : base.sha,
    message: pickField(base.message ?? null, incoming.message, authoritative),
    committedAt: pickField(
      base.committedAt ?? null,
      incoming.committedAt,
      authoritative
    ),
    authoredAt: pickField(
      base.authoredAt ?? null,
      incoming.authoredAt,
      authoritative
    ),
    authorName: pickField(
      base.authorName ?? null,
      incoming.authorName,
      authoritative
    ),
    authorEmail: pickField(
      base.authorEmail ?? null,
      incoming.authorEmail,
      authoritative
    ),
    authorLogin: pickField(
      base.authorLogin ?? null,
      incoming.authorLogin,
      authoritative
    ),
    linesAdded: pickField(
      base.linesAdded ?? null,
      incoming.linesAdded,
      authoritative
    ),
    linesRemoved: pickField(
      base.linesRemoved ?? null,
      incoming.linesRemoved,
      authoritative
    ),
    filesChanged: pickField(
      base.filesChanged ?? null,
      incoming.filesChanged,
      authoritative
    ),
    isMerge: pickIsMerge(
      base.isMerge ?? false,
      incoming.isMerge,
      authoritative
    ),
    mergeCommitSha: pickField(
      base.mergeCommitSha ?? null,
      incoming.mergeCommitSha,
      authoritative
    ),
    source: pickSource(base.source, incoming.source) as CommitProvenanceSource,
  };
}

/**
 * Every stored row that could be git-identity-equal to something in this scope,
 * in as few reads as the prefix bound allows.
 *
 * A single distinct prefix keeps the plain `startsWith` predicate — the common
 * case, and the same statement shape the per-commit read issued.
 */
async function loadExistingCommits(
  tx: CommitTx,
  scope: CommitScope
): Promise<CommitDetail[]> {
  const prefixes = [
    ...new Set(
      scope.observations.map((observation) =>
        observation.sha.slice(0, COMMIT_SHA_PREFIX_LENGTH)
      )
    ),
  ];
  const rows: CommitDetail[] = [];
  for (
    let index = 0;
    index < prefixes.length;
    index += COMMIT_PREFIX_QUERY_CHUNK
  ) {
    const chunk = prefixes.slice(index, index + COMMIT_PREFIX_QUERY_CHUNK);
    const shaWhere =
      chunk.length === 1
        ? { sha: { startsWith: chunk[0] } }
        : { OR: chunk.map((prefix) => ({ sha: { startsWith: prefix } })) };
    const found = await tx.commitDetail.findMany({
      where: {
        organizationId: scope.organizationId,
        repositoryFullName: scope.repositoryFullName,
        ...shaWhere,
      },
    });
    rows.push(...found);
  }
  return rows;
}

/**
 * The fullest git-identity-equal row for `sha` within an already-scoped
 * `(org, repo)`: one sha is a prefix of the other. A webhook full-sha row is
 * preferred over a desktop abbrev row, avoiding a needless sha expansion.
 */
function selectPrefixMatch(
  candidates: readonly CommitDetail[],
  sha: string
): CommitDetail | null {
  let match: CommitDetail | null = null;
  for (const candidate of candidates) {
    if (
      isShaPrefixCompatible(candidate.sha, sha) &&
      (match === null || candidate.sha.length > match.sha.length)
    ) {
      match = candidate;
    }
  }
  return match;
}

/** The insert payload for an observation with no stored row yet. */
function buildCommitCreateData(
  observation: CommitObservation
): CommitCreateData {
  return {
    organizationId: observation.organizationId,
    repositoryFullName: observation.repositoryFullName,
    sha: observation.sha,
    branchArtifactId: observation.branchArtifactId,
    source: observation.source,
    message: observation.message ?? null,
    committedAt: observation.committedAt ?? null,
    authoredAt: observation.authoredAt ?? null,
    authorName: observation.authorName ?? null,
    authorEmail: observation.authorEmail ?? null,
    authorLogin: observation.authorLogin ?? null,
    linesAdded: observation.linesAdded ?? null,
    linesRemoved: observation.linesRemoved ?? null,
    filesChanged: observation.filesChanged ?? null,
    isMerge: observation.isMerge ?? false,
    mergeCommitSha: observation.mergeCommitSha ?? null,
  };
}

/**
 * The merge payload for an existing row, or `null` when it would be a no-op.
 *
 * Returning `null` is the batching win on a re-sync: the desktop re-sends its
 * full ref set on every tick, so without this the steady state pays one write
 * per commit to store values the row already holds.
 */
function buildCommitUpdateData(
  existing: CommitDetail,
  observation: CommitObservation
): CommitUpdateData | null {
  const authoritative = isAuthoritativeCommitSource(observation.source);
  const data: CommitUpdateData = {
    sha:
      observation.sha.length > existing.sha.length
        ? observation.sha
        : existing.sha,
    message: pickField(existing.message, observation.message, authoritative),
    committedAt: pickField(
      existing.committedAt,
      observation.committedAt,
      authoritative
    ),
    authoredAt: pickField(
      existing.authoredAt,
      observation.authoredAt,
      authoritative
    ),
    authorName: pickField(
      existing.authorName,
      observation.authorName,
      authoritative
    ),
    authorEmail: pickField(
      existing.authorEmail,
      observation.authorEmail,
      authoritative
    ),
    authorLogin: pickField(
      existing.authorLogin,
      observation.authorLogin,
      authoritative
    ),
    linesAdded: pickField(
      existing.linesAdded,
      observation.linesAdded,
      authoritative
    ),
    linesRemoved: pickField(
      existing.linesRemoved,
      observation.linesRemoved,
      authoritative
    ),
    filesChanged: pickField(
      existing.filesChanged,
      observation.filesChanged,
      authoritative
    ),
    isMerge: pickIsMerge(existing.isMerge, observation.isMerge, authoritative),
    mergeCommitSha: pickField(
      existing.mergeCommitSha,
      observation.mergeCommitSha,
      authoritative
    ),
    source: pickSource(existing.source, observation.source),
  };
  return commitRowMatches(existing, data) ? null : data;
}

/** Whether the stored row already holds exactly what the merge would write. */
function commitRowMatches(
  existing: CommitDetail,
  data: CommitUpdateData
): boolean {
  return (
    existing.sha === data.sha &&
    existing.message === data.message &&
    sameInstant(existing.committedAt, data.committedAt) &&
    sameInstant(existing.authoredAt, data.authoredAt) &&
    existing.authorName === data.authorName &&
    existing.authorEmail === data.authorEmail &&
    existing.authorLogin === data.authorLogin &&
    existing.linesAdded === data.linesAdded &&
    existing.linesRemoved === data.linesRemoved &&
    existing.filesChanged === data.filesChanged &&
    existing.isMerge === data.isMerge &&
    existing.mergeCommitSha === data.mergeCommitSha &&
    existing.source === data.source
  );
}

/** Dates compare by instant; two distinct objects can carry the same time. */
function sameInstant(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.getTime() === right.getTime();
}

/**
 * Every column one `createMany` row binds, named rather than counted.
 *
 * Derived from {@link CommitCreateData} so the budget cannot silently go stale:
 * a new column on the create payload fails `tsc` here until it is named, where
 * a hand-written `16` would simply start under-reserving and push the statement
 * past the ceiling it exists to stay under.
 */
const COMMIT_CREATE_BIND_FIELDS: Record<keyof CommitCreateData, true> = {
  organizationId: true,
  repositoryFullName: true,
  sha: true,
  branchArtifactId: true,
  source: true,
  message: true,
  committedAt: true,
  authoredAt: true,
  authorName: true,
  authorEmail: true,
  authorLogin: true,
  linesAdded: true,
  linesRemoved: true,
  filesChanged: true,
  isMerge: true,
  mergeCommitSha: true,
};

/**
 * Rows one identity-insert statement may carry.
 *
 * `createMany` binds no `where` of its own, so nothing is reserved beyond the
 * headroom {@link bindParameterChunkSize} already keeps for Prisma itself.
 */
export const COMMIT_CREATE_CHUNK = bindParameterChunkSize(
  Object.keys(COMMIT_CREATE_BIND_FIELDS).length,
  0
);
