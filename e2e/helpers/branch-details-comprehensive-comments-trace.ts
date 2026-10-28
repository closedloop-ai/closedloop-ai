import {
  BranchCommentsBudget,
  BranchCommentsState,
  type BranchPrComment,
  BranchPrCommentKind,
  type BranchPrCommentsResponse,
  BranchViewerScope,
} from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  type BranchTraceResponse,
  BranchTraceSessionHydrationState,
  BranchTraceUnavailableReason,
} from "@repo/api/src/types/branch-trace";
import {
  CommentSurface,
  CommentTargetType,
  ThreadStatus,
  type TraceComment,
  TraceCommentKind,
} from "@repo/api/src/types/comment";
import type {
  TurnActor,
  TurnItem,
} from "@repo/api/src/types/session-transcript-turn";
import { buildMergedTrace } from "@repo/lib/branches/merged-trace";
import {
  BRANCH_ID,
  HISTORICAL_PR,
  REPOSITORY,
} from "./branch-details-comprehensive-data";

export const ACTIVE_COMMENT =
  "P1 Badge Only the active pull request says this beta";
export const HISTORICAL_COMMENT = "Only the historical pull request says this";
export const DETAILS_NATIVE_COMMENT = "Native Branch details comment";
export const TIMELINE_NATIVE_COMMENT = "Native Branch timeline comment";
export const SESSION_NATIVE_COMMENT = "Rendered Session native comment";
export const DETAILS_REPLY_DRAFT = "Draft survives a tab scope change";
export const PROVIDER_ROOT_AUTHOR = "Review User · @reviewer";
export const PROVIDER_REPLY_AUTHOR = "@reply-reviewer";
export const PROVIDER_OMITTED_DISCLOSURE =
  "3 GitHub comments are omitted from this bounded result.";
export const PROVIDER_BODY_DISCLOSURE =
  "2 GitHub comment bodies are shortened.";
export const DENSE_TIMELINE_EVENT_LABELS = [
  "Dense steering marker one",
  "Dense steering marker two",
  "Dense commit marker",
  "Dense failure marker",
] as const;

export function commentsFor(prNumber: number): BranchPrCommentsResponse {
  return {
    branchId: BRANCH_ID,
    repositoryFullName: REPOSITORY,
    state: BranchCommentsState.StaleMixed,
    comments: commentsForPullRequest(prNumber),
    budget: {
      maxComments: BranchCommentsBudget.MaxComments,
      pageSize: BranchCommentsBudget.PageSize,
      maxBodyBytes: BranchCommentsBudget.MaxBodyBytes,
      maxResponseBytes: BranchCommentsBudget.MaxResponseBytes,
      providerTruncated: true,
      responseTruncated: true,
      omittedComments: 3,
      bodyTruncatedCount: 2,
    },
    providerProofedAt: "2026-08-01T12:00:00.000Z",
    stale: true,
    mixedProjection: true,
    prNumber,
    prUrl: `https://github.com/${REPOSITORY}/pull/${prNumber}`,
  };
}

function commentsForPullRequest(prNumber: number): BranchPrComment[] {
  const isHistorical = prNumber === HISTORICAL_PR;
  const root = comment(
    prNumber,
    isHistorical ? HISTORICAL_COMMENT : "Review thread root"
  );
  if (isHistorical) {
    return [root];
  }
  return [
    {
      ...root,
      kind: BranchPrCommentKind.Review,
    },
    {
      ...root,
      id: `reply-${prNumber}`,
      providerNodeId: `provider-reply-node-${prNumber}`,
      providerCommentId: `provider-reply-comment-${prNumber}`,
      inReplyToId: root.id,
      kind: BranchPrCommentKind.ReviewReply,
      body: "<sub><sub>P1 Badge</sub></sub> Only the active pull request says this <sup>beta</sup>",
      author: {
        login: "reply-reviewer",
        displayName: null,
        avatarUrl: null,
        profileUrl: "https://github.com/reply-reviewer",
      },
      line: 43,
      providerUrl: `https://github.com/${REPOSITORY}/pull/${prNumber}#discussion_r${prNumber}2`,
      resolved: true,
    },
  ];
}

function comment(prNumber: number, body: string): BranchPrComment {
  return {
    id: `comment-${prNumber}`,
    providerNodeId: `provider-node-${prNumber}`,
    providerCommentId: `provider-comment-${prNumber}`,
    threadId: `thread-${prNumber}`,
    inReplyToId: null,
    kind: BranchPrCommentKind.Issue,
    body,
    author: {
      login: "reviewer",
      displayName: "Review User",
      avatarUrl: null,
      profileUrl: null,
    },
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: null,
    path: "packages/app/branches/components/comments/branch-comment-card.tsx",
    line: 42,
    resolved: false,
    providerUrl: `https://github.com/${REPOSITORY}/pull/${prNumber}#discussion_r${prNumber}1`,
    stale: true,
    bodyTruncated: true,
  };
}

export function nativeComment(surface: CommentSurface): TraceComment {
  const isTimeline = surface === CommentSurface.BranchTimeline;
  const anchorLabel = isTimeline ? "Timeline anchor" : "Details anchor";
  return {
    id: isTimeline ? "timeline-comment" : "details-comment",
    threadId: isTimeline ? "timeline-thread" : "details-thread",
    target: { type: CommentTargetType.Branch, id: BRANCH_ID },
    artifactId: BRANCH_ID,
    surface,
    kind: TraceCommentKind.Comment,
    status: ThreadStatus.Open,
    anchor: {
      traceId: BRANCH_ID,
      turnId: isTimeline ? "timeline-turn" : "details-turn",
      row: isTimeline ? 2 : 1,
      selectedText: anchorLabel,
      sourceText: anchorLabel,
      startOffset: 0,
      endOffset: anchorLabel.length,
    },
    body: isTimeline ? TIMELINE_NATIVE_COMMENT : DETAILS_NATIVE_COMMENT,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: "2026-08-01T12:00:00.000Z",
    editedAt: null,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    resolvedByAvatarUrl: null,
    authorId: "native-author",
    authorName: "Native Reviewer",
    authorAvatarUrl: null,
    canEdit: true,
    canDelete: true,
    replies: [],
  };
}

export function sessionNativeComment(): TraceComment {
  return {
    ...nativeComment(CommentSurface.SessionDetail),
    id: "session-build-comment",
    threadId: "session-build-thread",
    target: {
      type: CommentTargetType.Session,
      id: "session-build",
    },
    artifactId: "session-build",
    body: SESSION_NATIVE_COMMENT,
  };
}
export function traceResponse(): BranchTraceResponse {
  const items: BranchTraceResponse["items"] = [
    {
      type: "sessionstart",
      sessionId: "session-build",
      t: "2026-08-01T10:00:00.000Z",
      actor: { name: "Ada Lovelace", harness: "codex" },
    },
    {
      type: "prompt",
      sessionId: "session-build",
      t: "2026-08-01T10:01:00.000Z",
      tMs: Date.parse("2026-08-01T10:01:00.000Z"),
      cumCostUsd: 2,
      actorName: "Ada Lovelace",
      text: "Implement selector propagation",
    },
    {
      type: "event",
      sessionId: "session-build",
      t: "2026-08-01T10:02:00.000Z",
      dot: "g",
      text: "Pull request merged",
    },
    ...scrollFillerTraceItems("2026-08-01T10:03:00.000Z"),
    { type: "end", sessionId: "session-build", text: "Session complete" },
  ];
  return {
    branchId: BRANCH_ID,
    viewerScope: BranchViewerScope.Organization,
    items,
    hasMore: false,
    traceState: {
      sessions: [
        {
          identity: {
            artifactId: "session-build",
            name: "Build session",
            slug: "session-build",
            navigableRef: "session-build",
          },
          state: BranchTraceSessionHydrationState.Loaded,
        },
      ],
      qualifyingSessionCount: 1,
      completeness: { state: BranchTraceCompletenessState.Complete },
      aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
    },
  };
}

/** Partial hydration fixture for mixed stamped and unstamped timeline cost rows. */
export function partiallyLoadedMixedCostTraceResponse(
  branchId: string = BRANCH_ID
): BranchTraceResponse {
  return {
    branchId,
    viewerScope: BranchViewerScope.Organization,
    items: [],
    hasMore: false,
    traceState: {
      aggregateCompleteness: { state: BranchTraceCompletenessState.Incomplete },
      completeness: { state: BranchTraceCompletenessState.Incomplete },
      qualifyingSessionCount: 2,
      sessions: [
        {
          identity: {
            artifactId: "session-stamped",
            name: "session-stamped",
            navigableRef: "session-stamped",
            slug: "session-stamped",
          },
          reason: BranchTraceUnavailableReason.Permission,
          state: BranchTraceSessionHydrationState.Unavailable,
        },
        {
          identity: {
            artifactId: "session-unstamped",
            name: "session-unstamped",
            navigableRef: "session-unstamped",
            slug: "session-unstamped",
          },
          state: BranchTraceSessionHydrationState.Loaded,
        },
      ],
    },
  };
}

/** Dense same-instant Branch trace fixture for marker packing regressions. */
export function denseEventTraceResponse(): BranchTraceResponse {
  const response = traceResponse();
  return {
    ...response,
    items: [
      {
        type: "sessionstart",
        sessionId: "session-build",
        t: "2026-08-01T10:00:00.000Z",
        actor: { name: "Ada Lovelace", harness: "codex" },
      },
      {
        type: "prompt",
        sessionId: "session-build",
        t: "2026-08-01T10:44:00.000Z",
        tMs: Date.parse("2026-08-01T10:44:00.000Z"),
        cumCostUsd: 2,
        actorName: "Ada Lovelace",
        text: "Prepare dense marker packing",
      },
      {
        type: "event" as const,
        sessionId: "session-build",
        t: "2026-08-01T10:45:00.000Z",
        dot: "b" as const,
        text: DENSE_TIMELINE_EVENT_LABELS[0],
      },
      {
        type: "event" as const,
        sessionId: "session-build",
        t: "2026-08-01T10:45:00.000Z",
        dot: "b" as const,
        text: DENSE_TIMELINE_EVENT_LABELS[1],
      },
      {
        type: "event" as const,
        sessionId: "session-build",
        t: "2026-08-01T10:45:00.000Z",
        dot: "g" as const,
        text: DENSE_TIMELINE_EVENT_LABELS[2],
      },
      {
        type: "event" as const,
        sessionId: "session-build",
        t: "2026-08-01T10:45:00.000Z",
        dot: "r" as const,
        text: DENSE_TIMELINE_EVENT_LABELS[3],
      },
      ...scrollFillerTraceItems("2026-08-01T10:46:00.000Z"),
      { type: "end", sessionId: "session-build", text: "Session complete" },
    ],
  };
}

function scrollFillerTraceItems(
  startIso: string
): BranchTraceResponse["items"] {
  const startMs = Date.parse(startIso);
  return Array.from({ length: 18 }, (_, index) => {
    const tMs = startMs + index * 60_000;
    return {
      actorName: "Ada Lovelace",
      cumCostUsd: 2,
      sessionId: "session-build",
      t: new Date(tMs).toISOString(),
      tMs,
      text: `Trace filler row ${index + 1}`,
      type: "say" as const,
    };
  });
}

/** Complete hydration fixture for the timing-completeness regression. */
export function timingIncompleteTraceResponse(): BranchTraceResponse {
  const response = traceResponse();
  const traceState = response.traceState;
  if (!traceState) {
    throw new Error("Branch Details timing fixture requires trace state");
  }
  return {
    ...response,
    items: [
      {
        type: "end",
        sessionId: "session-build",
        text: "Build session complete",
      },
      {
        type: "end",
        sessionId: "session-review",
        text: "Review session complete",
      },
      {
        type: "end",
        sessionId: "session-rework",
        text: "Rework session complete",
      },
    ],
    traceState: {
      ...traceState,
      qualifyingSessionCount: 3,
      sessions: ["build", "review", "rework"].map((phase) => ({
        identity: {
          artifactId: `session-${phase}`,
          name: `${phase[0]!.toUpperCase()}${phase.slice(1)} session`,
          navigableRef: `session-${phase}`,
          slug: `session-${phase}`,
        },
        state: BranchTraceSessionHydrationState.Loaded,
      })),
    },
  };
}

/** Settled failed-read fixture that retains all linked Session identities. */
export function unavailableTraceResponse(): BranchTraceResponse {
  return {
    branchId: BRANCH_ID,
    viewerScope: BranchViewerScope.Organization,
    items: [],
    hasMore: false,
    traceState: {
      sessions: ["build", "review", "rework"].map((phase) => ({
        identity: {
          artifactId: `session-${phase}`,
          name: `${phase[0]!.toUpperCase()}${phase.slice(1)} session`,
          navigableRef: `session-${phase}`,
          slug: `session-${phase}`,
        },
        reason: BranchTraceUnavailableReason.PageFailure,
        state: BranchTraceSessionHydrationState.Unavailable,
      })),
      qualifyingSessionCount: 3,
      completeness: {
        reason: BranchTraceUnavailableReason.PageFailure,
        state: BranchTraceCompletenessState.Unavailable,
      },
      aggregateCompleteness: {
        reason: BranchTraceUnavailableReason.PageFailure,
        state: BranchTraceCompletenessState.Unavailable,
      },
    },
  };
}

/**
 * ISS-8652 — the branch merged trace both shells actually read, with a pause
 * long enough that the REAL producer decides it is idle.
 *
 * #6325 review (whitlockk): the idle row shipped with a component fixture whose
 * `{ type: "idle" }` item was authored by hand, so neither the merged-branch
 * source nor either shell's flag path was exercised. Nothing here names an
 * `idle` item either — the only authored inputs are two turns with real
 * timestamps, and `buildMergedTrace` (the same function `branch-trace-service.ts`
 * and the desktop `shared-branch-trace.ts` call) decides whether the gap between
 * them becomes one.
 *
 * `e2e/session-trace-idle-rows.spec.ts` serves this from a Playwright route
 * mock. The shared-only Electron duplicate was removed in ISS-10527.
 */
export const IDLE_TRACE_GAP_MS = 5 * 60_000;
/**
 * The rendered sentence, spelled out rather than imported from
 * `formatIdleRowLabel`. An expectation the code under test computes agrees with
 * it by construction and cannot fail — the same reasoning the sibling
 * `session-trace-evidence-disclosure` specs record for their note literal.
 */
export const IDLE_TRACE_ROW_TEXT = "Idle gap · 5m";
/** Any idle row at all, so an absence assertion is not keyed to one duration. */
export const IDLE_TRACE_ROW_PATTERN = /Idle gap/;
export const IDLE_TRACE_PROMPT_TEXT = "Start the branch migration";
export const IDLE_TRACE_REPLY_TEXT = "Migration applied after the pause";

const IDLE_TRACE_SESSION_ID = "session-build";
const IDLE_TRACE_ACTOR_NAME = "Ada Lovelace";
const IDLE_TRACE_HARNESS = "codex";
const IDLE_TRACE_START_MS = Date.parse("2026-08-01T10:00:00.000Z");
/**
 * One minute after the synthesized `sessionstart`, which is UNDER the merge's
 * 2-minute threshold — so the only span this fixture can produce is the one
 * between the two turns below, and an assertion on "an idle row" cannot be
 * satisfied by an accidental second one.
 */
const IDLE_TRACE_FIRST_TURN_MS = IDLE_TRACE_START_MS + 60_000;

/**
 * A single-session branch trace whose two turns are `gapMs` apart. Pass a value
 * under `MERGED_TRACE_IDLE_THRESHOLD_MS` and the producer synthesizes nothing.
 */
export function idleGapTraceResponse(
  gapMs: number = IDLE_TRACE_GAP_MS
): BranchTraceResponse {
  return {
    branchId: BRANCH_ID,
    viewerScope: BranchViewerScope.Organization,
    items: buildMergedTrace([
      {
        sessionId: IDLE_TRACE_SESSION_ID,
        startedAt: new Date(IDLE_TRACE_START_MS).toISOString(),
        actorName: IDLE_TRACE_ACTOR_NAME,
        harness: IDLE_TRACE_HARNESS,
        turnItems: [
          idleTracePromptTurn(IDLE_TRACE_FIRST_TURN_MS, IDLE_TRACE_PROMPT_TEXT),
          idleTraceReplyTurn(
            IDLE_TRACE_FIRST_TURN_MS + gapMs,
            IDLE_TRACE_REPLY_TEXT
          ),
        ],
      },
    ]),
    hasMore: false,
    traceState: {
      sessions: [
        {
          identity: {
            artifactId: IDLE_TRACE_SESSION_ID,
            name: "Build session",
            slug: IDLE_TRACE_SESSION_ID,
            navigableRef: IDLE_TRACE_SESSION_ID,
          },
          state: BranchTraceSessionHydrationState.Loaded,
        },
      ],
      qualifyingSessionCount: 1,
      completeness: { state: BranchTraceCompletenessState.Complete },
      aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
    },
  };
}

function idleTracePromptTurn(atMs: number, text: string): TurnItem {
  return {
    type: "prompt",
    _row: 0,
    t: new Date(atMs).toISOString(),
    tMs: atMs,
    cum: 0,
    actor: idleTraceActor(IDLE_TRACE_ACTOR_NAME),
    text,
  };
}

function idleTraceReplyTurn(atMs: number, text: string): TurnItem {
  return {
    type: "say",
    _row: 1,
    t: new Date(atMs).toISOString(),
    tMs: atMs,
    cum: 1,
    actor: idleTraceActor(IDLE_TRACE_ACTOR_NAME),
    text,
  };
}

function idleTraceActor(name: string): TurnActor {
  return {
    name,
    sessionId: IDLE_TRACE_SESSION_ID,
    human: name,
    color: "",
    harness: IDLE_TRACE_HARNESS,
  };
}

/**
 * ISS-8720/8719 — the same branch merged trace, but with the pause following a
 * `tools` run that OCCUPIED ten of the sixteen minutes separating the two turn
 * starts.
 *
 * The sibling `idleGapTraceResponse` above pairs two point events, and a prompt
 * and a reply have no extent — so start-to-start and end-to-start are the same
 * number there and its arms render "5m" whether the builder's math is right or
 * wrong. This fixture is the one that can tell them apart: `buildMergedTrace`
 * sized start-to-start prints SIXTEEN minutes of idle over a pause the reader
 * actually waited six for.
 *
 * Shared by both shells for the same reason as the sibling: `e2e/` serves it
 * from a route mock and `apps/desktop/test/e2e/` from its authenticated cloud
 * stand-in, so a divergence between the adapters cannot hide behind two
 * different fixtures. Nothing here names an `idle` item — the only authored
 * inputs are three turns with real timestamps.
 */
const TOOL_RUN_MS = 10 * 60_000;
const TOOL_RUN_PAUSE_MS = 6 * 60_000;
/** The pause the reader actually waited, as the row spells it. */
export const TOOL_RUN_IDLE_ROW_TEXT = "Idle gap · 6m";
/**
 * What a start-to-start span prints for this same fixture. Asserted ABSENT, so
 * a regression reads as the specific wrong duration rather than a missing row.
 */
export const TOOL_RUN_IDLE_UNCORRECTED_ROW_TEXT = "Idle gap · 16m";
export const TOOL_RUN_IDLE_PROMPT_TEXT = "Run the migration suite";
export const TOOL_RUN_IDLE_TOOL_SUMMARY = "12 migration tools";
export const TOOL_RUN_IDLE_REPLY_TEXT = "Suite finished, resuming after a wait";

export function toolRunIdleGapTraceResponse(): BranchTraceResponse {
  const toolStartMs = IDLE_TRACE_FIRST_TURN_MS + 60_000;
  return {
    ...idleGapTraceResponse(),
    items: buildMergedTrace([
      {
        sessionId: IDLE_TRACE_SESSION_ID,
        startedAt: new Date(IDLE_TRACE_START_MS).toISOString(),
        actorName: IDLE_TRACE_ACTOR_NAME,
        harness: IDLE_TRACE_HARNESS,
        turnItems: [
          idleTracePromptTurn(
            IDLE_TRACE_FIRST_TURN_MS,
            TOOL_RUN_IDLE_PROMPT_TEXT
          ),
          idleTraceToolsTurn(toolStartMs, toolStartMs + TOOL_RUN_MS),
          idleTraceReplyTurn(
            toolStartMs + TOOL_RUN_MS + TOOL_RUN_PAUSE_MS,
            TOOL_RUN_IDLE_REPLY_TEXT
          ),
        ],
      },
    ]),
  };
}

function idleTraceToolsTurn(atMs: number, endMs: number): TurnItem {
  return {
    type: "tools",
    _row: 1,
    t: new Date(atMs).toISOString(),
    tMs: atMs,
    endMs,
    cum: 1,
    actor: idleTraceActor(IDLE_TRACE_ACTOR_NAME),
    summary: TOOL_RUN_IDLE_TOOL_SUMMARY,
    items: [{ label: "bash", detail: "pnpm migrate", err: false }],
    hasFail: false,
    failN: 0,
    cats: { bash: 1 },
  };
}

/**
 * ISS-8767 (#6809 review, davetho) — the same branch merged trace, but with a
 * tool run carrying an IMPOSSIBLE `endMs`, followed by TWO pauses.
 *
 * The corrupt-extent coverage that shipped with ISS-8767 stopped at the shared
 * fold and the derived helpers. Neither shell had a trace-flow spec whose
 * `tools.endMs` was anything but healthy, so a regression in the route, the
 * adapter, or either shell's flag path could show no idle rows at all while
 * every package-level suite stayed green — and "no idle row" is exactly what
 * the defect looks like.
 *
 * TWO pauses, not one, is the load-bearing part. `buildMergedTrace` carries a
 * refused extent forward as its running `activeUntilMs` MAX, so one far-future
 * value drives every LATER `gapMs` negative: a fix that merely sized the
 * corrupt row correctly would still lose the second marker. A shell that
 * refuses the extent renders BOTH rows; a shell that trusts it renders NONE.
 *
 * Shared by both shells for the same reason as its siblings — `e2e/` serves it
 * from a route mock and `apps/desktop/test/e2e/` from its authenticated cloud
 * stand-in. Nothing here names an `idle` item; the only authored inputs are
 * four turns with real timestamps and one impossible extent.
 */
const CORRUPT_EXTENT_TOOL_START_MS = IDLE_TRACE_FIRST_TURN_MS + 60_000;
const CORRUPT_EXTENT_PAUSE_MS = 5 * 60_000;
/**
 * A nanosecond stamp handed over as milliseconds: the realistic producer bug,
 * and past both the safe-integer ceiling and the representable `Date` range.
 */
const CORRUPT_EXTENT_END_MS = CORRUPT_EXTENT_TOOL_START_MS * 1_000_000;

export const CORRUPT_EXTENT_PROMPT_TEXT = "Start the collector backfill";
export const CORRUPT_EXTENT_TOOL_SUMMARY = "9 collector tools";
export const CORRUPT_EXTENT_FIRST_REPLY_TEXT = "Backfill resumed after a wait";
export const CORRUPT_EXTENT_SECOND_REPLY_TEXT = "Backfill finished";
/** Both pauses are the same length, so one locator counts both rows. */
export const CORRUPT_EXTENT_IDLE_ROW_TEXT = "Idle gap · 5m";
export const CORRUPT_EXTENT_IDLE_ROW_COUNT = 2;

export function corruptExtentIdleGapTraceResponse(): BranchTraceResponse {
  const firstReplyMs = CORRUPT_EXTENT_TOOL_START_MS + CORRUPT_EXTENT_PAUSE_MS;
  return {
    ...idleGapTraceResponse(),
    items: buildMergedTrace([
      {
        sessionId: IDLE_TRACE_SESSION_ID,
        startedAt: new Date(IDLE_TRACE_START_MS).toISOString(),
        actorName: IDLE_TRACE_ACTOR_NAME,
        harness: IDLE_TRACE_HARNESS,
        turnItems: [
          corruptExtentPromptTurn(),
          corruptExtentToolsTurn(),
          corruptExtentReplyTurn(
            2,
            firstReplyMs,
            CORRUPT_EXTENT_FIRST_REPLY_TEXT
          ),
          corruptExtentReplyTurn(
            3,
            firstReplyMs + CORRUPT_EXTENT_PAUSE_MS,
            CORRUPT_EXTENT_SECOND_REPLY_TEXT
          ),
        ],
      },
    ]),
  };
}

function corruptExtentPromptTurn(): TurnItem {
  return {
    type: "prompt",
    _row: 0,
    t: new Date(IDLE_TRACE_FIRST_TURN_MS).toISOString(),
    tMs: IDLE_TRACE_FIRST_TURN_MS,
    cum: 0,
    actor: idleTraceActor(IDLE_TRACE_ACTOR_NAME),
    text: CORRUPT_EXTENT_PROMPT_TEXT,
  };
}

function corruptExtentToolsTurn(): TurnItem {
  return {
    type: "tools",
    _row: 1,
    t: new Date(CORRUPT_EXTENT_TOOL_START_MS).toISOString(),
    tMs: CORRUPT_EXTENT_TOOL_START_MS,
    endMs: CORRUPT_EXTENT_END_MS,
    cum: 1,
    actor: idleTraceActor(IDLE_TRACE_ACTOR_NAME),
    summary: CORRUPT_EXTENT_TOOL_SUMMARY,
    items: [{ label: "bash", detail: "pnpm collect", err: false }],
    hasFail: false,
    failN: 0,
    cats: { bash: 1 },
  };
}

function corruptExtentReplyTurn(
  row: number,
  atMs: number,
  text: string
): TurnItem {
  return {
    type: "say",
    _row: row,
    t: new Date(atMs).toISOString(),
    tMs: atMs,
    cum: 1,
    actor: idleTraceActor(IDLE_TRACE_ACTOR_NAME),
    text,
  };
}
