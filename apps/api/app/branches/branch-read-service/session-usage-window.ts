// FEA-4270 — the per-EVENT SPEND window for the Branches usage/analytics reads.
// Extracted from `branch-read-service.ts` so that file shrinks rather than
// grows.
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

import { sessionCostIsNumeric } from "@repo/api/src/agent-session-filters";
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
} from "@repo/api/src/types/session-artifact-link";
import type { PrismaClient } from "@repo/database";
import { deriveBranchLifecyclePhaseSegments } from "@repo/lib/branches/branch-lifecycle-phase";
import type { BranchPhaseLifecycleEvent } from "@repo/lib/branches/branch-phase-attribution";
import { resolveSessionEventEvidence } from "../branch-session-cost-evidence";
import type { OwnerProfile } from "./owner-attribution";
import { readCachedBranchLifetimeUsage } from "./session-lifetime-usage-cache";
import {
  type LinkedSession,
  readSessionUsageLinks,
  SESSION_USAGE_BRANCH_ID_CHUNK_SIZE,
  type SessionUsageLink,
  type SessionUsageLinkReadClient,
} from "./session-usage-link-read";

export type SessionUsageDateWindow = {
  cacheScopeKey?: string;
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

/** Resolved session spend plus whether its cost is known, not just numeric. */
export type ResolvedSessionSpend = WindowedSessionSpend & {
  /** True when this spend observed a valid cost value, including a real zero. */
  hasPricedCost: boolean;
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
  evaluationNow?: Date;
  startDate?: Date;
  endDate?: Date;
}): SessionUsageDateWindow | undefined {
  if (!(query.startDate || query.endDate)) {
    return;
  }
  return {
    ...(query.evaluationNow
      ? { cacheScopeKey: query.evaluationNow.toISOString() }
      : {}),
    startDate: query.startDate,
    endDate: query.endDate,
  };
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
): Map<string, ResolvedSessionSpend> {
  const bySession = new Map<string, ResolvedSessionSpend>();
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
    spend.hasPricedCost ||= hasValidPricedCost(event.estimatedCost);
    bySession.set(event.agentSessionId, spend);
  }
  return bySession;
}

/** A zeroed windowed-spend accumulator — the starting point for a session's
 * fold, and the value a session with no in-window events resolves to. */
export function emptyWindowedSpend(): ResolvedSessionSpend {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    hasPricedCost: false,
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
// of this module (whitlockk review, #4207). The broad client that fans out across
// the rest of the branch-read surface lives with `branch-read-service.ts`, and
// a broad client is structurally assignable to this narrow parameter.
export type SessionUsageClient = SessionUsageLinkReadClient &
  Pick<PrismaClient, "$queryRaw" | "agentSessionTokenEvent">;

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

export async function getSessionUsageByBranch(
  db: SessionUsageClient,
  organizationId: string,
  branchIds: string[],
  options: {
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
     * present, but remains excluded from usage.
     */
    identityEvidenceOut?: SessionBranchIdentityEvidence[];
    includeLifecycleEvents?: boolean;
    includeSessionPhaseSegments?: boolean;
  } = {}
): Promise<Map<string, SessionUsage>> {
  const usageByBranch = new Map<string, SessionUsage>();
  const seenSessionIdsByBranch = new Map<string, Set<string>>();
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
    const links = await readSessionUsageLinks(db, organizationId, idChunk, {
      includeReviewedIdentityEvidence:
        options.identityEvidenceOut !== undefined,
    });
    for (const link of links) {
      allLinks.push(link);
      if (link.source.session) {
        options.identityEvidenceOut?.push({
          targetId: link.targetId,
          sourceId: link.sourceId,
          branchParticipationMethod: link.branchParticipationMethod,
          branchParticipationObservedAt: link.branchParticipationObservedAt,
        });
      }
    }
  }
  const sessionById = new Map<string, LinkedSession>();
  for (const link of allLinks) {
    const participation = branchParticipationForLink(link);
    if (
      link.source.session &&
      participation !== BranchParticipationKind.Reviewed
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
          options.dateWindow,
          { includeCostEvidence: options.costEvidenceOut !== undefined }
        )
      : { contributions: [] };
  options.costEvidenceOut?.push(...eventEvidence.contributions);
  foldLinksIntoUsage(usageByBranch, seenSessionIdsByBranch, allLinks, {
    includeLifecycleEvents: options.includeLifecycleEvents,
    includeSessionPhaseSegments: options.includeSessionPhaseSegments,
    dateWindow: options.dateWindow,
    windowedSpend: eventEvidence.windowedSpend,
  });
  if (options.lifetimeOut && eventEvidence.windowedSpend !== undefined) {
    foldLinksIntoUsage(options.lifetimeOut, new Map(), allLinks, {
      includeLifecycleEvents: options.includeLifecycleEvents,
      includeSessionPhaseSegments: options.includeSessionPhaseSegments,
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
    includeLifecycleEvents?: boolean;
    includeSessionPhaseSegments?: boolean;
    dateWindow?: SessionUsageDateWindow;
    windowedSpend?: Map<string, ResolvedSessionSpend>;
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
      includeLifecycleEvents: options.includeLifecycleEvents,
      includeSessionPhaseSegments: options.includeSessionPhaseSegments,
      dateWindow: options.dateWindow,
      windowedSpend: options.windowedSpend,
    });
    usageByBranch.set(link.targetId, usage);
  }
}

export async function getBranchLifetimeUsage(
  db: SessionUsageClient,
  organizationId: string,
  branchIds: string[],
  dateWindow: SessionUsageDateWindow | undefined,
  identityEvidenceOut?: SessionBranchIdentityEvidence[],
  options: {
    includeLifecycleEvents?: boolean;
    includeSessionPhaseSegments?: boolean;
  } = {}
): Promise<{
  windowed: Map<string, SessionUsage>;
  lifetime: Map<string, SessionUsage>;
}> {
  const includeLifecycleEvents = options.includeLifecycleEvents !== false;
  const includeSessionPhaseSegments =
    options.includeSessionPhaseSegments !== false;
  const result = await readCachedBranchLifetimeUsage({
    organizationId,
    branchIds,
    dateWindow,
    includeLifecycleEvents,
    includeSessionPhaseSegments,
    needsIdentityEvidence: identityEvidenceOut !== undefined,
    read: (cachedIdentityEvidenceOut) =>
      readBranchLifetimeUsage(
        db,
        organizationId,
        branchIds,
        dateWindow,
        cachedIdentityEvidenceOut,
        {
          includeLifecycleEvents,
          includeSessionPhaseSegments,
        }
      ),
  });
  identityEvidenceOut?.push(...result.identityEvidence);
  return { windowed: result.windowed, lifetime: result.lifetime };
}

async function readBranchLifetimeUsage(
  db: SessionUsageClient,
  organizationId: string,
  branchIds: string[],
  dateWindow: SessionUsageDateWindow | undefined,
  identityEvidenceOut?: SessionBranchIdentityEvidence[],
  options: {
    includeLifecycleEvents?: boolean;
    includeSessionPhaseSegments?: boolean;
  } = {}
): Promise<{
  windowed: Map<string, SessionUsage>;
  lifetime: Map<string, SessionUsage>;
}> {
  if (dateWindow === undefined) {
    const windowed = await getSessionUsageByBranch(
      db,
      organizationId,
      branchIds,
      {
        identityEvidenceOut,
        includeLifecycleEvents: options.includeLifecycleEvents,
        includeSessionPhaseSegments: options.includeSessionPhaseSegments,
      }
    );
    return { windowed, lifetime: windowed };
  }
  const lifetime = new Map<string, SessionUsage>();
  const windowed = await getSessionUsageByBranch(
    db,
    organizationId,
    branchIds,
    {
      dateWindow,
      lifetimeOut: lifetime,
      identityEvidenceOut,
      includeLifecycleEvents: options.includeLifecycleEvents,
      includeSessionPhaseSegments: options.includeSessionPhaseSegments,
    }
  );
  return { windowed, lifetime };
}

/** Persisted fields required by the Branch identity projector. */
export type SessionBranchIdentityEvidence = {
  targetId: string;
  sourceId: string;
  branchParticipationMethod: string | null;
  branchParticipationObservedAt: Date | null;
};

/**
 * Fold one session→branch link into a branch's running usage: dedups the session
 * per branch, tallies each distinct owner once, and bounds only spend by date
 * window while keeping lifetime identity/session metadata intact.
 */
function accumulateSessionLink(
  usage: SessionUsage,
  link: SessionUsageLink,
  seenSessionIds: Set<string>,
  options: {
    includeLifecycleEvents?: boolean;
    includeSessionPhaseSegments?: boolean;
    dateWindow?: SessionUsageDateWindow;
    windowedSpend?: Map<string, ResolvedSessionSpend>;
  } = {}
): void {
  const session = link.source.session;
  // FEA-4263: an orphaned link without SessionDetail is not branch usage.
  if (!session) {
    return;
  }
  const participation = branchParticipationForLink(link);
  if (participation === BranchParticipationKind.Reviewed) {
    return;
  }
  const windowed = Boolean(
    options.dateWindow?.startDate || options.dateWindow?.endDate
  );
  const spend = resolveSessionSpend(session, options.windowedSpend, windowed);
  // A write session's `sessions[]` row reports the resolved spend's tokens
  // (windowed sum under a window, lifetime otherwise). Its `estimatedCostUsd` is
  // that cost only when the cost is known; placeholder SessionDetail zeros stay
  // null so Branches do not disagree with Sessions' "—" cost authority.
  const hasWindowedSpend = totalSessionSpend(spend) > 0;
  const reportsCost = spend.hasPricedCost && (!windowed || hasWindowedSpend);
  // Under an active window, the write session's `sessions[]` tokens are the
  // windowed sum; without a window they are the lifetime totals.
  const usesWindowedTokens = windowed;
  // Owner and byActor attribution follow lifetime write-participation identity.
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
  if (!writeSessionIds.has(link.sourceId)) {
    writeSessionIds.add(link.sourceId);
    recordDistinctSessionOwner(usage, session);
  }
  appendLifecycleEventsIfEnabled(usage, link.sourceId, link, options);
  if (!isFirstSessionEvidence) {
    const existingSession = sessionRowsById.get(link.sourceId);
    if (existingSession) {
      mergeSessionParticipation(existingSession, participation);
      attachPhaseSegmentsIfEnabled(existingSession, usage, session, options);
    }
    return;
  }
  const sessionRow = buildSessionUsageRow(link, session, {
    participation,
    reportsCost,
    usesWindowedTokens,
    spend,
  });
  attachPhaseSegmentsIfEnabled(sessionRow, usage, session, options);
  usage.sessions.push(sessionRow);
  sessionRowsById.set(link.sourceId, sessionRow);
  // ISS-8972 — recorded on the FIRST evidence for this session, alongside the row
  // it describes, so these maps' keys track `usage.sessions` exactly (the same
  // placement and reasoning as `sessionBillingModeById` below). Keyed by
  // `session.artifactId`, which is `link.sourceId` and `sessionRow.sessionId`.
  recordSessionPresentationFacts(usage, link, session);
  if (reportsCost && spend.hasPricedCost) {
    usage.hasPricedCost = true;
  }
  // ISS-5445 — recorded on the FIRST evidence for this session, alongside the
  // row it classifies, so the map's keys track `usage.sessions` exactly. Keyed
  // by `session.artifactId` (=== `link.sourceId`, and === `sessionRow.sessionId`)
  // so it aligns with the identity `sumDistinctSessionUsage` de-dupes on.
  usage.sessionBillingModeById.set(
    session.artifactId,
    session.billingMode ?? null
  );
  usage.inputTokens += spend.inputTokens;
  usage.outputTokens += spend.outputTokens;
  usage.cacheReadTokens += spend.cacheReadTokens;
  usage.cacheWriteTokens += spend.cacheWriteTokens;
  usage.estimatedCostUsd += spend.estimatedCostUsd;
}

/** Resolve lifetime spend or the already-aggregated per-event windowed spend. */
function resolveSessionSpend(
  session: LinkedSession,
  windowedSpend: Map<string, ResolvedSessionSpend> | undefined,
  windowed: boolean
): ResolvedSessionSpend {
  if (windowed) {
    return windowedSpend?.get(session.artifactId) ?? emptyWindowedSpend();
  }
  return {
    inputTokens: Number(session.inputTokens),
    outputTokens: Number(session.outputTokens),
    cacheReadTokens: Number(session.cacheReadTokens),
    cacheWriteTokens: Number(session.cacheWriteTokens),
    estimatedCostUsd: numberFromDecimal(session.estimatedCost),
    hasPricedCost: sessionHasNumericCost(session),
  };
}

/**
 * Record a distinct linked session's owner ONCE (FEA-3457), keyed off the
 * session's own artifactId so it aligns with the `sessions[].sessionId` the
 * usage summary de-dupes on; the byActor rollup groups distinct sessions by it.
 * Owner attribution is LIFETIME identity, so it keys off write-participation,
 * never the date window.
 */
function recordDistinctSessionOwner(
  usage: SessionUsage,
  session: LinkedSession
): void {
  usage.sessionOwnerById.set(session.artifactId, session.ownerUserId ?? null);
}

/**
 * Build one `sessions[]` row. FEA-4270: `spend` carries the session's resolved
 * token/cost — the PER-EVENT windowed sum under an active window, the lifetime
 * totals otherwise. A windowed session with zero in-window spend shows null cost
 * — an honest "no in-window spend", never a computed $0.00. `usesWindowedTokens`
 * keeps row tokens aligned with the windowed Branch totals.
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
    ownerUserId: session.ownerUserId ?? null,
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

function appendLifecycleEventsIfEnabled(
  usage: SessionUsage,
  sessionId: string,
  link: Pick<SessionUsageLink, "metadata">,
  options: {
    includeLifecycleEvents?: boolean;
  }
): void {
  if (options.includeLifecycleEvents === false) {
    return;
  }
  appendLifecycleEvents(usage, sessionId, link);
}

function attachPhaseSegmentsIfEnabled(
  row: SessionUsage["sessions"][number],
  usage: SessionUsage,
  session: LinkedSession,
  options: {
    includeLifecycleEvents?: boolean;
    includeSessionPhaseSegments?: boolean;
  }
): void {
  if (
    options.includeLifecycleEvents === false ||
    options.includeSessionPhaseSegments === false
  ) {
    return;
  }
  attachMergedLifecyclePhaseSegments(row, usage, session);
}

export function emptyUsage(): SessionUsage {
  return {
    sessionIds: [],
    sessions: [],
    sessionOwnerById: new Map(),
    sessionBillingModeById: new Map(),
    sessionDisplayInputsById: new Map(),
    sessionOwnerProfileById: new Map(),
    lifecycleEventsBySession: new Map(),
    sessionRowsById: new Map(),
    writeSessionIds: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
    hasPricedCost: false,
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

/**
 * ISS-8972 — everything the SHARED displayed-status projector needs for one
 * Session, kept as one record rather than a map per column so a field cannot be
 * carried on one path and dropped on the other. Shaped to
 * `projectDisplayedSessionStatus`'s parameter so it is passed through whole.
 *
 * An absent timestamp stays absent here; the projector owns what that means.
 */
export type SessionDisplayInputs = {
  status: string;
  awaitingInputSince: Date | null;
  sessionEndedAt: Date | null;
  lastActivityAt?: Date | null;
  sessionStartedAt?: Date | null;
  endsWithError?: boolean | null;
};

export type SessionUsage = UsageTotals & {
  /** True when any included session reports priced cost, including a real zero. */
  hasPricedCost: boolean;
  sessionIds: string[];
  sessions: BranchPageDetail["sessions"];
  /** Raw provider-neutral evidence retained until priced-segment projection. */
  lifecycleEventsBySession?: Map<string, BranchPhaseLifecycleEvent[]>;
  // Per-session owner id (the session's assignee), keyed by session artifact id
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
  /**
   * ISS-8972 — per-session STORED lifecycle status (`artifacts.status`), keyed by
   * session artifact id. Kept OUT of the wire `sessions` array (BranchSession)
   * for the same reason `sessionOwnerById` is: the branch contract carries no raw
   * producer fields. The projection folds it to a display value; nothing writes
   * it back, so a display word can never reach a column through this map.
   */
  sessionDisplayInputsById: Map<string, SessionDisplayInputs>;
  /**
   * ISS-8972 — per-session owner chip name and avatar, keyed by session artifact
   * id. Resolved once per PAGE (list) or once per branch read (detail) and
   * stamped in by `attachSessionOwnerProfiles`, so neither path issues a
   * per-branch identity read. The name is name parts only, never an email
   * (ISS-11738). A session whose owner is absent, unresolved, or nameless has no
   * entry, which the projection reports as `ownerUnavailable` rather than
   * inventing a name.
   */
  sessionOwnerProfileById: Map<string, OwnerProfile>;
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
// per-session accumulator and the aggregate total (whitlockk review, #4207). The
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

function hasValidPricedCost(
  value: { toString(): string } | number | null
): boolean {
  if (value === null) {
    return false;
  }
  const cost = numberFromDecimal(value);
  return Number.isFinite(cost) && cost >= 0;
}

function sessionHasNumericCost(session: LinkedSession): boolean {
  // ISS-7813: a never-priced session has no numeric cost, so it must not be
  // reported as one. `numberFromDecimal` folds null to 0 — correct for the
  // ISS-4882 token-event field it was written for, where a null already meant
  // "this event adds nothing", but wrong for `SessionDetail.estimatedCost`,
  // where null now means "nobody priced this session". Without this guard the
  // fold reaches `sessionCostIsNumeric`, which returns true unconditionally for
  // a subscription-billed session that did substantive work, and the row
  // renders a fabricated, measured-looking $0.00. `hasValidPricedCost` above is
  // the same guard, already applied on the windowed per-event path.
  if (!hasValidPricedCost(session.estimatedCost)) {
    return false;
  }
  const estimatedCost = numberFromDecimal(session.estimatedCost);
  return sessionCostIsNumeric({
    estimatedCost,
    billingMode: session.billingMode,
    turns: session.turns,
    inputTokens: Number(session.inputTokens),
    outputTokens: Number(session.outputTokens),
    cacheReadTokens: Number(session.cacheReadTokens),
    cacheWriteTokens: Number(session.cacheWriteTokens),
    toolUseCount: session.toolUseCount,
    // ISS-5801: the 7th substantive signal — without it an invocation-only
    // subscription session diverges from the Sessions surface's cost fold.
    componentInvocationCount: session.componentInvocationCount,
  });
}

/**
 * ISS-8972 — the per-Session facts the Linked Sessions chips render, recorded
 * beside the row they describe so these maps' keys track `usage.sessions`
 * exactly. Extracted to keep `accumulateSessionLink` under the
 * cognitive-complexity ceiling.
 *
 * An absent interaction instant stays ABSENT. There is no honest stand-in for
 * one nobody recorded — `new Date()`, the epoch, or the branch's own timestamp
 * would each render as a confident date on a chip — so the entry is omitted and
 * the renderer decides what to do with a Session it cannot date.
 */
function recordSessionPresentationFacts(
  usage: SessionUsage,
  link: SessionUsageLink,
  session: LinkedSession
): void {
  usage.sessionDisplayInputsById.set(session.artifactId, {
    status: link.source.status,
    // ISS-8972 (whitlockk review): `awaitingInputSince` and `endsWithError` ride
    // along because the cloud never STORES `waiting` — a blocked run stores
    // `active` — so without them the shared projector cannot answer Waiting and
    // the chip reads Active or Stale for a session waiting on a human.
    awaitingInputSince: session.awaitingInputSince ?? null,
    sessionEndedAt: session.sessionEndedAt,
    lastActivityAt: session.lastActivityAt ?? null,
    sessionStartedAt: session.sessionStartedAt,
    endsWithError: session.endsWithError ?? null,
  });
}
