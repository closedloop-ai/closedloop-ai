// Shared building blocks for the two session→PR-link readers
// (agent-session-attribution.ts and agent-session-delivery-metrics.ts). Both
// select links with the SAME session→PR link filter, so that predicate — and the
// merged-PR classification and dedup identity built on it — live here once
// instead of being copy-pasted per reader.
//
// The two readers no longer share a traversal, because they need different
// populations. Attribution is genuinely PER-SESSION (it splits each session's
// cost across its targets), so it pages the matched sessions through
// `visitSessionDetailPages`. The delivery cards need only the DISTINCT merged
// PRs, so ISS-6028 moved them to `findMergedPrsLinkedToSessions`, which reads
// the PR side and semi-joins BACK through the same links rather than draining
// the org's session history to rediscover them.

import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { type Prisma, withDb } from "@repo/database";

/**
 * The canonical `sourceLinks`/`ArtifactLink` WHERE predicate that selects a
 * session→PR link: a RELATES_TO link whose `linkKind` metadata is `SessionPr`.
 * Exported so the attribution and delivery-metrics readers share ONE literal
 * instead of each re-spelling it (previously duplicated four times).
 */
export const SESSION_PR_LINK_WHERE = {
  linkType: LinkType.RelatesTo,
  metadata: {
    path: ["linkKind"],
    equals: SessionArtifactLinkKind.SessionPr,
  },
} as const satisfies Prisma.ArtifactLinkWhereInput;

/**
 * The subset of a branch's `currentPullRequestDetail` needed to decide whether a
 * session→PR link points at a CURRENT, merged PR and to give that PR a stable
 * dedup identity. A structural minimum so both readers below can pass their own
 * (wider) `GetPayload` PR-detail shape — the delivery-metrics select also carries
 * `additions`/`deletions`, which are irrelevant to identity.
 */
export type MergedPrDetail = {
  number: number | null;
  prState: string | null;
  mergedAt: Date | null;
  isCurrent: boolean;
  repositoryFullName: string | null;
  repository: { fullName: string } | null;
} | null;

/**
 * Is a branch's current-PR detail a CURRENT, merged PR? The single merged-PR
 * predicate for readers that classify hydrated rows — today the
 * cohort-performance reader (`collectPrOutcome`), which holds per-session rows
 * anyway. The delivery reader applies the same rule in the database via
 * {@link MERGED_PR_DETAIL_WHERE}. A PR counts as merged only when it is the
 * branch's CURRENT detail, its state is `MERGED`, and it carries a `mergedAt`.
 */
export function isMergedPrDetail(detail: MergedPrDetail): boolean {
  return Boolean(
    detail?.isCurrent &&
      detail.prState === GitHubPRState.Merged &&
      detail.mergedAt !== null
  );
}

/**
 * Prisma mirror of {@link isMergedPrDetail}, for the reader that applies the
 * merged-PR predicate in the DATABASE rather than to hydrated rows (ISS-6028).
 * **Keep the two in lockstep** — a predicate that disagrees with its mirror
 * classifies the same PR as merged in one reader and not the other.
 */
export const MERGED_PR_DETAIL_WHERE = {
  isCurrent: true,
  prState: GitHubPRState.Merged,
  mergedAt: { not: null },
} as const satisfies Prisma.PullRequestDetailWhereInput;

/**
 * Stable dedup identity for a merged PR linked to a session. Keyed on
 * `repo#number` only when BOTH the repo AND the PR number are known; otherwise it
 * falls back to `branch:${targetId}` (the linked branch artifact id). Requiring a
 * non-null `number` is deliberate: keying on `repo#null` whenever the repo alone
 * is known would collapse every number-less PR from a repo into a single bucket
 * and drop all but one from the count/median (the dedup-by-nullable trap). Shared
 * so both the delivery-metrics and cohort-performance readers dedup identically.
 */
export function mergedPrIdentity(
  detail: MergedPrDetail,
  targetId: string
): string {
  const repo =
    detail?.repository?.fullName ?? detail?.repositoryFullName ?? null;
  return repo && detail?.number != null
    ? `${repo.toLowerCase()}#${detail.number}`
    : `branch:${targetId}`;
}

/**
 * The `ArtifactLink` predicate for a session→PR link whose SOURCE session
 * matches `where`. One literal shared by the existence probe and the merged-PR
 * reader below, so the semi-join both run is the same predicate.
 */
export function sessionPrLinkFromSessions(
  where: Prisma.SessionDetailWhereInput
): Prisma.ArtifactLinkWhereInput {
  return {
    ...SESSION_PR_LINK_WHERE,
    source: {
      type: ArtifactType.Session,
      session: { is: where },
    },
  };
}

/**
 * Cheap probe: is there at least one session→PR link whose source session
 * matches `where`? Both readers call this before reading so a broad/unfiltered
 * dashboard with no PR links never issues the row read at all.
 */
export async function hasMatchingSessionPrLinks(
  where: Prisma.SessionDetailWhereInput
): Promise<boolean> {
  const link = await withDb((db) =>
    db.artifactLink.findFirst({
      where: sessionPrLinkFromSessions(where),
      select: { id: true },
    })
  );
  return link !== null;
}

/** Keyset page size for the session→PR-link pager below. */
export const SESSION_PR_LINK_PAGE_SIZE = 200;

/**
 * Generic keyset (cursor) pager over `sessionDetail`, ordered by `artifactId`.
 * Parameterized by the `select` projection and a per-page visitor, so a caller
 * only decides WHICH columns to read and WHAT to do with each page — the bounded
 * "take N, cursor past the last id, stop on a short page" loop lives here once.
 * A heavy org never materializes every matched session in memory at once.
 *
 * For a caller that wants PER-SESSION facts (the attribution lenses). A caller
 * that only wants the linked PRs must NOT page sessions to find them — see
 * {@link findMergedPrsLinkedToSessions} (ISS-6028).
 */
export async function visitSessionDetailPages<
  Select extends Prisma.SessionDetailSelect,
>(
  where: Prisma.SessionDetailWhereInput,
  select: Select,
  visitPage: (
    records: Prisma.SessionDetailGetPayload<{ select: Select }>[]
  ) => void | Promise<void>
): Promise<void> {
  let cursorId: string | undefined;

  for (;;) {
    const page = await withDb((db) =>
      db.sessionDetail.findMany({
        where,
        select,
        orderBy: { artifactId: "asc" },
        take: SESSION_PR_LINK_PAGE_SIZE,
        ...(cursorId ? { cursor: { artifactId: cursorId }, skip: 1 } : {}),
      })
    );
    await visitPage(
      page as Prisma.SessionDetailGetPayload<{ select: Select }>[]
    );

    if (page.length < SESSION_PR_LINK_PAGE_SIZE) {
      return;
    }
    cursorId = (page.at(-1) as { artifactId?: string } | undefined)?.artifactId;
    if (!cursorId) {
      return;
    }
  }
}

/**
 * Narrows a matched-session `where` to only sessions that actually carry a
 * session→PR link, so the pager scans the (typically tiny) linked subset instead
 * of every matched session. Its caller pages over `where` only to accumulate
 * from sessions whose `sourceLinks` match `SESSION_PR_LINK_WHERE` and skips the
 * rest, so restricting the scan at the DB is behavior-preserving — it drops only
 * rows that would contribute nothing — while turning an org-wide N-row scan into
 * one bounded by the number of PR-linked sessions. The `EXISTS` semi-join reuses
 * the SAME predicate the `hasMatchingSessionPrLinks` probe already runs. ANDed
 * (not merged into the incoming `where`) so an existing `artifact` clause on
 * `where` is preserved rather than clobbered.
 */
export function scopeToSessionsWithPrLinks(
  where: Prisma.SessionDetailWhereInput
): Prisma.SessionDetailWhereInput {
  return {
    AND: [
      where,
      { artifact: { sourceLinks: { some: SESSION_PR_LINK_WHERE } } },
    ],
  };
}

/**
 * The linked branch artifacts every merged-PR row carries: the branch artifacts
 * that (a) point at this PR as their current PR and (b) are the target of a
 * session→PR link from a matching session. This is the reversed form of the
 * per-link `targetId` the session-side traversal used to yield, and it is what
 * {@link mergedPrIdentity} needs for its `branch:` fallback identity.
 */
export type LinkedBranchArtifacts = {
  currentForBranches: { artifactId: string }[];
};

/**
 * Every DISTINCT merged PR in `organizationId` linked to the sessions matching
 * `where`, read from the PR side (ISS-6028).
 *
 * This replaces a session-side drain. The delivery scope deliberately carries no
 * session-activity date window, so paging every PR-linked session in the org —
 * each hydrating a `sourceLinks → target → branch → currentPullRequestDetail`
 * relation tree — grew monotonically forever to feed a fixed-size card. Reading
 * the PR side instead semi-joins BACK through the same links and returns
 * O(merged PRs in scope) narrow rows instead of O(PR-linked sessions) hydrated
 * ones. The predicate is unchanged, just relocated: {@link MERGED_PR_DETAIL_WHERE}
 * mirrors `isMergedPrDetail`, and the `currentForBranches` semi-join mirrors the
 * `link.target.branch.currentPullRequestDetail` traversal (the branch's OWN
 * current-PR pointer, not the PR's `branchArtifactId`, which is a different
 * column and can name a different branch).
 *
 * Deliberately UNCAPPED (no `take`): `mergedPrCount` and `medianPrSize` are
 * whole-population aggregates over the scope, so a page cap would silently
 * understate both rather than bound anything the caller could report as partial.
 * The population is the card's own answer — one row per merged PR, five scalars
 * wide — not an unbounded scan of a growing session history.
 */
export function findMergedPrsLinkedToSessions<
  Select extends Prisma.PullRequestDetailSelect,
>(
  organizationId: string,
  where: Prisma.SessionDetailWhereInput,
  select: Select
): Promise<
  (Prisma.PullRequestDetailGetPayload<{ select: Select }> &
    LinkedBranchArtifacts)[]
> {
  const linkedBranches = {
    artifact: { targetLinks: { some: sessionPrLinkFromSessions(where) } },
  } satisfies Prisma.BranchDetailWhereInput;
  return withDb((db) =>
    db.pullRequestDetail.findMany({
      where: {
        // The row's own denormalized org column, not just the org the caller's
        // session `where` carries: it keeps the read tenant-scoped in the query
        // itself, and it is the leading column of
        // `@@index([organizationId, prState, mergedAt])` — the index shape this
        // predicate was built for. Scoping only through the joined branch
        // artifact cannot use it (see the index note in schema.prisma).
        organizationId,
        ...MERGED_PR_DETAIL_WHERE,
        currentForBranches: { some: linkedBranches },
      },
      select: {
        ...select,
        // Same filter as the semi-join above: a PR can be the current PR of a
        // branch NOT linked to a matching session, and that branch must not
        // contribute a `branch:` identity the session-side traversal never saw.
        currentForBranches: {
          where: linkedBranches,
          select: { artifactId: true },
        },
      },
    })
  ) as Promise<
    (Prisma.PullRequestDetailGetPayload<{ select: Select }> &
      LinkedBranchArtifacts)[]
  >;
}
