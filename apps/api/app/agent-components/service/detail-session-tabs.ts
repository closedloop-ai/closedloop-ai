import "server-only";

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS } from "@repo/api/src/types/agent-component";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { BranchRow } from "@repo/api/src/types/branch";
import { BranchStatus } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import type { withDb } from "@repo/database";
import { branchPushEvidenceWhere } from "@/app/branches/branch-push-evidence";
import { agentSessionsService } from "../../agent-sessions/service";
import type { SessionTabCursor } from "../component-detail-cursor";
import type { UsageGroupRow } from "../identity";

/**
 * @file detail-session-tabs.ts
 * @description The per-session detail-tab lane extracted from the agent-components
 * detail read (ISS-4404): folds usage groups into per-(session, branch)
 * invocation maps, resolves branch attribution, and assembles the
 * `usageSessions` / `branchesTab` / `sessionsTab` payloads. Consumed by
 * `detail-read.ts`. Behaviour is unchanged from the original in-service helpers.
 */

/**
 * ISS-9855: the branch-attribution read walks EVERY session that invoked the
 * component, in chunks of this many ids per `IN (...)` — a bind-parameter
 * bound, not a truncation (`POSTGRES_MAX_BIND_PARAMETERS` in
 * `../org-population-reads` is the ceiling; do not restate the number here).
 * Same shape as `SESSION_LOC_ID_CHUNK_SIZE` over the same id list.
 */
export const SESSION_BRANCH_ATTRIBUTION_ID_CHUNK_SIZE = 1000;

export function buildInvCountBySession(
  usageGroups: UsageGroupRow[]
): Map<string, number> {
  const invCountBySession = new Map<string, number>();
  for (const group of usageGroups) {
    const prev = invCountBySession.get(group.agentSessionId) ?? 0;
    invCountBySession.set(
      group.agentSessionId,
      prev + (group._sum.invocationCount ?? 0)
    );
  }
  return invCountBySession;
}

/**
 * ISS-9855: the max `lastInvokedAt` per session across all usage groups.
 * Used by {@link resolveDetailSessionTabs} to sort sessions by recency so the
 * retained page is the most-recently-invoked head, not an arbitrary subset.
 */
export function buildSessionLastInvokedMap(
  usageGroups: UsageGroupRow[]
): Map<string, Date | null> {
  const map = new Map<string, Date | null>();
  for (const group of usageGroups) {
    recordSessionLastInvoked(
      map,
      group.agentSessionId,
      group._max.lastInvokedAt
    );
  }
  return map;
}

/**
 * ISS-9855: fold one usage row's `lastInvokedAt` into a per-session recency
 * map, keeping the max. A session can carry rows in several lanes (FK-linked,
 * orphan, plugin child); every lane records through this one helper.
 */
export function recordSessionLastInvoked(
  map: Map<string, Date | null>,
  sessionId: string,
  lastInvokedAt: Date | null
): void {
  const prev = map.get(sessionId);
  if (
    prev === undefined ||
    (lastInvokedAt && (!prev || lastInvokedAt > prev))
  ) {
    map.set(sessionId, lastInvokedAt);
  }
}

/**
 * FEA-2990: '' is the "no per-event branch" sentinel used by
 * {@link buildPerBranchInvBySession} / {@link buildUsageSessions} to mark a
 * usage bucket that carried no per-event git_branch (Codex, legacy pre-column
 * events, non-tool kinds). Those buckets fall back to session-level
 * `SessionBranch` attribution at read time.
 */
const NO_BRANCH_SENTINEL = "";

/**
 * FEA-2990: fold usage rows into per-(session, branch) invocation counts. A
 * session that switched branches mid-run yields multiple non-'' buckets;
 * branch-less usage collapses into the '' bucket. {@link buildUsageSessions}
 * resolves '' to the session-level branch and emits the finer split otherwise.
 */
export function buildPerBranchInvBySession(
  usageGroups: UsageGroupRow[]
): Map<string, Map<string, number>> {
  const perBranch = new Map<string, Map<string, number>>();
  // Each grouped row is already one (session, branch) bucket (grouped rows are
  // org-scoped by the `groupBy`'s `where`), so it folds straight in — the DB has
  // done the per-(session, branch) sum the nested walk used to do in JS.
  for (const group of usageGroups) {
    addPerBranchInvocation(
      perBranch,
      group.agentSessionId,
      group.gitBranch,
      group._sum.invocationCount ?? 0
    );
  }
  return perBranch;
}

/** Accumulate one usage row's invocations into the per-(session, branch) map. */
export function addPerBranchInvocation(
  perBranch: Map<string, Map<string, number>>,
  sessionId: string,
  gitBranch: string | null | undefined,
  invocationCount: number
): void {
  const branch = gitBranch ?? NO_BRANCH_SENTINEL;
  let byBranch = perBranch.get(sessionId);
  if (!byBranch) {
    byBranch = new Map<string, number>();
    perBranch.set(sessionId, byBranch);
  }
  byBranch.set(branch, (byBranch.get(branch) ?? 0) + invocationCount);
}

type BranchLinkRow = {
  sourceId: string;
  metadata: unknown;
  target: {
    branch: {
      branchName: string;
    } | null;
  } | null;
};

function buildBranchNameBySession(
  branchLinks: BranchLinkRow[]
): Map<string, string> {
  const branchNameBySession = new Map<string, string>();
  for (const link of branchLinks) {
    const meta = link.metadata as Record<string, unknown> | null;
    if (!meta) {
      continue;
    }

    const linkKind = meta.linkKind as string | undefined;
    const linkKinds = meta.linkKinds as string[] | undefined;
    const isSessionBranch =
      linkKind === SessionArtifactLinkKind.SessionBranch ||
      (Array.isArray(linkKinds) &&
        linkKinds.includes(SessionArtifactLinkKind.SessionBranch));

    if (!isSessionBranch) {
      continue;
    }
    if (branchNameBySession.has(link.sourceId)) {
      continue; // first link wins
    }

    const branchName =
      (meta.branchName as string | undefined) ??
      link.target?.branch?.branchName ??
      null;

    if (branchName) {
      branchNameBySession.set(link.sourceId, branchName);
    }
  }
  return branchNameBySession;
}

/**
 * FEA-2990: build usageSessions from per-(session, branch) usage. For each
 * session, every non-'' branch bucket becomes its own entry attributed to the
 * precise per-event branch; the '' bucket (branch-less usage) falls back to the
 * session-level `SessionBranch` branch. A multi-branch session therefore emits
 * one entry per branch it actually ran on, while legacy/Codex sessions (only a
 * '' bucket) keep exactly one session-level entry as before.
 */
function buildUsageSessions(
  perBranchInvBySession: Map<string, Map<string, number>>,
  branchNameBySession: Map<string, string>
): AgentComponentDetail["usageSessions"] {
  const usageSessions: AgentComponentDetail["usageSessions"] = [];
  for (const [sessionId, byBranch] of perBranchInvBySession.entries()) {
    const fallbackBranch = branchNameBySession.get(sessionId) ?? null;
    // Resolve each bucket to its final branchName FIRST, then fold by the
    // resolved name so a session never emits two rows for the same branch: the
    // '' bucket resolves to the session-level fallback, which can collide with a
    // real per-event bucket of that same branch — summing here prevents the
    // double-count. Key by a sentinel for the null fallback so branch-less usage
    // with no SessionBranch link still merges into a single row.
    const NULL_BRANCH_KEY = "\u0000null";
    const invByResolvedBranch = new Map<
      string,
      { branchName: string | null; invocationCount: number }
    >();
    for (const [branch, invCount] of byBranch.entries()) {
      // '' → session-level fallback (legacy/Codex); a real per-event branch
      // wins over it, giving invocation-granularity attribution.
      const resolved = branch === NO_BRANCH_SENTINEL ? fallbackBranch : branch;
      const key = resolved ?? NULL_BRANCH_KEY;
      const existing = invByResolvedBranch.get(key);
      if (existing) {
        existing.invocationCount += invCount;
      } else {
        invByResolvedBranch.set(key, {
          branchName: resolved,
          invocationCount: invCount,
        });
      }
    }
    for (const {
      branchName,
      invocationCount,
    } of invByResolvedBranch.values()) {
      usageSessions.push({ sessionId, branchName, invocationCount });
    }
  }
  // Sort by invocation count descending for consistent ordering, tie-broken by
  // sessionId then branchName so multi-branch rows have a stable order.
  usageSessions.sort(
    (a, b) =>
      b.invocationCount - a.invocationCount ||
      a.sessionId.localeCompare(b.sessionId) ||
      (a.branchName ?? "").localeCompare(b.branchName ?? "")
  );
  return usageSessions;
}

/**
 * ISS-9114: the single branch-attribution row — the union projection of what the
 * two former reads selected, so one read answers both the per-session
 * branch-name map and the `branchesTab`. `target.type` is carried because the
 * `branchesTab` half is Branch-targets-only while the branch-name half is not.
 */
type BranchAttributionRow = {
  sourceId: string;
  metadata: unknown;
  target: {
    id: string;
    slug: string | null;
    type: string;
    branch: {
      artifactId: string;
      branchName: string;
      repositoryFullName: string | null;
      baseBranch: string | null;
      lastActivityAt: Date | null;
      firstPushedAt: Date | null;
    } | null;
  } | null;
};

/** The half of {@link BranchAttributionRow} the `branchesTab` fold reads. */
type BranchArtifactLinkRow = Omit<
  BranchAttributionRow,
  "sourceId" | "metadata"
>;

function buildBranchesTab(
  branchArtifactLinks: BranchArtifactLinkRow[]
): BranchRow[] {
  const branchesTab: BranchRow[] = [];
  const seenBranchIds = new Set<string>();
  for (const link of branchArtifactLinks) {
    const branch = link.target?.branch;
    const artifactId = link.target?.id;
    if (!(branch && artifactId) || seenBranchIds.has(artifactId)) {
      continue;
    }
    seenBranchIds.add(artifactId);

    branchesTab.push({
      id: link.target?.slug ?? artifactId,
      branchName: branch.branchName,
      baseBranch: branch.baseBranch,
      repoFullName: branch.repositoryFullName,
      owner: null,
      status: BranchStatus.Open,
      prNumber: null,
      prTitle: null,
      prState: null,
      prUrl: null,
      multiPrWarning: false,
      checksStatus: null,
      checksPassed: null,
      checksTotal: null,
      reviewDecision: null,
      ahead: null,
      behind: null,
      additions: null,
      deletions: null,
      filesChanged: null,
      estimatedCostUsd: null,
      lastActivityAt: (
        branch.lastActivityAt ??
        branch.firstPushedAt ??
        new Date()
      ).toISOString(),
      sessionIds: [],
    });
  }

  return branchesTab;
}

/**
 * Fetch the branch-attribution `artifactLink` rows for EVERY session artifact
 * id and reduce them to the per-session branch-name map and the deduped
 * `branchesTab`. Extracted so both detail paths share one implementation and
 * each stays under the cognitive-complexity bar.
 *
 * ISS-9855: the id list is the component's whole session set, read in
 * {@link SESSION_BRANCH_ATTRIBUTION_ID_CHUNK_SIZE} chunks folded into ONE row
 * list. Chunks run sequentially and the chunk count is unbounded, the same
 * trade `loadSessionLocCost` makes on this id list: a fan-out would cost one
 * pooled connection per chunk, and a work budget would be the terminal cap
 * PRD-666 forbids. The desktop producer (`local-detail-session-tabs.ts`)
 * attributes every session too, so both surfaces now speak one population.
 */
async function fetchBranchAttribution(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  sessionArtifactIds: string[],
  requirePushEvidence: boolean
): Promise<{
  branchNameBySession: Map<string, string>;
  branchesTab: BranchRow[];
}> {
  const branchLinks: BranchAttributionRow[] = [];
  for (
    let start = 0;
    start < sessionArtifactIds.length;
    start += SESSION_BRANCH_ATTRIBUTION_ID_CHUNK_SIZE
  ) {
    const idChunk = sessionArtifactIds.slice(
      start,
      start + SESSION_BRANCH_ATTRIBUTION_ID_CHUNK_SIZE
    );
    const rows = await fetchBranchAttributionChunk(
      db,
      organizationId,
      idChunk,
      requirePushEvidence
    );
    branchLinks.push(...rows);
  }

  return {
    branchNameBySession: buildBranchNameBySession(branchLinks),
    branchesTab: buildBranchesTab(
      branchLinks.filter((link) => link.target?.type === ArtifactType.Branch)
    ),
  };
}

/** One bind-sized `IN (...)` page of the branch-attribution read. */
function fetchBranchAttributionChunk(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  sessionArtifactIds: string[],
  requirePushEvidence: boolean
): Promise<BranchAttributionRow[]> {
  // ISS-8148 (PRD-683 D7), behind the same read-side flag as the insights
  // donuts: a legacy no-push-evidence branch is excluded from BOTH
  // attribution reads — the Branches tab below AND the usage-row branch-name
  // fallback here — so the two panels on one detail page speak one
  // population. The row keeps its session links and heals into view when
  // push evidence arrives.
  //
  // ISS-9114: ONE read over the wider of the two former predicates. The
  // branch-name half never constrained `target.type`, so it is the superset;
  // the `branchesTab` half is that set narrowed to Branch targets, which the
  // filter below applies to the same rows instead of re-selecting the scope.
  return db.artifactLink.findMany({
    where: {
      organizationId,
      sourceId: { in: sessionArtifactIds },
      linkType: LinkType.RelatesTo,
      ...(requirePushEvidence
        ? {
            target: {
              type: ArtifactType.Branch,
              branch: { is: branchPushEvidenceWhere() },
            },
          }
        : {}),
    },
    select: {
      sourceId: true,
      metadata: true,
      target: {
        select: {
          id: true,
          slug: true,
          type: true,
          branch: {
            select: {
              artifactId: true,
              branchName: true,
              repositoryFullName: true,
              baseBranch: true,
              lastActivityAt: true,
              firstPushedAt: true,
            },
          },
        },
      },
    },
  });
}

/**
 * Fetch the org-scoped `sessionsTab` (full `AgentSessionListItem` summaries) for
 * the sessions that invoked this component, reusing the agent-sessions read
 * service so the projection is never duplicated. The `Sessions` detail tab
 * renders exactly this field (`agent-detail.tsx`), so it must be populated from
 * the same session-id set already aggregated for `usageSessions` (FEA-2923).
 */
function fetchSessionsTab(
  organizationId: string,
  sessionArtifactIds: string[]
): Promise<AgentComponentDetail["sessionsTab"]> {
  return agentSessionsService.listByArtifactIds(
    organizationId,
    sessionArtifactIds,
    // ISS-5464: bound the PAYLOAD, not the truth. The detail's `sessions` field
    // remains the full uncapped count; only the individual session summaries are
    // bounded, to the number the Sessions tab renders.
    //
    // ISS-9855: `sessionArtifactIds` is now the recency-ordered page (the 50
    // most-recently-invoked sessions), not an arbitrary slice. The bound below
    // is redundant but preserved defensively — `listSessionsByArtifactIds`
    // already reorders by `SESSION_DEFAULT_ORDER_BY` inside the query.
    AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
  );
}

/**
 * The three per-session detail tab payloads: the sessions-with-usage rows,
 * the linked branches summary, and the full session list-item summaries the
 * `Sessions` tab renders. Shared return shape for both the inventory-present
 * and orphan-only (#2613) detail paths.
 */
type DetailSessionTabs = {
  usageSessions: AgentComponentDetail["usageSessions"];
  branchesTab: BranchRow[];
  sessionsTab: AgentComponentDetail["sessionsTab"];
  /**
   * ISS-5464: does `sessionsTab` carry fewer sessions than used this component?
   * Stated by the PRODUCER (see field docs on `AgentComponentDetail`).
   * ISS-9855: now measured against the recency-ordered render page rather than
   * an arbitrary slice — still true when more sessions exist than the page shows.
   */
  sessionsTabTruncated: boolean;
  /**
   * ISS-5464: does `branchesTab` carry fewer branches than the full set?
   * ISS-9855: always `false` from this producer — the attribution read walks
   * every session. Kept on the wire because the field is a shared contract
   * with the desktop producer and the tab reads it.
   */
  branchesTabTruncated: boolean;
  /**
   * ISS-9855: keyset cursor encoding the position of the last session on this
   * page. `null` when all sessions fit on one page. The sessions continuation
   * endpoint validates and resumes this tuple without requiring its row to exist.
   */
  nextCursor: string | null;
};

/**
 * Widen a plain per-session invocation map into the per-(session, branch) shape
 * `buildUsageSessions` consumes, placing every session's whole count in the
 * {@link NO_BRANCH_SENTINEL} bucket. That bucket resolves to the session-level
 * `SessionBranch` fallback at read time, so the result is identical to the
 * pre-FEA-2990 session-level attribution. Used for paths with no per-event
 * git_branch signal (plugins roll up child usage with no branch dimension; the
 * orphan-only synthetic detail).
 */
function widenToSingleBranchBucket(
  invCountBySession: Map<string, number>
): Map<string, Map<string, number>> {
  const perBranch = new Map<string, Map<string, number>>();
  for (const [sessionId, invCount] of invCountBySession.entries()) {
    perBranch.set(sessionId, new Map([[NO_BRANCH_SENTINEL, invCount]]));
  }
  return perBranch;
}

/**
 * Resolve `usageSessions`, `branchesTab`, and `sessionsTab` for a component
 * detail. ISS-9855: sessions are sorted by recency (`lastInvokedAt` DESC,
 * `artifactId` ASC) so the `sessionsTab` render page (via the agent-sessions
 * read service, so the list projection is never duplicated) is the
 * most-recently-invoked head rather than an arbitrary subset. The
 * branch-attribution read is NOT paged: it walks the whole session set, so
 * `branchesTab` and the `usageSessions` branch names cover every session.
 *
 * FEA-2990: `usageSessions` is built from `perBranchInvBySession` when the caller
 * has per-event git_branch data, splitting a multi-branch session by the branch
 * each invocation ran on; the `''` bucket falls back to the session-level branch.
 * When no branch dimension is available (plugins, orphan-only detail) the caller
 * omits it and we widen `invCountBySession` into a single `''` bucket per
 * session, reproducing the pre-feature session-level attribution exactly.
 */
export async function resolveDetailSessionTabs(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  invCountBySession: Map<string, number>,
  requirePushEvidence: boolean,
  perBranchInvBySession?: Map<string, Map<string, number>>,
  sessionLastInvoked?: Map<string, Date | null>,
  cursor?: SessionTabCursor
): Promise<DetailSessionTabs> {
  // ISS-9855: sort all session IDs by recency (lastInvokedAt DESC, artifactId
  // ASC) so the render page is the most-recently-invoked head. With no recency
  // map every time is null, so the order falls through to artifactId ASC.
  const recency = sessionLastInvoked ?? new Map<string, Date | null>();
  const sortedSessionIds = [...invCountBySession.keys()].sort((a, b) => {
    const aTime = recency.get(a)?.getTime() ?? null;
    const bTime = recency.get(b)?.getTime() ?? null;
    if (aTime !== null && bTime !== null && aTime !== bTime) {
      return bTime - aTime;
    }
    if (aTime === null && bTime !== null) {
      return 1;
    }
    if (bTime === null && aTime !== null) {
      return -1;
    }
    return a < b ? -1 : 1;
  });
  const remainingSessionIds = cursor
    ? sortedSessionIds.filter((id) =>
        sessionFollowsCursor(id, recency.get(id) ?? null, cursor)
      )
    : sortedSessionIds;
  const sessionArtifactIds = remainingSessionIds.slice(
    0,
    AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
  );
  if (sessionArtifactIds.length === 0) {
    return {
      usageSessions: [],
      branchesTab: [],
      sessionsTab: [],
      sessionsTabTruncated: false,
      branchesTabTruncated: false,
      nextCursor: null,
    };
  }

  const [{ branchNameBySession, branchesTab }, sessionsTab] = await Promise.all(
    [
      fetchBranchAttribution(
        db,
        organizationId,
        sortedSessionIds,
        requirePushEvidence
      ),
      fetchSessionsTab(organizationId, sessionArtifactIds),
    ]
  );

  const perBranch =
    perBranchInvBySession ?? widenToSingleBranchBucket(invCountBySession);

  // Continue from the last requested identity even if a session failed hydration.
  const lastOnPage = sessionArtifactIds.at(-1) ?? null;
  const hasMoreSessions =
    remainingSessionIds.length > sessionArtifactIds.length;
  const nextCursor =
    hasMoreSessions && lastOnPage
      ? encodeSessionTabCursor(recency.get(lastOnPage) ?? null, lastOnPage)
      : null;

  return {
    usageSessions: buildUsageSessions(perBranch, branchNameBySession),
    branchesTab,
    sessionsTab,
    // ISS-9855: compare against the FULL per-session set. True whenever more
    // sessions exist than the page shows. The page is recency-ordered, but the
    // readout still must not say "most recent": the desktop reader drops ids
    // it cannot hydrate, so the shown rows are not guaranteed to be the head.
    sessionsTabTruncated: sessionsTab.length < invCountBySession.size,
    // ISS-9855: the branch attribution read walked every session, so the
    // delivered array is the set, not a floor. Stated as `false` rather than
    // dropped: the desktop producer emits the same field, and the tab reads it.
    branchesTabTruncated: false,
    nextCursor,
  };
}

/**
 * ISS-9855: encode a keyset cursor for the component-detail sessions tab.
 * Opaque to the client — encodes (lastInvokedAt, artifactId) so a future
 * endpoint can resume the recency walk.
 */
function encodeSessionTabCursor(
  lastInvokedAt: Date | null,
  artifactId: string
): string {
  return Buffer.from(
    JSON.stringify({
      t: lastInvokedAt?.toISOString() ?? null,
      id: artifactId,
    })
  ).toString("base64url");
}

function sessionFollowsCursor(
  id: string,
  lastInvokedAt: Date | null,
  cursor: SessionTabCursor
): boolean {
  const cursorTime = cursor.t === null ? null : Date.parse(cursor.t);
  const time = lastInvokedAt?.getTime() ?? null;
  if (cursorTime === null) {
    return time === null && id > cursor.id;
  }
  if (time === null) {
    return true;
  }
  return time < cursorTime || (time === cursorTime && id > cursor.id);
}
