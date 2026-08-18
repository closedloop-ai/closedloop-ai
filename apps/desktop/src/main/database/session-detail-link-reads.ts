/**
 * @file session-detail-link-reads.ts
 * @description The session-scoped `session_artifact_links` reads the session
 * DETAIL needs, which the batch `loadSyncedSessions` hydrate cannot answer.
 *
 * Named for that job rather than for one of its reads (it was
 * `session-branch-link-read.ts` until ISS-5617 added the second): both reads are
 * single-session, both exist because the detail needs something the batch loader
 * either does not carry or carries in a SYNC-shaped form, and both are composed
 * into `createSqliteSessionSyncSource` so the grandfathered `sync-source.ts`
 * carries the wiring while this module carries the queries.
 *
 * Its natural neighbours are the branch serving reads in `./branch-reads.ts`,
 * whose shrink-only facade retains the shared public types while focused
 * database responsibilities live in sibling modules. This module returns that
 * facade's `BranchKeyRow` — the one declaration of a branch identity in the
 * desktop main process, which the sync-source port re-exports under its own name
 * rather than re-declaring (see `SessionBranchLinkKey`).
 */
import {
  ArtifactRefTargetKind,
  MAX_SYNCED_ARTIFACT_REFS,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import type { BranchKeyRow } from "./branch-reads.js";
import {
  BRANCH_PUSH_METHOD_VALUES,
  BRANCH_WRITE_METHOD_VALUES,
} from "./db-constants.js";
import type { DbHostPrisma } from "./prisma-client.js";

/**
 * Upper bound on the branch-write links scanned for one session. A session's
 * branch writes are a handful; the cap only exists so a pathological corpus
 * cannot turn a detail open into an unbounded read. Ordered newest-observed
 * first, so a truncated scan keeps the links most likely to name the branch on
 * display.
 */
export const SESSION_BRANCH_LINK_KEY_SCAN_LIMIT = 50;

/**
 * The branch-artifact identities behind ONE session's branch writes — the
 * `(repoFullName, branchName)` pairs the desktop Branches list keys its
 * `encodeBranchId` route ids on, newest-observed first and de-duplicated.
 *
 * The session detail's Branch row links to `/branches/<encodeBranchId(key)>`, and
 * that route resolves through `getSharedBranchDetail` → the SAME
 * `(repoFullName, branchName)` predicate `readLocalBranchLinkRowsForBranch` uses.
 * So the id must be built from the BRANCH ARTIFACT's repo, not the session's
 * `attribution.repositoryFullName`: the two are resolved by independent paths
 * (worktree remote vs. the artifact-ref repo resolver, which can persist a NULL
 * `repo_full_name`), and a disagreement would mint an id no branch answers to.
 * Reading the artifact row is what makes the link exact rather than inferred.
 *
 * Returns the CANDIDATES rather than a single winner (stage review on #4650).
 * A `take: 1` on `observedAt DESC` was not a decision the store can make: the
 * same branch NAME can legitimately hold two artifact rows, because
 * `computeIdentityKey` scopes a branch as `branch:<repoFullName ?? gitDir ?? "">:
 * <branchName>` — one row scoped to `owner/repo`, one to a gitDir with a NULL
 * `repo_full_name` (the artifact-ref resolver's cold-registry case). The Branches
 * list groups on `(repoFullName, branchName)`, so those are two DIFFERENT rows,
 * and `encodeBranchId` mints two different ids. Picking by recency alone would
 * silently address whichever row was observed last — and on an `observed_at` tie,
 * whichever the engine happened to return, so one session's Branch row could
 * address two different branch records on two loads. Which candidate the pane
 * means is a DISPLAY question (it depends on the repository the same pane is
 * showing), so the caller decides; see `resolveSessionBranchRouteId`.
 *
 * The internal corpus matches `readLocalBranchLinkRows`: every active Wrote
 * link remains available for denominator authority. Publication and
 * default-branch eligibility are deliberately applied by the Product-facing
 * caller.
 */
export function readSessionBranchLinkKeys(
  prisma: DbHostPrisma,
  sessionId: string
): Promise<BranchKeyRow[]> {
  return prisma.client.sessionArtifactLink
    .findMany({
      where: {
        sessionId,
        method: { in: [...BRANCH_WRITE_METHOD_VALUES] },
        artifact: {
          kind: ArtifactRefTargetKind.Branch,
          branchName: { not: null },
        },
      },
      select: {
        artifact: {
          select: {
            repoFullName: true,
            branchName: true,
            firstPushedAt: true,
            artifactLinks: {
              where: { method: { in: [...BRANCH_PUSH_METHOD_VALUES] } },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ observedAt: "desc" }],
      take: SESSION_BRANCH_LINK_KEY_SCAN_LIMIT,
    })
    .then((rows) => dedupeBranchKeys(rows));
}

/**
 * Collapse the link rows to DISTINCT `(repoFullName, branchName)` identities,
 * preserving the newest-observed-first order the query returned. Several links
 * (a commit and a push, say) routinely name the same artifact, and the caller
 * reasons about how many DISTINCT branch records could answer the row — a
 * duplicate would read as an ambiguity that does not exist.
 */
function dedupeBranchKeys(
  rows: ReadonlyArray<{
    artifact: {
      repoFullName: string | null;
      branchName: string | null;
      firstPushedAt: string | null;
      artifactLinks: Array<{ id: string }>;
    };
  }>
): BranchKeyRow[] {
  const byKey = new Map<string, BranchKeyRow>();
  for (const row of rows) {
    const { branchName, repoFullName } = row.artifact;
    if (!branchName) {
      continue;
    }
    // A NUL separator cannot occur in a repo path or a git ref, so it cannot
    // make two different identities collide the way a `/` or `:` separator
    // could. Written as the `\u0000` escape, never a raw byte (source gate).
    const dedupeKey = `${repoFullName ?? ""}\u0000${branchName}`;
    const candidate = {
      repoFullName: repoFullName ?? null,
      branchName,
      hasLocalPublication:
        row.artifact.firstPushedAt !== null ||
        row.artifact.artifactLinks.length > 0,
    };
    const current = byKey.get(dedupeKey);
    if (
      !current ||
      (current.hasLocalPublication !== true &&
        candidate.hasLocalPublication === true)
    ) {
      byKey.set(dedupeKey, candidate);
    }
  }
  return [...byKey.values()];
}

/**
 * Upper bound on the DOCUMENT links scanned for one session.
 *
 * Deliberately the CLOUD contract's own ceiling ({@link MAX_SYNCED_ARTIFACT_REFS},
 * 500) rather than a display- or sync-producer-sized number. This read exists to
 * report a total the sync-shaped payload cannot, so a small cap here would just
 * reintroduce the bug it fixes; and a session whose links exceed what the cloud
 * validator would ever accept for it cannot show more on web either, so stopping
 * at the same ceiling cannot make the desktop under-report RELATIVE TO WEB. The
 * cap is only a guard against a pathological corpus turning a detail open into an
 * unbounded read.
 */
export const SESSION_DOCUMENT_LINK_SCAN_LIMIT = MAX_SYNCED_ARTIFACT_REFS;

/**
 * ISS-5617: ONE session's `closedloop_artifact` links, UNBOUNDED by the sync
 * producer's ref budget.
 *
 * Why this read exists at all. The detail's `linkedArtifacts` used to be folded
 * from `SyncedAgentSession.artifactRefs`, which `loadSyncedSessions` has already
 * passed through `boundNonCommitArtifactRefs` — a 100-slot budget SHARED with
 * branch and PR refs, inside which documents are only guaranteed a floor of 50.
 * That budget is a SYNC-WIRE concern (it keeps a new desktop from emitting an
 * array an old cloud would reject), and it has no business shaping a purely
 * LOCAL read. A session with 60 document refs and 50 branch/PR refs kept just 50
 * documents, and the detail then presented that capped set as the whole truth:
 * the Properties row rendered "+44" where the honest answer was "+54", making ten
 * of the user's own linked artifacts unreachable with nothing on screen saying so.
 *
 * Returns `SyncedArtifactRef`s rather than a bare count so the caller folds them
 * with the SAME `projectLocalLinkedArtifacts` it folds the served set with. A
 * `COUNT(*)` would have had to re-implement that fold's two rules in SQL — the
 * document-prefix gate and the identity-slug dedup (`FEA-1952` and `ISS-1952` are
 * one artifact) — and a re-implementation is exactly how a total drifts from the
 * list it counts.
 *
 * Ordered `createdAt asc` to match the batch loader's own
 * `ORDER BY sal.created_at ASC`, so first-wins role precedence resolves
 * identically whichever path produced the refs.
 */
export function readSessionDocumentArtifactRefs(
  prisma: DbHostPrisma,
  sessionId: string
): Promise<SyncedArtifactRef[]> {
  return prisma.client.sessionArtifactLink
    .findMany({
      where: {
        sessionId,
        artifact: {
          kind: ArtifactRefTargetKind.ClosedloopArtifact,
          slug: { not: null },
        },
      },
      select: {
        isPrimary: true,
        method: true,
        artifact: { select: { slug: true } },
      },
      orderBy: [{ createdAt: "asc" }],
      take: SESSION_DOCUMENT_LINK_SCAN_LIMIT,
    })
    .then((rows) => rows.flatMap((row) => toDocumentArtifactRef(row)));
}

/**
 * One link row as the `closedloop_artifact` ref shape the projection folds.
 *
 * `flatMap`-shaped (`[]` for a slug-less row) rather than a cast: the `slug` is
 * nullable in the store and the `not: null` predicate above is a QUERY promise
 * the TYPE does not carry, so this is where the two are reconciled honestly
 * instead of with a non-null assertion.
 */
function toDocumentArtifactRef(row: {
  isPrimary: boolean;
  method: string;
  artifact: { slug: string | null };
}): SyncedArtifactRef[] {
  const slug = row.artifact.slug;
  if (!slug) {
    return [];
  }
  return [
    {
      kind: ArtifactRefTargetKind.ClosedloopArtifact,
      slug,
      isPrimary: row.isPrimary,
      method: row.method,
    },
  ];
}

/**
 * The sync source's slice of these reads, composed into
 * `createSqliteSessionSyncSource` the way `createSyncBurndownReaders` is — so the
 * grandfathered `sync-source.ts` carries the wiring and this module carries the
 * queries.
 */
export function createSessionDetailLinkReaders(prisma: DbHostPrisma): {
  loadSessionBranchLinkKeys: (sessionId: string) => Promise<BranchKeyRow[]>;
  loadSessionDocumentArtifactRefs: (
    sessionId: string
  ) => Promise<SyncedArtifactRef[]>;
} {
  return {
    loadSessionBranchLinkKeys: (sessionId: string) =>
      readSessionBranchLinkKeys(prisma, sessionId),
    loadSessionDocumentArtifactRefs: (sessionId: string) =>
      readSessionDocumentArtifactRefs(prisma, sessionId),
  };
}
