// FEA-4270 — the per-EVENT SPEND window for the Branches usage/analytics reads.
// Extracted from `branch-read-service.ts` so that grandfathered file stays under
// its shrink-only ceiling.
//
// ISS-4813: these exports are PRIVATE INTERNALS of the `branch-read-service`
// surface, not a route-facing sibling service, so per `apps/api/AGENTS.md` they
// live in the composition root's nested directory
// (`app/branches/branch-read-service/`) rather than as a flat sibling — the
// `app/agent-sessions/` PLN-1305 pattern. `branch-read-service.ts` stays the
// only route-consumed export; this module must not import it back.
//
// A usage/analytics date filter (startDate/endDate)
// narrows the branch candidate set on `b.last_activity_at`, but a matched
// branch's linked sessions still span its whole lifetime — and a single
// long-running session's spend accrues across MANY hours. These helpers bound
// the SPEND itself by each usage EVENT's own `eventCreatedAt`
// (`AgentSessionTokenEvent`), so a windowed AI-spend figure counts only the
// cost/tokens from turns that actually happened inside the window — a session
// that began before the window but ran into it contributes exactly its in-window
// turns, not all-or-nothing by session start. Meanwhile `branch-read-service`
// keeps the branch's lifetime session metadata (sessionIds/dataState/owner)
// intact.

import { LinkType } from "@repo/api/src/types/artifact";
import {
  isMeteredBillingMode,
  isSubscriptionBillingMode,
} from "@repo/api/src/types/billing-mode";
import {
  type BranchPageDetail,
  BranchParticipationKind,
} from "@repo/api/src/types/branch";
import {
  aggregateBranchCostCompleteness,
  type BranchCostCompletenessResult,
  type BranchCostEvidenceContribution,
} from "@repo/api/src/types/branch-usage";
import {
  deriveBranchParticipationFromMetadata,
  parseSessionPrLinkMetadata,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { ArtifactType, type Prisma, type PrismaClient } from "@repo/database";
import { deriveBranchLifecyclePhaseSegments } from "@repo/lib/branches/branch-lifecycle-phase";
import type { BranchPhaseLifecycleEvent } from "@repo/lib/branches/branch-phase-attribution";
import { resolveSessionEventEvidence } from "../branch-session-cost-evidence";

export type SessionUsageDateWindow = {
  startDate?: Date;
  endDate?: Date;
};

/** Per-session windowed spend totals: the SUM of a session's token/cost events
 * whose `eventCreatedAt` fell inside the active window. Keyed by session artifact
 * id in `getSessionUsageByBranch`, and substituted for the session's LIFETIME
 * totals when a window is active so branch spend counts only in-window turns. */
export type WindowedSessionSpend = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
};

/**
 * FEA-4270: lift the usage/analytics date filter off a branch list query as a
 * per-event spend window. The same startDate/endDate that narrows the branch
 * candidate set (`b.last_activity_at`) must ALSO bound the linked-session spend,
 * or a windowed view reports lifetime cost. `getBranchDetail` has no date filter
 * and does not use this. Returns `undefined` when both ends are open (the
 * un-windowed fast path — no per-event query, LIFETIME session totals stand).
 */
export function sessionUsageDateWindow(query: {
  startDate?: Date;
  endDate?: Date;
}): SessionUsageDateWindow | undefined {
  if (!(query.startDate || query.endDate)) {
    return;
  }
  return { startDate: query.startDate, endDate: query.endDate };
}

/**
 * FEA-4270: does this usage EVENT's own timestamp fall inside the spend window?
 * Anchored on the per-event `eventCreatedAt` (`AgentSessionTokenEvent`) — the
 * instant that turn's spend accrued — NOT the owning session's start. So a
 * long-running session split across the window boundary contributes only the
 * turns inside the range; turns before/after are excluded even though the
 * session as a whole overlaps.
 *
 * No window (undefined / both ends open) → always in-window (the caller takes the
 * un-windowed lifetime fast path and never calls this).
 *
 * Null/undefined event timestamp under an ACTIVE window → EXCLUDED.
 * `eventCreatedAt` is a non-null column so this is defensive, but an event with
 * an UNKNOWN timestamp cannot be proven to fall inside a bounded window, so a
 * date-bounded spend metric must drop it rather than silently miscount it
 * (AGENTS.md date-bounded null-exclusion convention). Bounds are inclusive on
 * both ends, matching the `b.last_activity_at >= start` / `<= end` candidate
 * predicate.
 */
export function tokenEventInDateWindow(
  eventCreatedAt: Date | null | undefined,
  dateWindow: SessionUsageDateWindow | undefined
): boolean {
  if (!(dateWindow?.startDate || dateWindow?.endDate)) {
    return true;
  }
  if (!eventCreatedAt) {
    return false;
  }
  if (dateWindow.startDate && eventCreatedAt < dateWindow.startDate) {
    return false;
  }
  if (dateWindow.endDate && eventCreatedAt > dateWindow.endDate) {
    return false;
  }
  return true;
}

/** A single per-event token/cost row folded into a session's windowed spend. */
export type SessionSpendEvent = {
  agentSessionId: string;
  eventCreatedAt: Date | null;
  inputTokens: bigint | number;
  outputTokens: bigint | number;
  cacheReadTokens: bigint | number;
  cacheWriteTokens: bigint | number;
  estimatedCost: { toString(): string } | number | null;
};

/**
 * FEA-4270: fold per-event token/cost rows into per-session windowed spend
 * totals, counting ONLY events whose `eventCreatedAt` is in-window
 * (`tokenEventInDateWindow`). The result map is keyed by session artifact id;
 * a session with zero in-window events is simply absent from the map, so the
 * caller reads it as zero windowed spend (its lifetime metadata still stands).
 * The windowed total reconciles with the in-window events because it IS their
 * sum — null-timestamp events are dropped from both the total and the shown set.
 */
export function windowedSpendBySession(
  events: readonly SessionSpendEvent[],
  dateWindow: SessionUsageDateWindow | undefined
): Map<string, WindowedSessionSpend> {
  const bySession = new Map<string, WindowedSessionSpend>();
  for (const event of events) {
    if (!tokenEventInDateWindow(event.eventCreatedAt, dateWindow)) {
      continue;
    }
    const spend = bySession.get(event.agentSessionId) ?? emptyWindowedSpend();
    spend.inputTokens += Number(event.inputTokens);
    spend.outputTokens += Number(event.outputTokens);
    spend.cacheReadTokens += Number(event.cacheReadTokens);
    spend.cacheWriteTokens += Number(event.cacheWriteTokens);
    spend.estimatedCostUsd += numberFromDecimal(event.estimatedCost);
    bySession.set(event.agentSessionId, spend);
  }
  return bySession;
}

/** A zeroed windowed-spend accumulator — the starting point for a session's
 * fold, and the value a session with no in-window events resolves to. */
export function emptyWindowedSpend(): WindowedSessionSpend {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
  };
}

/** Sum of a resolved session-spend's token/cost fields — used to decide whether
 * a windowed write session has any in-window spend at all. */
export function totalSessionSpend(spend: WindowedSessionSpend): number {
  return (
    spend.inputTokens +
    spend.outputTokens +
    spend.cacheReadTokens +
    spend.cacheWriteTokens +
    spend.estimatedCostUsd
  );
}

// The usage-window helpers only read links and per-event token/cost rows, so
// they take a narrow two-delegate client rather than the branch-read
// subsystem's broad `BranchReadClient` — unrelated query dependencies stay out
// of this module (wongk review, #4207). The broad client that fans out across
// the rest of the branch-read surface lives with `branch-read-service.ts`, and
// a broad client is structurally assignable to this narrow parameter.
export type SessionUsageClient = Pick<
  PrismaClient,
  "$queryRaw" | "agentSessionTokenEvent" | "artifactLink"
>;

/** Read one Branch corpus and fold its cost evidence through the shared contract. */
export async function getSessionUsageWithCostCompleteness(
  db: SessionUsageClient,
  organizationId: string,
  branchIds: string[],
  dateWindow: SessionUsageDateWindow | undefined
): Promise<{
  usageByBranch: Map<string, SessionUsage>;
  costCompleteness: BranchCostCompletenessResult;
}> {
  const costEvidence: BranchCostEvidenceContribution[] = [];
  const usageByBranch = await getSessionUsageByBranch(
    db,
    organizationId,
    branchIds,
    { dateWindow, costEvidenceOut: costEvidence }
  );
  return {
    usageByBranch,
    costCompleteness: aggregateBranchCostCompleteness(costEvidence),
  };
}

export function sessionLinkWhere(
  organizationId: string,
  branchIds: string[],
  options: {
    includeReviewedParticipation?: boolean;
  } = {}
): Prisma.ArtifactLinkWhereInput {
  return {
    organizationId,
    targetId: { in: branchIds },
    linkType: LinkType.RelatesTo,
    AND: [
      { OR: sessionBranchUsageLinkKindWhere() },
      { OR: sessionBranchParticipationWhere(options) },
    ],
    source: {
      organizationId,
      type: ArtifactType.SESSION,
      // FEA-4263 invariant: an orphaned/half-synced link whose source SESSION
      // carries no `SessionDetail` row is NOT a valid session (matches the
      // `accumulateSessionLink` fold that skips `source.session == null`).
      // Filtering it here — at the shared link-query boundary — keeps orphans
      // from consuming a cap slot BEFORE the JS hydration check (which would let
      // a newer orphan evict a valid older session from the capped trace set).
      //
      // FEA-4270: the usage/analytics date window is deliberately NOT applied
      // here. A windowed spend figure must not drop the branch's lifetime link
      // metadata (its `sessionIds`, dominant owner, `Ready`/`NoSessions` data
      // state, and the session rows the detail page lists) — a branch that was
      // active in-window but whose sessions all started before the window would
      // otherwise return zero links and render as `NoSessions` with a null owner
      // (P1: chatgpt-codex #3667842008). So we load every lifetime link and let
      // `accumulateSessionLink` bound only the COST/TOKEN accumulation by each
      // usage event's `eventCreatedAt` (see `tokenEventInDateWindow` +
      // `windowedSpendBySession`), leaving identity metadata lifetime-accurate
      // while spend reflects the per-event window.
      session: { isNot: null },
    },
    target: {
      organizationId,
      type: ArtifactType.BRANCH,
    },
  };
}

export function sessionBranchUsageLinkKindWhere(): Prisma.ArtifactLinkWhereInput[] {
  return [
    {
      metadata: {
        path: ["linkKind"],
        equals: SessionArtifactLinkKind.SessionPr,
      },
    },
    {
      metadata: {
        path: ["linkKind"],
        equals: SessionArtifactLinkKind.SessionBranch,
      },
    },
  ];
}

export function sessionBranchParticipationWhere(
  options: { includeReviewedParticipation?: boolean } = {}
): Prisma.ArtifactLinkWhereInput[] {
  const legacyOrWritten: Prisma.ArtifactLinkWhereInput[] = [
    { branchParticipation: BranchParticipationKind.Wrote },
    // Pre-FEA-3820 branch links carried only linkKind metadata. Preserve their
    // historical active-link behavior rather than hiding old branch sessions.
    { branchParticipation: null },
  ];
  if (!options.includeReviewedParticipation) {
    return legacyOrWritten;
  }
  return [
    ...legacyOrWritten,
    { branchParticipation: BranchParticipationKind.Reviewed },
  ];
}

// Bound the `targetId IN (...)` list of the session-link lookup. The full-set
// usage/analytics reads pass every filtered branch id at once (FEA-2538), which
// for large orgs would blow past Postgres bind limits and the serverless
// request's memory/time budget in one unbounded query. Chunking keeps full-set
// semantics: branch ids partition cleanly across chunks (each targetId lives in
// exactly one chunk), so accumulation into one map needs no cross-chunk merge.
export const SESSION_USAGE_BRANCH_ID_CHUNK_SIZE = 1000;

export async function getSessionUsageByBranch(
  db: SessionUsageClient,
  organizationId: string,
  branchIds: string[],
  options: {
    includeReviewedParticipation?: boolean;
    dateWindow?: SessionUsageDateWindow;
    // ISS-4632: when provided AND a window is active, the same one-scan links are
    // folded a second time (lifetime, no window) INTO this map — see the fold
    // below. Left empty when no window is active (windowed == lifetime).
    lifetimeOut?: Map<string, SessionUsage>;
    /** Receives the corpus-wide event evidence for the Branch summary fold. */
    costEvidenceOut?: BranchCostEvidenceContribution[];
    /**
     * Receives persisted Session→Branch identity evidence from this same scan.
     * Reviewed participation is included in the query when this collector is
     * present, but remains excluded from usage unless explicitly requested.
     */
    identityEvidenceOut?: SessionBranchIdentityEvidence[];
  } = {}
): Promise<Map<string, SessionUsage>> {
  const usageByBranch = new Map<string, SessionUsage>();
  // Track seen session ids per branch with a Set for O(1) dedup, avoiding an
  // O(S²) linear scan of usage.sessionIds on every link (perf-pete FEA-2544).
  // The Set map lives outside the chunk loop so dedup stays correct even if a
  // branch's session links were to span chunk boundaries.
  const seenSessionIdsByBranch = new Map<string, Set<string>>();
  // FEA-4270: under an ACTIVE window, spend is the SUM of a session's per-event
  // rows whose `eventCreatedAt` is in-window — NOT its lifetime session totals —
  // so a long-running session's cost splits across windows by turn. We collect
  // every branch-linked session's chunk of links first, then run ONE per-event
  // read across the whole distinct session set, then fold. With no window the
  // map is undefined and the loop takes the lifetime fast path (no extra query).
  const allLinks: SessionUsageLink[] = [];
  for (
    let start = 0;
    start < branchIds.length;
    start += SESSION_USAGE_BRANCH_ID_CHUNK_SIZE
  ) {
    const idChunk = branchIds.slice(
      start,
      start + SESSION_USAGE_BRANCH_ID_CHUNK_SIZE
    );
    const links = await db.artifactLink.findMany({
      where: sessionLinkWhere(organizationId, idChunk, {
        includeReviewedParticipation:
          options.includeReviewedParticipation ||
          options.identityEvidenceOut !== undefined,
      }),
      select: {
        targetId: true,
        sourceId: true,
        branchParticipation: true,
        branchParticipationMethod: true,
        branchParticipationObservedAt: true,
        metadata: true,
        source: {
          select: {
            name: true,
            slug: true,
            session: {
              select: {
                artifactId: true,
                externalSessionId: true,
                harness: true,
                sessionStartedAt: true,
                sessionEndedAt: true,
                estimatedCost: true,
                inputTokens: true,
                outputTokens: true,
                cacheReadTokens: true,
                cacheWriteTokens: true,
                // ISS-5445: the session's stored billing mode, needed so the
                // org-level usage fold can split subscription-covered from
                // metered API spend with the SAME canonical classifier the
                // desktop projection uses. Before this it was not selected at
                // all, so `getBranchUsage` had nothing to classify on and
                // hardcoded the subscription total to 0 — every dollar,
                // including Pro/Max/seat sessions, was reported as API spend.
                // Nullable: a legacy row with no captured mode classifies as
                // neither bucket (unknown ledger) and counts only toward total.
                billingMode: true,
                // Owner attribution (FEA-3457): the session's opaque owner id,
                // tallied into ownerCounts below. Nullable — a session with no
                // captured owner contributes no owner vote.
                userId: true,
              },
            },
          },
        },
      },
    });
    for (const link of links) {
      allLinks.push(link);
      if (link.source.session) {
        options.identityEvidenceOut?.push({
          targetId: link.targetId,
          sourceId: link.sourceId,
          branchParticipationMethod: link.branchParticipationMethod,
          branchParticipationObservedAt: link.branchParticipationObservedAt,
          userId: link.source.session.userId,
        });
      }
    }
  }
  const sessionById = new Map<string, LinkedSession>();
  for (const link of allLinks) {
    const participation = branchParticipationForLink(link);
    if (
      link.source.session &&
      (participation !== BranchParticipationKind.Reviewed ||
        options.includeReviewedParticipation)
    ) {
      sessionById.set(link.source.session.artifactId, link.source.session);
    }
  }
  const eventEvidence =
    options.dateWindow || options.costEvidenceOut
      ? await resolveSessionEventEvidence(
          db,
          organizationId,
          [...sessionById.values()],
          options.dateWindow
        )
      : { contributions: [] };
  options.costEvidenceOut?.push(...eventEvidence.contributions);
  foldLinksIntoUsage(usageByBranch, seenSessionIdsByBranch, allLinks, {
    includeReviewedParticipation: options.includeReviewedParticipation,
    dateWindow: options.dateWindow,
    windowedSpend: eventEvidence.windowedSpend,
  });
  // ISS-4632 (wongk/shafty023 review): when a window is active AND the caller
  // asked for the lifetime counterpart (`options.lifetimeOut`), fold the SAME
  // already-scanned links a second time WITHOUT `windowedSpend` (so
  // `accumulateSessionLink` takes the lifetime path) — no extra artifactLink scan,
  // no second per-event read. This replaces the previous second
  // `getSessionUsageByBranch` call, which re-scanned the identical links purely to
  // build the lifetime map: it doubled the chunked scan on every date-filtered
  // list page + analytics request (wongk) and added a SECOND failure point on the
  // fatal `/branches` path for a Value-per-$-only enrichment (shafty023). With no
  // window the lifetime map EQUALS the windowed one, so `getBranchLifetimeUsage`
  // aliases it and this second fold never runs.
  if (options.lifetimeOut && eventEvidence.windowedSpend !== undefined) {
    foldLinksIntoUsage(options.lifetimeOut, new Map(), allLinks, {
      includeReviewedParticipation: options.includeReviewedParticipation,
      // No `dateWindow`/`windowedSpend` → the lifetime fold.
    });
  }
  return usageByBranch;
}

/**
 * Fold a pre-scanned batch of session→branch links into a per-branch usage map
 * (extracted from `getSessionUsageByBranch` so the same links can be folded more
 * than once — e.g. the ISS-4632 windowed + lifetime passes — without re-querying).
 */
function foldLinksIntoUsage(
  usageByBranch: Map<string, SessionUsage>,
  seenSessionIdsByBranch: Map<string, Set<string>>,
  links: readonly SessionUsageLink[],
  options: {
    includeReviewedParticipation?: boolean;
    dateWindow?: SessionUsageDateWindow;
    windowedSpend?: Map<string, WindowedSessionSpend>;
  }
): void {
  for (const link of links) {
    const usage = usageByBranch.get(link.targetId) ?? emptyUsage();
    let seenSessionIds = seenSessionIdsByBranch.get(link.targetId);
    if (!seenSessionIds) {
      seenSessionIds = new Set<string>();
      seenSessionIdsByBranch.set(link.targetId, seenSessionIds);
    }
    accumulateSessionLink(usage, link, seenSessionIds, {
      includeReviewedParticipation: options.includeReviewedParticipation,
      dateWindow: options.dateWindow,
      windowedSpend: options.windowedSpend,
    });
    usageByBranch.set(link.targetId, usage);
  }
}

/**
 * ISS-4632: the WINDOWED usage map and its LIFETIME counterpart over the SAME
 * branch/session set from ONE artifactLink scan. With no active window the two are
 * identical, so `lifetime` ALIASES `windowed` (no second fold). Under a window the
 * lifetime map is folded from the same one-scan links (see `getSessionUsageByBranch`
 * `lifetimeOut`) — no second query and no independent failure domain.
 */
export async function getBranchLifetimeUsage(
  db: SessionUsageClient,
  organizationId: string,
  branchIds: string[],
  dateWindow: SessionUsageDateWindow | undefined,
  identityEvidenceOut?: SessionBranchIdentityEvidence[]
): Promise<{
  windowed: Map<string, SessionUsage>;
  lifetime: Map<string, SessionUsage>;
}> {
  if (dateWindow === undefined) {
    const windowed = await getSessionUsageByBranch(
      db,
      organizationId,
      branchIds,
      { identityEvidenceOut }
    );
    return { windowed, lifetime: windowed };
  }
  const lifetime = new Map<string, SessionUsage>();
  const windowed = await getSessionUsageByBranch(
    db,
    organizationId,
    branchIds,
    { dateWindow, lifetimeOut: lifetime, identityEvidenceOut }
  );
  return { windowed, lifetime };
}

type SessionUsageLink = {
  // The branch (link target) this session→branch link points at. Selected by the
  // `getSessionUsageByBranch` query and used to bucket usage per branch once all
  // links are gathered (FEA-4270 collects every chunk's links before the single
  // per-event spend read).
  targetId: string;
  sourceId: string;
  branchParticipation: string | null;
  branchParticipationMethod: string | null;
  branchParticipationObservedAt: Date | null;
  metadata: Prisma.JsonValue | null;
  source: {
    name: string;
    slug: string | null;
    session: {
      artifactId: string;
      externalSessionId: string;
      harness: string;
      sessionStartedAt: Date;
      sessionEndedAt: Date | null;
      estimatedCost: { toString(): string } | number;
      inputTokens: bigint | number;
      outputTokens: bigint | number;
      cacheReadTokens: bigint | number;
      cacheWriteTokens: bigint | number;
      // ISS-5445 — the stored `billing_mode`, used to split subscription-covered
      // from metered API spend in `sumDistinctSessionUsage`. Nullable: legacy
      // rows predate billing-mode capture and classify into neither bucket.
      billingMode: string | null;
      userId: string | null;
    } | null;
  };
};

/** Persisted fields required by the Branch identity projector. */
export type SessionBranchIdentityEvidence = {
  targetId: string;
  sourceId: string;
  branchParticipationMethod: string | null;
  branchParticipationObservedAt: Date | null;
  userId: string | null;
};

/**
 * Fold one session→branch link into a branch's running usage: dedups the session
 * (per-branch), tallies the owner vote ONCE per distinct session (FEA-3457), and
 * accumulates the session's tokens/cost. Extracted from getSessionUsageByBranch
 * to keep that function under the cognitive-complexity budget.
 *
 * FEA-4270: a date window bounds only SPEND, never identity. Every valid lifetime
 * link still records its session id, owner vote, and `sessions[]` row so the
 * branch's `sessionIds`/`dataState`/owner and the detail's session list stay
 * lifetime-accurate (a branch active in-window whose sessions all ran before it
 * must not read as `NoSessions` — P1 chatgpt-codex #3667842008). Under an active
 * window a write session contributes only the token/cost of its EVENTS whose
 * `eventCreatedAt` fell in-window (`windowedSpend`, keyed by session id); a
 * long-running session's spend therefore splits across windows by turn instead of
 * counting all-or-nothing by session start. A session with no in-window events
 * still records its `sessions[]` row (windowed spend zeroed, cost null) and its
 * identity metadata, but adds nothing to the branch's token/cost totals. So
 * metadata is lifetime while spend is per-event windowed, in ONE extra read.
 */
function accumulateSessionLink(
  usage: SessionUsage,
  link: SessionUsageLink,
  seenSessionIds: Set<string>,
  options: {
    includeReviewedParticipation?: boolean;
    dateWindow?: SessionUsageDateWindow;
    windowedSpend?: Map<string, WindowedSessionSpend>;
  } = {}
): void {
  const session = link.source.session;
  // FEA-4263 invariant: a branch is first-class (renders a full detail page /
  // counts a session) only when it relates to ≥1 VALID session. A session→branch
  // `ArtifactLink` whose source SESSION artifact carries no `SessionDetail` row
  // (an orphaned/half-synced link) is NOT a valid session — the `source.session`
  // relation is null. Skipping it up front keeps such a link out of `sessionIds`
  // and the owner tallies, so a branch whose only links are orphaned resolves to
  // `sessionIds: []` → `deriveDataState` returns `NoSessions` (the honest empty
  // state) instead of `Ready` (a full detail page over zero real sessions —
  // exactly the PR #3786 violation). Previously the id was pushed BEFORE this
  // null check, inflating the count. Degrades gracefully: no data is mutated, the
  // branch re-hydrates the instant its session's detail row lands.
  if (!session) {
    return;
  }
  const participation = branchParticipationForLink(link);
  if (
    participation === BranchParticipationKind.Reviewed &&
    !options.includeReviewedParticipation
  ) {
    return;
  }
  // Normal list/analytics reads count only write participation. The detail read
  // explicitly opts reviewed participation into the same spend population so a
  // successful reviewed-only Session's Review subtotal reconciles with the
  // Branch header; owner attribution remains write-only below.
  const isWriteParticipation =
    participation !== BranchParticipationKind.Reviewed;
  const reportsSpend =
    isWriteParticipation || Boolean(options.includeReviewedParticipation);
  // FEA-4270: the spend a write session contributes. With NO active window it is
  // the session's LIFETIME totals; under a window it is the per-event sum whose
  // `eventCreatedAt` fell in-window (resolved once in `getSessionUsageByBranch`).
  // A windowed session with zero in-window events is absent from the map → zero
  // spend, so its cost/tokens drop out while its identity metadata stays. This
  // splits a long-running session's spend across windows by turn, instead of the
  // old all-or-nothing gate on session start.
  const windowed = Boolean(
    options.dateWindow?.startDate || options.dateWindow?.endDate
  );
  const spend = resolveSessionSpend(session, options.windowedSpend, windowed);
  // A write session's `sessions[]` row reports the resolved spend's tokens
  // (windowed sum under a window, lifetime otherwise). Its `estimatedCostUsd` is
  // that cost, but stays NULL for a windowed write session with ZERO in-window
  // spend — an honest "no spend in this window" rather than a computed "$0.00" —
  // A non-windowed participating session's cost is always shown.
  const hasWindowedSpend = totalSessionSpend(spend) > 0;
  const reportsCost = reportsSpend && (!windowed || hasWindowedSpend);
  // Under an active window, the write session's `sessions[]` tokens are the
  // windowed sum; without a window they are the lifetime totals.
  const usesWindowedTokens = reportsSpend && windowed;
  // Owner tally + byActor attribution follow write-participation IDENTITY, which
  // is lifetime (a windowed spend view still knows who owns the branch's
  // sessions), so they key off `isWriteParticipation`, not the windowed spend.
  const isFirstSessionEvidence = !seenSessionIds.has(link.sourceId);
  const writeSessionIds = usage.writeSessionIds ?? new Set<string>();
  usage.writeSessionIds = writeSessionIds;
  const sessionRowsById =
    usage.sessionRowsById ??
    new Map(usage.sessions.map((row) => [row.sessionId, row]));
  usage.sessionRowsById = sessionRowsById;
  if (isFirstSessionEvidence) {
    seenSessionIds.add(link.sourceId);
    usage.sessionIds.push(link.sourceId);
  }
  if (isWriteParticipation && !writeSessionIds.has(link.sourceId)) {
    writeSessionIds.add(link.sourceId);
    tallyDistinctSessionOwner(usage, session, isWriteParticipation);
  }
  appendLifecycleEvents(usage, link.sourceId, link);
  if (!isFirstSessionEvidence) {
    const existingSession = sessionRowsById.get(link.sourceId);
    if (existingSession) {
      mergeSessionParticipation(existingSession, participation);
      attachMergedLifecyclePhaseSegments(existingSession, usage, session);
    }
    return;
  }
  const sessionRow = buildSessionUsageRow(link, session, {
    participation,
    reportsCost,
    usesWindowedTokens,
    spend,
  });
  attachMergedLifecyclePhaseSegments(sessionRow, usage, session);
  usage.sessions.push(sessionRow);
  sessionRowsById.set(link.sourceId, sessionRow);
  // ISS-5445 — recorded on the FIRST evidence for this session, alongside the
  // row it classifies, so the map's keys track `usage.sessions` exactly. Keyed
  // by `session.artifactId` (=== `link.sourceId`, and === `sessionRow.sessionId`)
  // so it aligns with the identity `sumDistinctSessionUsage` de-dupes on.
  // Deliberately NOT gated on `reportsSpend`: a session that reports no spend
  // still contributes 0 to whichever bucket it belongs to, and gating here would
  // silently drop its classification.
  usage.sessionBillingModeById.set(
    session.artifactId,
    session.billingMode ?? null
  );
  if (!reportsSpend) {
    return;
  }
  usage.inputTokens += spend.inputTokens;
  usage.outputTokens += spend.outputTokens;
  usage.cacheReadTokens += spend.cacheReadTokens;
  usage.cacheWriteTokens += spend.cacheWriteTokens;
  usage.estimatedCostUsd += spend.estimatedCostUsd;
}

/**
 * FEA-4270: the token/cost a write session contributes to branch spend. Lifetime
 * totals with no active window; the per-event windowed sum otherwise. A windowed
 * session with no in-window events (absent from the map) resolves to all-zero, so
 * it drops out of branch spend and reports a zeroed/null-cost `sessions[]` row.
 */
function resolveSessionSpend(
  session: LinkedSession,
  windowedSpend: Map<string, WindowedSessionSpend> | undefined,
  windowed: boolean
): WindowedSessionSpend {
  if (windowed) {
    return windowedSpend?.get(session.artifactId) ?? emptyWindowedSpend();
  }
  return {
    inputTokens: Number(session.inputTokens),
    outputTokens: Number(session.outputTokens),
    cacheReadTokens: Number(session.cacheReadTokens),
    cacheWriteTokens: Number(session.cacheWriteTokens),
    estimatedCostUsd: numberFromDecimal(session.estimatedCost),
  };
}

export type LinkedSession = NonNullable<SessionUsageLink["source"]["session"]>;

/**
 * Tally a distinct linked session's owner ONCE (FEA-3457). A branch can carry
 * several session_pr link rows for the same session, so a per-link tally would
 * let one user's duplicate links outvote other linked owners. Owner attribution
 * is LIFETIME identity (a windowed spend view still knows who owns the branch),
 * so it keys off write-participation, never the date window. Mirrors the desktop
 * producer's per-session owner count.
 */
function tallyDistinctSessionOwner(
  usage: SessionUsage,
  session: LinkedSession,
  isWriteParticipation: boolean
): void {
  if (!isWriteParticipation) {
    return;
  }
  const ownerUserId = session.userId ?? null;
  if (ownerUserId) {
    usage.ownerCounts.set(
      ownerUserId,
      (usage.ownerCounts.get(ownerUserId) ?? 0) + 1
    );
  }
  // Record this distinct session's owner (by session artifact id) for the byActor
  // rollup — keyed off the session's own artifactId so it aligns with the
  // `sessions[].sessionId` the usage summary de-dupes on.
  usage.sessionOwnerById.set(session.artifactId, ownerUserId);
}

/**
 * Build one `sessions[]` row. FEA-4270: `spend` carries the session's resolved
 * token/cost — the PER-EVENT windowed sum under an active window, the lifetime
 * totals otherwise. `reportsCost` shows that cost (a reviewed session, or a
 * windowed write session with zero in-window spend, shows null cost — an honest
 * "no in-window spend", never a computed $0.00). `usesWindowedTokens` renders the
 * windowed token sum for a write session under a window (so windowed token totals
 * via sumDistinctSessionUsage / buildBranchByActor match), while reviewed sessions
 * and the un-windowed detail path keep their lifetime raw-token row unchanged.
 */
function buildSessionUsageRow(
  link: SessionUsageLink,
  session: LinkedSession,
  flags: {
    participation: BranchParticipationKind | undefined;
    reportsCost: boolean;
    usesWindowedTokens: boolean;
    spend: WindowedSessionSpend;
  }
): SessionUsage["sessions"][number] {
  const { participation, reportsCost, usesWindowedTokens, spend } = flags;
  const tokens = usesWindowedTokens
    ? spend
    : {
        inputTokens: Number(session.inputTokens),
        outputTokens: Number(session.outputTokens),
        cacheReadTokens: Number(session.cacheReadTokens),
        cacheWriteTokens: Number(session.cacheWriteTokens),
      };
  return {
    sessionId: session.artifactId,
    slug: link.source.slug,
    name: link.source.name,
    navigableRef: link.source.slug ?? session.artifactId,
    ...(session.externalSessionId
      ? { externalSessionId: session.externalSessionId }
      : {}),
    harness: session.harness,
    startedAt: toIso(session.sessionStartedAt),
    endedAt: session.sessionEndedAt ? toIso(session.sessionEndedAt) : null,
    isPrimary: false,
    estimatedCostUsd: reportsCost ? spend.estimatedCostUsd : null,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheWriteTokens: tokens.cacheWriteTokens,
    ...(participation ? { participation } : {}),
    ownerUserId: session.userId ?? null,
    // FEA-3576 — resolved lazily by the detail read from `sessionOwnerById`
    // (session artifact id → owner user id → display name). Placeholder null so
    // the row is honest until (and unless) the owner resolves; the list/usage
    // reads that build sessions but never surface the timeline leave it null.
    ownerUserName: null,
  };
}

export function branchParticipationForLink(
  link: Pick<SessionUsageLink, "branchParticipation" | "metadata">
) {
  if (link.branchParticipation === BranchParticipationKind.Wrote) {
    return BranchParticipationKind.Wrote;
  }
  if (link.branchParticipation === BranchParticipationKind.Reviewed) {
    return BranchParticipationKind.Reviewed;
  }
  return deriveBranchParticipationFromMetadata(
    parseSessionPrLinkMetadata(link.metadata)
  );
}

function mergeSessionParticipation(
  session: SessionUsage["sessions"][number],
  participation: BranchParticipationKind | undefined
): void {
  if (
    participation === BranchParticipationKind.Wrote &&
    session.participation !== BranchParticipationKind.Wrote
  ) {
    session.participation = BranchParticipationKind.Wrote;
  }
}

function attachMergedLifecyclePhaseSegments(
  row: SessionUsage["sessions"][number],
  usage: SessionUsage,
  session: LinkedSession
): void {
  const events = usage.lifecycleEventsBySession?.get(session.artifactId) ?? [];
  const phaseSegments = deriveBranchLifecyclePhaseSegments({
    events,
    sessionStartedAt: toIso(session.sessionStartedAt),
    sessionEndedAt: session.sessionEndedAt
      ? toIso(session.sessionEndedAt)
      : null,
  });
  if (phaseSegments.length > 0) {
    row.phaseSegments = phaseSegments;
  }
}

export function emptyUsage(): SessionUsage {
  return {
    sessionIds: [],
    sessions: [],
    ownerCounts: new Map(),
    sessionOwnerById: new Map(),
    sessionBillingModeById: new Map(),
    lifecycleEventsBySession: new Map(),
    sessionRowsById: new Map(),
    writeSessionIds: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
  };
}

/**
 * Usage totals across DISTINCT sessions — each session counted ONCE no matter
 * how many branches it touched.
 *
 * NOT a fold over `usageByBranch.values()`: per-branch usage is ATTRIBUTION — a
 * session linked to N branches contributes its full tokens and cost to each of
 * those N branches, so column-summing the map multiplies every shared session by
 * N. Within one branch, `getSessionUsageByBranch` deduplicates every derived
 * session/token/cost output by canonical Session identity. The desktop producer
 * already counts each session once —
 * see `sumStoredBranchCost` in apps/desktop/src/main/shared-branches-api.ts —
 * so this keeps the web AI-spend KPI and usage summary reconciled with it and
 * with the agent dashboard.
 */
export function sumDistinctSessionUsage(
  usageByBranch: Map<string, SessionUsage>
): DistinctUsageTotals {
  const totals: DistinctUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    subscriptionEstimatedCostUsd: 0,
    apiEstimatedCostUsd: 0,
  };
  const seen = new Set<string>();
  for (const usage of usageByBranch.values()) {
    for (const session of usage.sessions) {
      if (seen.has(session.sessionId)) {
        continue;
      }
      seen.add(session.sessionId);
      totals.inputTokens += session.inputTokens;
      totals.outputTokens += session.outputTokens;
      totals.cacheReadTokens += session.cacheReadTokens;
      totals.cacheWriteTokens += session.cacheWriteTokens;
      const cost = session.estimatedCostUsd ?? 0;
      totals.estimatedCostUsd += cost;
      // ISS-5445 — the ledger split, on the SAME dedup basis as the total above
      // so the two can never disagree about which sessions were counted. The
      // mode is read from the branch this session was first seen on; a session
      // linked to several branches carries one stored mode, so any of them
      // yields the same answer.
      const billingMode = usage.sessionBillingModeById.get(session.sessionId);
      if (isSubscriptionBillingMode(billingMode)) {
        totals.subscriptionEstimatedCostUsd += cost;
      } else if (isMeteredBillingMode(billingMode)) {
        totals.apiEstimatedCostUsd += cost;
      }
    }
  }
  return totals;
}

/**
 * FEA-3695 — the AUTHORITATIVE per-session captured cost map surfaced on the list
 * wire (`BranchListResponse.sessionCostUsd`), each session counted ONCE. The same
 * session artifact is pushed onto every branch's `sessions` it links to, so
 * set-if-absent — first-seen wins; every occurrence carries the same
 * session-level cost, an un-priced session coerced to 0 (priced-zero). Reuses the
 * exact dedup basis as the total-spend KPI (`sumDistinctSessionUsage`) so the
 * client's filtered re-derivation and the server headline can never disagree.
 */
export function distinctSessionCostMap(
  usageByBranch: Map<string, SessionUsage>
): Record<string, number> {
  const costBySession: Record<string, number> = {};
  for (const usage of usageByBranch.values()) {
    for (const session of usage.sessions) {
      if (!Object.hasOwn(costBySession, session.sessionId)) {
        costBySession[session.sessionId] = session.estimatedCostUsd ?? 0;
      }
    }
  }
  return costBySession;
}

export function numberFromDecimal(
  value: { toString(): string } | number | null
): number {
  // ISS-4882 persists omitted token-event cost as null. Branch completeness
  // classification belongs to ISS-4883; until that consumer lands, null adds
  // nothing to this numeric accumulator without being rewritten in storage or
  // exposed as evidence of a real zero-cost event.
  if (value === null) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value.toString());
}

export function toIso(value: Date): string {
  return value.toISOString();
}

export type SessionUsage = UsageTotals & {
  sessionIds: string[];
  sessions: BranchPageDetail["sessions"];
  /** Raw provider-neutral evidence retained until priced-segment projection. */
  lifecycleEventsBySession?: Map<string, BranchPhaseLifecycleEvent[]>;
  // Per-actor attribution: how many DISTINCT linked sessions each Session owner
  // (`SessionDetail.userId`) contributed to this branch. Counts each Session
  // once so duplicate links cannot inflate the by-actor rollup. This is not the
  // canonical Branch Owner contract, which comes from exact push evidence.
  ownerCounts: Map<string, number>;
  // Per-session owner id (`SessionDetail.userId`), keyed by session artifact id
  // — the byActor rollup groups DISTINCT sessions by owner. Kept out of the wire
  // `sessions` array (BranchSession) so the branch contract carries no raw ids.
  sessionOwnerById: Map<string, string | null>;
  /**
   * ISS-5445 — per-session stored `billing_mode`, keyed by session artifact id.
   * Kept OUT of the wire `sessions` array (BranchSession) for the same reason
   * `sessionOwnerById` is: the branch contract carries no raw producer fields.
   * `sumDistinctSessionUsage` reads it to split subscription-covered spend from
   * metered API spend, so the cloud fold classifies with the same canonical set
   * the desktop projection uses instead of hardcoding the split.
   */
  sessionBillingModeById: Map<string, string | null>;
  /** Internal O(1) index used while duplicate relationship evidence is folded. */
  sessionRowsById?: Map<string, BranchPageDetail["sessions"][number]>;
  /** Internal guard so reviewed-first evidence can later acquire one write vote. */
  writeSessionIds?: Set<string>;
};

function appendLifecycleEvents(
  usage: SessionUsage,
  sessionId: string,
  link: Pick<SessionUsageLink, "metadata">
): void {
  const events = parseSessionPrLinkMetadata(
    link.metadata
  )?.branchLifecycleEvents;
  if (!(events && events.length > 0)) {
    return;
  }
  const lifecycleEventsBySession =
    usage.lifecycleEventsBySession ??
    new Map<string, BranchPhaseLifecycleEvent[]>();
  const existing = lifecycleEventsBySession.get(sessionId) ?? [];
  const seenEvents = new Set(existing.map(branchLifecycleEventIdentity));
  for (const event of events) {
    const next = {
      ...event,
      method: parseSessionPrLinkMetadata(link.metadata)?.method,
    };
    const identity = branchLifecycleEventIdentity(next);
    if (!seenEvents.has(identity)) {
      seenEvents.add(identity);
      existing.push(next);
    }
  }
  lifecycleEventsBySession.set(sessionId, existing);
  usage.lifecycleEventsBySession = lifecycleEventsBySession;
}

function branchLifecycleEventIdentity(
  event: BranchPhaseLifecycleEvent
): string {
  return [
    event.kind,
    event.observedAt ?? "",
    event.evidenceId ?? "",
    event.method ?? "",
  ].join("\u0000");
}

// A branch/owner usage rollup carries the same five token/cost fields as a
// single session's windowed spend, so it aliases `WindowedSessionSpend` rather
// than redeclaring the shape — a token or cost field cannot drift between the
// per-session accumulator and the aggregate total (wongk review, #4207). The
// distinct name is kept for call-site readability (a rollup, not one session's
// spend).
export type UsageTotals = WindowedSessionSpend;

/**
 * ISS-5445 — `UsageTotals` plus the billing-ledger split, returned by the
 * org-level `sumDistinctSessionUsage` fold.
 *
 * Deliberately a SEPARATE type rather than two more fields on `UsageTotals`:
 * `SessionUsage extends UsageTotals` and accumulates per-branch spend through a
 * different path, so widening `UsageTotals` would give every per-branch usage
 * object two ledger fields that nothing populates — permanently 0, and a lie the
 * moment someone reads them.
 *
 * Mirrors the desktop projection's semantics exactly (`projectBranchUsage` in
 * `apps/desktop/src/main/branch/branch-usage-projection.ts`): subscription and
 * api are DISJOINT and need not sum to the total — an unknown-ledger session
 * (legacy null mode, the literal `"unknown"`, or an unrecognized value from a
 * newer peer) counts toward `estimatedCostUsd` and toward NEITHER bucket.
 *
 * These two fields are what `getBranchUsage` reports as
 * `subscriptionEstimatedCost` / `apiEstimatedCost`. Before ISS-5445 that call
 * site hardcoded the subscription total to 0 and assigned every dollar to API
 * spend, so a Pro/Max/seat session read as subscription on Sessions and as API
 * spend on Branches — the same record, two surfaces, two answers. The split is
 * computed here, on the same dedup basis as the total, so the two can never
 * disagree about which sessions were counted.
 */
export type DistinctUsageTotals = UsageTotals & {
  /** Spend on subscription-covered modes — a "would have cost" equivalent. */
  subscriptionEstimatedCostUsd: number;
  /** Confirmed metered per-token API spend. */
  apiEstimatedCostUsd: number;
};
