/**
 * @file shared-agent-session-detail-projection.ts
 * @description The desktop-local session-detail projection: one loaded
 * `SyncedAgentSession` (plus its already-folded list item) into the canonical
 * `AgentSessionDetail` shape the shared panel renders.
 *
 * Extracted from `shared-agent-sessions-api.ts` (a grandfathered over-ceiling
 * module) by ISS-5407, which added the raw-event bound this file now owns: the
 * detail read asks `loadSyncedSessions` for one row PAST
 * {@link SESSION_DETAIL_EVENT_MAX_ROWS} — the ceiling its cloud twin was capped
 * at by ISS-5075 — and `boundDetailEvents` turns that probe row into the served
 * prefix plus the `eventsTruncated` signal.
 */
import type {
  SyncedAgentSessionEvent,
  TokenEventCostPoint,
} from "@repo/api/src/types/agent-session";
import { SESSION_DETAIL_EVENT_MAX_ROWS } from "@repo/api/src/types/agent-session-detail-limits";
import type { TranscriptAvailabilitySummary } from "@repo/api/src/types/desktop-transcripts";
import type { SyncedArtifactRef } from "@repo/api/src/types/session-artifact-link";
import {
  buildActivitySegments,
  toActivitySegmentTokenEvents,
} from "@repo/lib/sessions/activity-segment-aggregation";
import {
  projectAgentSessionTimelineEvents,
  projectAgentSessionTurnItems,
} from "@repo/lib/sessions/agent-session-detail-projection";
import {
  DESKTOP_LOCAL_SESSION_AUTHOR_LABEL,
  type SharedAgentSessionDetail,
  type SharedAgentSessionListItem,
} from "../../shared/shared-agent-sessions-contract.js";
import type { SyncedAgentSession } from "../agent-sync/agent-session-sync-contract.js";
import type { SessionEventCounts } from "../agent-sync/agent-session-sync-source.js";
import { projectLocalLinkedArtifacts } from "./local-linked-artifacts.js";

/**
 * Bound a loaded session's raw event stream to the detail read ceiling.
 *
 * The loader reads one row PAST {@link SESSION_DETAIL_EVENT_MAX_ROWS}, so a read
 * that HIT the ceiling is detectable here: more rows than the cap means the
 * stored stream is larger than what was served. This trims the served set back
 * to the cap — a stable chronological PREFIX, since the read orders oldest-first
 * — and reports whether it did. Reading the SSOT constant here (rather than
 * taking it as an argument) is what keeps the `LIMIT` and this bound from
 * drifting apart, exactly as the cloud's `toBoundedDetailEvents` does.
 *
 * `truncation` is returned SPREAD-SHAPED (`{}` when the stream is complete) so
 * the caller splats it and `eventsTruncated` stays genuinely OMITTED rather than
 * serialized as a present falsy value — absence is the contract's only encoding
 * of "complete".
 *
 * Once this fires, the event-DERIVED trace SHAPE the detail projects —
 * `timeline`, `turnItems`, and the span/phase/throttle/marker fields the loader
 * folds from these same rows — describes the prefix, which is what the flag
 * announces (see `AgentSessionDetail.eventsTruncated`, whose scope names the
 * desktop producer's wider set). The event COUNTS and `lastActivityAt` are
 * deliberately outside that set: they are re-read on a whole-run basis so they
 * cannot disagree with the same session's Sessions-list row or with web.
 */
export function boundDetailEvents(rows: readonly SyncedAgentSessionEvent[]): {
  events: SyncedAgentSessionEvent[];
  truncation: { eventsTruncated?: true };
} {
  return {
    // `slice` on an under-cap array is just a copy, so the bounded path needs no
    // branch — the caller gets its own array either way.
    events: rows.slice(0, SESSION_DETAIL_EVENT_MAX_ROWS),
    truncation:
      rows.length > SESSION_DETAIL_EVENT_MAX_ROWS
        ? { eventsTruncated: true }
        : {},
  };
}

/**
 * Project one loaded local session into the canonical detail response. Keeps the
 * name it had inside `shared-agent-sessions-api.ts` — the surrounding code, the
 * shared `@repo/lib` aggregator docs, and the cloud projection all cite
 * "the desktop `mapDetail`" as the local producer.
 *
 * `events`/`truncation` come from {@link boundDetailEvents} and `listItem` from
 * the caller's list-item fold over that SAME bounded set, so the trace the panel
 * paints, the counts above it, and the truncation flag all describe one set.
 */
export function mapDetail(input: {
  session: SyncedAgentSession;
  listItem: SharedAgentSessionListItem;
  events: SyncedAgentSessionEvent[];
  truncation: { eventsTruncated?: true };
  wholeRunEventCounts?: SessionEventCounts;
  tokenEvents?: TokenEventCostPoint[];
  transcripts?: TranscriptAvailabilitySummary[];
  /**
   * ISS-5567: the desktop branch-detail route id for `session.branch`, resolved
   * by {@link resolveSessionBranchRouteId}. Omitted whenever the link cannot be
   * made honestly, which keeps the shared pane's Branch row plain text.
   */
  branchArtifactId?: string;
  /**
   * ISS-5617: the session's `closedloop_artifact` refs read UNBOUNDED by the
   * sync producer's ref budget ({@link AgentSessionSyncSource.loadSessionDocumentArtifactRefs}).
   * Present, these are the refs the "Linked artifacts" row is folded from and the
   * row can state a total. Omitted (a source that cannot answer), the fold falls
   * back to the sync-capped `session.artifactRefs` and no total is claimed.
   */
  documentArtifactRefs?: readonly SyncedArtifactRef[];
}): SharedAgentSessionDetail {
  const {
    session,
    listItem,
    events,
    truncation,
    wholeRunEventCounts,
    tokenEvents,
    transcripts,
    branchArtifactId,
    documentArtifactRefs,
  } = input;
  const timeline = projectAgentSessionTimelineEvents(events, {
    metadata: session.metadata,
  });
  // FEA-2275: derive the per-phase activity breakdown from the local raw tiling
  // (`session.activitySegmentRows`, replicated by FEA-3568) + the session's
  // token events, using the SAME shared @repo/lib aggregator the cloud detail
  // projection runs — so the authenticated desktop surface renders identically
  // to web (PLN-1198 Amendment v3 item 3), and the offline/local surface derives
  // it from local data. A session with no raw rows yields `[]`; the renderer
  // then falls back to the honest single catch-all segment.
  const activitySegments = buildActivitySegments(
    session.activitySegmentRows ?? [],
    toActivitySegmentTokenEvents(session.tokenEvents ?? [])
  );
  // ISS-5617: the Properties pane's "Linked artifacts" row. The local session
  // already carries the same session→document links the cloud resolves, but the
  // DTO dropped them — so `SessionLinkedArtifactsRow` received an empty list and
  // returned `null`, and a run that showed its artifacts on web showed no row at
  // all on the desktop in local-read mode.
  //
  // Prefer the caller's UNBOUNDED document read over `session.artifactRefs`: the
  // latter has already passed through the sync producer's 100-slot non-commit ref
  // budget (documents floored at 50), which is a WIRE constraint with no business
  // shaping a local read. Folding the capped array served at most 50 of a 60-link
  // session AND reported 50 as the total, so the row rendered "+44" where the
  // truth was "+54" — ten artifacts unreachable, with nothing on screen admitting
  // it (codex review). `refsAreComplete` is what decides whether a total may be
  // claimed at all; see the `linkedArtifactsTotal` spread below.
  const refsAreComplete = documentArtifactRefs !== undefined;
  const linkedArtifacts = projectLocalLinkedArtifacts(
    documentArtifactRefs ?? session.artifactRefs
  );
  return {
    ...listItem,
    // ISS-5407 (stage review): the three event-COUNT fields, put back on a
    // whole-run basis when the caller could recover one. `listItem` folded them
    // from the bounded rows, which past the ceiling is a prefix count rendered as
    // a bare whole-run stat — disagreeing with this session's own Sessions-list
    // row, and with web (the cloud detail reads persisted count columns the cap
    // never touches). Spread AFTER `listItem` so the recovered value wins, and
    // omitted entirely when there is none, so the loaded-row fold stays the
    // fallback rather than being replaced by a fabricated zero.
    ...(wholeRunEventCounts
      ? {
          toolUseCount: wholeRunEventCounts.toolUseCount,
          toolCallsTotal: wholeRunEventCounts.toolUseCount,
          errorCount: wholeRunEventCounts.errorCount,
        }
      : {}),
    // FEA-3324 / #2977: present only when a local on-disk transcript exists, so
    // the shared panel enables the transcript read for local sessions. Omitted
    // otherwise (the panel then renders its projected `fallbackItems` trace).
    ...(transcripts ? { transcripts } : {}),
    // ISS-5567: the Branch row's in-app destination. Spread conditionally so an
    // unresolvable branch leaves the key genuinely ABSENT — the shared pane reads
    // presence, and an explicit `null` would be an equally inert but noisier way
    // to say the same thing over IPC.
    ...(branchArtifactId ? { branchArtifactId } : {}),
    metadata: session.metadata ?? null,
    sourceArtifactId: session.attribution?.sourceArtifactId ?? null,
    sourceLoopId: session.attribution?.sourceLoopId ?? null,
    tokenUsageByModel: session.tokenUsageByModel,
    attribution: session.attribution ?? null,
    agents: session.agents,
    events,
    ...truncation,
    timeline,
    // FEA-3461: the local synced session already carries the Session Trace
    // source arrays (buildSessionTraceSyncFields), but the detail DTO dropped
    // them — so `throttleSources` never reached the renderer and the
    // throttle/limit dots rendered blank in Local mode only. Forward all three
    // (like the cloud detail does) so the dots render at parity; null → omitted
    // to match the cloud shape (`SessionTraceThrottleSource[] | undefined`).
    tracePhaseSources: session.tracePhaseSources ?? undefined,
    throttleSources: session.throttleSources ?? undefined,
    correctionSources: session.correctionSources ?? undefined,
    // FEA-3705: forward the raw activity-segment tiling (FEA-3568) so the
    // Activity Segments strip renders at parity in Local mode; null → omitted to
    // match the cloud shape (`SyncedActivitySegmentRow[] | undefined`).
    activitySegmentRows: session.activitySegmentRows ?? undefined,
    // FEA-2275: also forward the derived per-phase cost breakdown; omitted when
    // there is no tiling so the field's presence tracks real data (matches the
    // cloud + the renderer fallback).
    ...(activitySegments.length > 0 ? { activitySegments } : {}),
    // ISS-5617: spread conditionally so a session with no document links leaves
    // the key genuinely ABSENT. The shared row already renders nothing for an
    // empty list, so `[]` would behave identically today — but the field is an
    // optional wire value read over IPC, and its own contract says a producer
    // that has nothing to say omits it.
    ...(linkedArtifacts.length > 0 ? { linkedArtifacts } : {}),
    // `linkedArtifactsTotal` means "the true resolved total BEFORE the display
    // cap", so it is emitted only when the fold ran over the COMPLETE local link
    // set. It then equals the served length by construction — the desktop, like
    // the cloud's `toLinkedArtifactProjection`, ships every link it resolved and
    // lets `SessionLinkedArtifactsRow` apply the display cap client-side.
    //
    // Withheld when the refs came from the sync-capped `session.artifactRefs`
    // (a source with no `loadSessionDocumentArtifactRefs`): that set may be a
    // truncation of the real one, and a total measured off it would be the exact
    // lie this field exists to prevent. Omitted, the shared pane falls back to
    // `linkedArtifacts.length` — still not the pre-cap truth, but a documented
    // degradation the field is not putting its name to.
    //
    // Gated on a NON-EMPTY list for the same reason `linkedArtifacts` is: the
    // total describes that list, so a session with no document links omits both
    // rather than shipping a lone `0` the row would have to ignore.
    ...(refsAreComplete && linkedArtifacts.length > 0
      ? { linkedArtifactsTotal: linkedArtifacts.length }
      : {}),
    turnItems: projectAgentSessionTurnItems({
      sessionId: session.externalSessionId,
      harness: session.harness ?? "unknown",
      primaryModel: session.model ?? null,
      humanActor: {
        name: DESKTOP_LOCAL_SESSION_AUTHOR_LABEL,
        color: "#64748B",
      },
      agents: session.agents,
      events,
      timeline,
      tokenUsageByModel: session.tokenUsageByModel,
      tokenEvents,
    }),
  };
}
