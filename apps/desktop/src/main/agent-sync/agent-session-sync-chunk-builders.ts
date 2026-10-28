/**
 * @file agent-session-sync-chunk-builders.ts
 * @description How ONE chunk of a split session is shaped: the replicated base
 * every part carries, and the per-stream builders that put a single stream's
 * slice on it. Extracted from `agent-session-sync-payload.ts` (ISS-9859), which
 * owns the decisions — which streams paginate, and what to do when one cannot
 * fit — while this module owns only the shape of the resulting payload.
 */
import type {
  SessionPR,
  SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import { CHUNK_MARKER_SIZE_RESERVE } from "./agent-session-sync-chunk-packer.js";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";
import { sessionWithoutPrLists } from "./agent-session-sync-pr-ref-chunking.js";
import {
  type MonitoredActivityPageItem,
  monitoredActivityPageRefs,
  sessionWithoutMonitoredActivity,
} from "./monitored-activity-sync-pages.js";

export type SessionChunkBuilders = {
  buildEventChunk: (slice: SyncedAgentSession["events"]) => SyncedAgentSession;
  buildTokenEventChunk: (
    slice: NonNullable<SyncedAgentSession["tokenEvents"]>
  ) => SyncedAgentSession;
  buildActivitySegmentChunk: (
    slice: NonNullable<SyncedAgentSession["activitySegmentRows"]>
  ) => SyncedAgentSession;
  buildComponentUsageChunk: (
    slice: SyncedComponentUsage[][]
  ) => SyncedAgentSession;
  buildPrRefChunk: (
    slice: NonNullable<SyncedAgentSession["prRefs"]>
  ) => SyncedAgentSession;
  buildPrChunk: (slice: SessionPR[]) => SyncedAgentSession;
  buildMonitoredActivityChunk: (
    page: MonitoredActivityPageItem[]
  ) => SyncedAgentSession;
};

/**
 * The per-stream chunk builders for one split, bound to which streams this
 * split is paginating.
 *
 * A paginated stream is stripped from the replicated base so each part carries
 * only its own slice. HOW it is stripped differs per stream, and the difference
 * is the contract with the cloud rather than a style choice:
 *   - `activitySegmentRows` is EMPTIED (`[]`) on the base, because the opening
 *     chunk's explicit empty tiling is what tells the receiver to replace the
 *     stored one before the slices append (ISS-4541).
 *   - `components` (ISS-6884) and the two PR lists, `prRefs` and `prs`
 *     (ISS-9859), are OMITTED. An absent key is the cloud's "this part makes no
 *     claim", while an explicit `[]` is a retraction: for PR refs it DELETES the
 *     session's links, which on a part that carries no slice would wipe them
 *     before the first slice landed.
 *   - the monitored-activity carriers (ISS-9860) are stripped off every regular
 *     ref and the activity-only refs are dropped, while `artifactRefs` itself
 *     stays an array: the regular refs are the session's reference set on every
 *     part, and a page puts one page of carriers back on the refs of the
 *     targets it names.
 */
export function createChunkBuilders(
  session: SyncedAgentSession,
  paginating: {
    hasTokenEvents: boolean;
    activitySegments: boolean;
    components: boolean;
    prLists: boolean;
    monitoredActivity: boolean;
  }
): SessionChunkBuilders {
  // FEA-3788: reserve the `chunk: { index, total }` marker's serialized bytes
  // DURING sizing, not after. The packer fills each chunk right up to
  // `maxBytes`; if the marker were only stamped afterward it could push a full
  // chunk past the cap and get the whole session dead-lettered. Every built
  // chunk carries a worst-case-width placeholder, and the final stamp is never
  // wider than it.
  const withChunkMarkerReserve = (
    chunk: SyncedAgentSession
  ): SyncedAgentSession => ({ ...chunk, chunk: CHUNK_MARKER_SIZE_RESERVE });
  const withoutMonitoredActivity = paginating.monitoredActivity
    ? sessionWithoutMonitoredActivity(session)
    : session;
  const withoutComponents = paginating.components
    ? sessionWithoutComponentUsage(withoutMonitoredActivity)
    : withoutMonitoredActivity;
  const replicatedBase = paginating.prLists
    ? sessionWithoutPrLists(withoutComponents)
    : withoutComponents;
  const baseFor = (
    overrides: Partial<SyncedAgentSession>
  ): SyncedAgentSession =>
    withChunkMarkerReserve({
      ...replicatedBase,
      ...(paginating.activitySegments ? { activitySegmentRows: [] } : {}),
      ...overrides,
    });
  // FEA-2730: an event chunk keeps its pre-FEA-2730 shape when the session has
  // no token events — no empty `tokenEvents` key is shipped.
  const buildEventChunk = (
    slice: SyncedAgentSession["events"]
  ): SyncedAgentSession =>
    paginating.hasTokenEvents
      ? baseFor({ events: slice, tokenEvents: [] })
      : baseFor({ events: slice });
  return {
    buildEventChunk,
    buildTokenEventChunk: (slice) =>
      baseFor({ events: [], tokenEvents: slice }),
    buildActivitySegmentChunk: (slice) =>
      baseFor({ events: [], tokenEvents: [], activitySegmentRows: slice }),
    buildComponentUsageChunk: (slice) =>
      baseFor({ events: [], tokenEvents: [], components: slice.flat() }),
    // ISS-9859: every PR-list part is built `prRefsPaginated: false`, the page-0
    // value and the wider of the two, so sizing reserves its bytes.
    // `markPrListContinuations` flips each part after page 0 to `true` (MERGE)
    // once packing is done, which only shrinks it.
    buildPrRefChunk: (slice) =>
      baseFor({
        events: [],
        ...(paginating.hasTokenEvents ? { tokenEvents: [] } : {}),
        prRefs: slice,
        prRefsPaginated: false,
      }),
    // A `prs` part still states `prRefs` whenever the session did: when it is
    // page 0 (the session's refs are empty), that `[]` is the REPLACE that
    // retracts stale links, and on a later marked part it merges nothing.
    //
    // `prs: slice` is set even for the empty slice the packer measures, so the
    // measured base already holds the key's bytes and its additive count stays
    // exact. The packer never ships an empty slice, so no sent part carries
    // `prs: []`.
    buildPrChunk: (slice) =>
      baseFor({
        events: [],
        ...(paginating.hasTokenEvents ? { tokenEvents: [] } : {}),
        ...(session.prRefs === undefined ? {} : { prRefs: [] }),
        prs: slice,
        prRefsPaginated: false,
      }),
    // ISS-9860: a page carries the full regular ref set plus one page of
    // carriers on the refs of the targets it names; see
    // `monitoredActivityPageRefs` for the shape.
    buildMonitoredActivityChunk: (page) =>
      baseFor({
        events: [],
        tokenEvents: [],
        artifactRefs: monitoredActivityPageRefs(session, page),
      }),
  };
}

/**
 * ISS-6884: a copy of `session` with `components` OMITTED (key absent, not
 * `[]`). Used as the replicated base of a paginated split — an absent
 * `components` is the cloud's "leave the stored usage untouched" no-op.
 */
function sessionWithoutComponentUsage(
  session: SyncedAgentSession
): SyncedAgentSession {
  const { components: _omittedUsage, ...rest } = session;
  return rest;
}
