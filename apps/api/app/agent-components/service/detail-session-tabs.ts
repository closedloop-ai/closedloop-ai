import "server-only";

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS } from "@repo/api/src/types/agent-component";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type { BranchRow } from "@repo/api/src/types/branch";
import { BranchStatus } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import type { withDb } from "@repo/database";
import { agentSessionsService } from "../../agent-sessions/service";
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
 * Hard cap on the number of session artifact ids fanned into the `IN (...)`
 * clauses of the two branch-attribution `artifactLink.findMany` queries. A
 * popular component can be used in thousands of sessions; an unbounded `IN` list
 * bloats the query plan and can exceed parameter limits. The excess sessions
 * still count toward totals — only their per-session branch attribution rows are
 * bounded.
 *
 * ISS-5762: this doc used to claim "most-recently-seen sessions win, since the
 * map is populated in row order", which the SAME FILE contradicts where the
 * slice is taken (see `resolveDetailSessionTabs`): `invCountBySession` is
 * populated from an UNORDERED `groupBy`, so above this bound the retained ids
 * are an arbitrary subset, not a recency head. Both claims cannot be true, and
 * the reassuring one was the false one — which is the specific way a cap
 * misleads even after it stops being silent. The read DOES report the bound
 * (`sessionsTabTruncated` / `branchesTabTruncated`, ISS-5464, measured against
 * the uncapped `invCountBySession.size`) and the tab's notice (ISS-5520) is
 * worded to avoid claiming recency. Making the retained subset genuinely
 * ordered — so the notice may say "most recent" — needs a recency signal
 * plumbed from `UsageGroupRow._max.lastInvokedAt` and an equivalent added to
 * the orphan and plugin-rollup paths, which have none; that is tracked as
 * follow-up work off ISS-5762 rather than done here.
 */
const MAX_DETAIL_SESSION_IN_IDS = 1000;

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

type BranchArtifactLinkRow = {
  target: {
    id: string;
    slug: string | null;
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
 * Fetch the two branch-attribution `artifactLink` result sets for a bounded set
 * of session artifact ids and reduce them to the per-session branch-name map and
 * the deduped `branchesTab`. Extracted so both detail paths share one
 * implementation and each stays under the cognitive-complexity bar.
 */
async function fetchBranchAttribution(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  organizationId: string,
  sessionArtifactIds: string[]
): Promise<{
  branchNameBySession: Map<string, string>;
  branchesTab: BranchRow[];
}> {
  const branchLinks = await db.artifactLink.findMany({
    where: {
      organizationId,
      sourceId: { in: sessionArtifactIds },
      linkType: LinkType.RelatesTo,
    },
    select: {
      sourceId: true,
      metadata: true,
      target: {
        select: {
          branch: {
            select: {
              branchName: true,
            },
          },
        },
      },
    },
  });

  const branchArtifactLinks = await db.artifactLink.findMany({
    where: {
      organizationId,
      sourceId: { in: sessionArtifactIds },
      linkType: LinkType.RelatesTo,
      target: { type: ArtifactType.Branch },
    },
    select: {
      target: {
        select: {
          id: true,
          slug: true,
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

  return {
    branchNameBySession: buildBranchNameBySession(branchLinks),
    branchesTab: buildBranchesTab(
      branchArtifactLinks as BranchArtifactLinkRow[]
    ),
  };
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
    // The bound is applied inside the query on the canonical total ordering, so
    // the retained rows are the recency head of `sessionArtifactIds`. That is
    // NOT necessarily the recency head of the component's sessions: the id list
    // above is `slice`d to `MAX_DETAIL_SESSION_IN_IDS` from an unordered
    // group-by, so above 1000 sessions it is an arbitrary subset. The tab's
    // notice is worded to avoid claiming otherwise.
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
   * Stated here rather than re-derived in the renderer from
   * `AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS`, which only THIS producer
   * honours (desktop caps at nothing, so the renderer's old inference misfired
   * there). See the field docs on `AgentComponentDetail`.
   */
  sessionsTabTruncated: boolean;
  /**
   * ISS-5464: did the `MAX_DETAIL_SESSION_IN_IDS` slice cost this read branches?
   * See the field docs on `AgentComponentDetail`.
   */
  branchesTabTruncated: boolean;
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
 * detail. The session-id fan-out into the branch-attribution `IN (...)` queries
 * (see `MAX_DETAIL_SESSION_IN_IDS`) and the `sessionsTab` read (via the
 * agent-sessions read service, so the list projection is never duplicated) are
 * both driven off `invCountBySession` — the authoritative per-session set that
 * already folds plugin rollup + orphan usage. Returns empty tabs when no
 * sessions invoked the component.
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
  perBranchInvBySession?: Map<string, Map<string, number>>
): Promise<DetailSessionTabs> {
  const sessionArtifactIds = [...invCountBySession.keys()].slice(
    0,
    MAX_DETAIL_SESSION_IN_IDS
  );
  if (sessionArtifactIds.length === 0) {
    return {
      usageSessions: [],
      branchesTab: [],
      sessionsTab: [],
      sessionsTabTruncated: false,
      branchesTabTruncated: false,
    };
  }

  const [{ branchNameBySession, branchesTab }, sessionsTab] = await Promise.all(
    [
      fetchBranchAttribution(db, organizationId, sessionArtifactIds),
      fetchSessionsTab(organizationId, sessionArtifactIds),
    ]
  );

  const perBranch =
    perBranchInvBySession ?? widenToSingleBranchBucket(invCountBySession);

  return {
    usageSessions: buildUsageSessions(perBranch, branchNameBySession),
    branchesTab,
    sessionsTab,
    // Compare against the FULL per-session set, not `sessionArtifactIds`: that
    // array is itself `slice`d to `MAX_DETAIL_SESSION_IN_IDS`, so measuring
    // against it would report "complete" for a component whose sessions were
    // already dropped one bound earlier.
    sessionsTabTruncated: sessionsTab.length < invCountBySession.size,
    // The branch attribution read only ever saw `sessionArtifactIds`. When that
    // slice dropped sessions, any branch reachable only through a dropped one is
    // absent, so the delivered array is a floor rather than the set.
    branchesTabTruncated: sessionArtifactIds.length < invCountBySession.size,
  };
}
