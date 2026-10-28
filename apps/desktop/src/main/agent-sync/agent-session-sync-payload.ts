import {
  MAX_SESSION_SYNC_CHUNKS,
  MAX_SYNCED_ACTIVITY_SEGMENTS,
  MAX_SYNCED_COMPONENT_USAGE,
  type SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import { SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES } from "@repo/api/src/types/agent-session-sync-limits";
import {
  compactAgentMetadataForPreview,
  MetadataContentPolicy,
} from "@repo/lib/agent-sessions/metadata-preview";
import { createChunkBuilders } from "./agent-session-sync-chunk-builders.js";
import {
  appendPaginatedChunks,
  appendRequiredStreamChunks,
  CHUNK_MARKER_SIZE_RESERVE,
  remainingChunkByteBudget,
  withinDecompressedCeiling,
} from "./agent-session-sync-chunk-packer.js";
import {
  componentUsageGroupRowCount,
  componentUsageWireKey,
  groupComponentUsageByComponent,
} from "./agent-session-sync-component-usage-identity.js";
import { collectComponentUsageParts } from "./agent-session-sync-component-usage-parts.js";
import {
  identitySyncPayloadSizer,
  type SyncPayloadSizer,
} from "./agent-session-sync-compression.js";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
} from "./agent-session-sync-contract.js";
import {
  chunkWithBoundedMetadata,
  compactSessionMetadataForSync,
} from "./agent-session-sync-metadata.js";
import {
  canPaginatePrLists,
  markPrListContinuations,
  paginatedPrListStreams,
  prListsCausedTheSplitFailure,
  sessionWithoutPrLists,
} from "./agent-session-sync-pr-ref-chunking.js";
import {
  appendMonitoredActivityPages,
  exceedsMonitoredActivitySyncPage,
  type MonitoredActivityPageItem,
  markMonitoredActivityPagesPartial,
  monitoredActivityPageItems,
  sessionWithoutMonitoredActivity,
} from "./monitored-activity-sync-pages.js";

export type PreparedAgentSessionPayload = (
  | {
      kind: "session";
      session: SyncedAgentSession;
      payloadBytes: number;
    }
  | {
      kind: "chunked";
      sessionId: string;
      firstChunk: SyncedAgentSession;
      remainingChunks: SyncedAgentSession[];
      payloadBytes: number;
      firstChunkBytes: number;
      chunkCount: number;
    }
  | {
      kind: "dead-letter";
      sessionId: string;
      payloadBytes: number;
    }
) & {
  /**
   * ISS-6999: component-usage units this prepare skipped because no single part
   * could carry them. Rides the RESULT because the production caller runs this
   * behind a worker thread, where a log callback cannot reach.
   *
   * Present ONLY when a unit was skipped AND these are the bytes that ship — a
   * report on a dead-lettered or superseded split would describe a drop no
   * delivery made.
   */
  unsendableComponentUnits?: UnsendableComponentUnits;
};

export type AgentSessionPayloadPreparer = {
  (
    sessions: SyncedAgentSession[],
    maxBytes: number,
    // FEA-4138: when true, size the cap/chunk decision against gzip-compressed
    // wire bytes (the server negotiated decompression). Optional + additive:
    // omitted/false keeps the legacy raw-JSON sizing + chunker path.
    compress?: boolean,
    // ISS-4541: when true, paginate an oversized session's activity-segment
    // tiling ACROSS chunks (each chunk a disjoint slice) instead of replicating
    // the whole tiling into every chunk's base. Set only after the server
    // advertised `agentSessionSyncActivityChunking` (it then merges the parts
    // additively). Optional + additive: omitted/false keeps the tiling in the
    // base — which either fits or dead-letters the whole session for a
    // larger-payload retry, and is never silently truncated.
    activityChunkingSupported?: boolean,
    // ISS-7775: what the machine's data-sync level permits inside `metadata`.
    // Optional and trailing so an existing caller compiles, but see
    // `DEFAULT_SYNC_CONTENT_POLICY` — absence resolves to the WITHHOLDING
    // policy, not the permissive one, so a caller that forgets cannot leak.
    contentPolicy?: MetadataContentPolicy,
    // ISS-9859: when true, a session whose PR lists (`prRefs`, `prs`) are why
    // the replicated split fails may paginate them across parts (page 0 marked
    // `prRefsPaginated: false`, which the server replaces on; every later part
    // `true`, which it merges).
    // Optional + additive: omitted/false keeps both lists whole in every part,
    // which fits or dead-letters — never a partial set against a REPLACE-ALL
    // server.
    prRefChunkingSupported?: boolean
  ): Promise<PreparedAgentSessionPayload[]>;
  dispose?: () => void | Promise<void>;
};

/**
 * ISS-7775 — what an unstated `contentPolicy` means on this producer: WITHHOLD.
 *
 * Fail-closed, because the two mistakes are not symmetric. A caller that forgets
 * to state its tier and gets the permissive policy leaks prompts under a consent
 * card that promised it would not, silently and forever. A caller that forgets
 * and gets this one ships a payload with no turn text — which the tests that
 * care about turn text fail on immediately and loudly. Only the two production
 * egress paths (the sync service and its payload worker) pass a real level, each
 * derived from the persisted setting via `dataSyncLevelToMetadataContentPolicy`.
 */
const DEFAULT_SYNC_CONTENT_POLICY = MetadataContentPolicy.Omit;

export function estimateSessionPayloadBytes(
  session: SyncedAgentSession,
  sizer: SyncPayloadSizer = identitySyncPayloadSizer
): number {
  return sizer.byteLength(session);
}

export function estimateAgentSessionSyncBatchBytes(
  batch: AgentSessionSyncBatch,
  sizer: SyncPayloadSizer = identitySyncPayloadSizer
): number {
  return sizer.byteLength(batch);
}

/**
 * Prepare one sync candidate using the same payload semantics as the transport
 * path: strip transcript-sized event content, enforce the byte cap, and split
 * oversized event arrays into chunks when metadata can still fit.
 */
export function prepareAgentSessionPayload(
  session: SyncedAgentSession,
  maxBytes: number,
  sizer: SyncPayloadSizer = identitySyncPayloadSizer,
  // FEA-4152: the decompressed-size target this producer chunks to. A gzip
  // payload can fit the compressed wire cap yet decompress past the server's
  // ceiling, which the route rejects (`Invalid compressed body` →
  // `validation_failed`) → dead-letter. Bounding it here forces such a payload
  // to chunk further instead of shipping whole. For the identity path the target
  // (4 MiB) is far above `maxBytes` (256 KiB), so it never binds and the legacy
  // path is unchanged.
  //
  // ISS-5992: this is the PRODUCER target and is deliberately lower than the
  // server's `SYNC_DECOMPRESSED_BYTE_CEILING` (16 MiB) rather than equal to it.
  // The two halves deploy independently, and only this direction is safe — a
  // producer that targeted the raised ceiling before the server was deployed
  // would ship payloads the old server rejects and dead-letters.
  maxDecompressedBytes: number = SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES,
  // ISS-4541: paginate the activity-segment tiling across chunks (server merges
  // the parts additively). Optional + additive; omitted keeps the tiling in the
  // base payload (old behavior).
  activityChunkingSupported = false,
  // ISS-7775: what this machine's data-sync level permits inside `metadata`.
  // Defaults to WITHHOLDING (see `DEFAULT_SYNC_CONTENT_POLICY`), so an omitted
  // argument can only under-share.
  contentPolicy: MetadataContentPolicy = DEFAULT_SYNC_CONTENT_POLICY,
  // ISS-9859: the server merges a part marked `prRefsPaginated` into the
  // session's stored PR links and `prs` blob. Only then may an oversized
  // session's PR lists be split across parts, and only when they are why the
  // replicated split fails.
  prRefChunkingSupported = false
): PreparedAgentSessionPayload {
  const sanitized = sanitizeSessionForSync(session, contentPolicy);
  const payloadBytes = estimateSessionPayloadBytes(sanitized, sizer);
  if (
    payloadBytes <= maxBytes &&
    // ISS-6884: a session can fit the byte cap while carrying more component
    // usage rows than one payload may declare. The cloud wire schema `.max()`es
    // `components` and rejects the WHOLE batch on overflow, so such a session
    // must be CHUNKED (its usage paginated across parts) even though its bytes
    // fit — the alternative is the permanent truncation this ticket removes.
    !exceedsComponentUsagePayloadCap(sanitized) &&
    // ISS-9860: monitored activity is paged at a per-request event ceiling the
    // same way — a session over it must be chunked even when its bytes fit.
    !exceedsMonitoredActivitySyncPage(sanitized) &&
    withinDecompressedCeiling(sanitized, sizer, maxDecompressedBytes)
  ) {
    return { kind: "session", session: sanitized, payloadBytes };
  }

  let unsendableUnits: UnsendableComponentUnits | undefined;
  const captureUnsendableUnits = (units: UnsendableComponentUnits): void => {
    unsendableUnits = units;
  };

  const chunks = chunkOversizedSession(
    sanitized,
    maxBytes,
    sizer,
    maxDecompressedBytes,
    activityChunkingSupported,
    captureUnsendableUnits,
    prRefChunkingSupported
  );
  if (chunks.length > 0) {
    return withUnsendableComponentUnits(
      chunkedResult(sanitized, chunks, payloadBytes, sizer),
      unsendableUnits
    );
  }

  // ISS-4578 (P1 #1) — BOUNDED FALLBACK for a session that cannot be chunked
  // WITH its tiling. Against an OLD server (`activityChunkingSupported === false`)
  // the tiling rides the base whole and a large one pushes that base past the cap.
  // ISS-9865 added the second way in: the tiling is now read in full and
  // paginated, so one large enough to exhaust `MAX_SESSION_SYNC_CHUNKS` makes the
  // CAPABLE path return [] as well. Either way the return above is [], and
  // dead-lettering there would discard the events, agents, metadata and
  // tokenEvents that sync fine just because the tiling is oversized — strictly
  // worse than the pre-ISS-9865 reader, which omitted such a tiling and let the
  // rest of the session sync. Instead DEGRADE to the best safe partial: re-chunk
  // with the tiling STRIPPED so the rest of the session reaches the cloud now, on
  // BOTH paths, and record the same durable debt below. Omitting
  // `activitySegmentRows` is a cloud no-op (never clears a previously stored
  // tiling — see persistSessionActivitySegments). Only when even the
  // tiling-stripped session can't fit is the whole session genuinely unchunkable
  // → dead-letter.
  //
  // ISS-7265 AC3 — THE DECISION, made rather than inherited. Of the three
  // candidates the ticket named:
  //   • CHUNK FURTHER is already what happens whenever the server advertises
  //     `agentSessionSyncActivityChunking` — the tiling paginates across chunks
  //     and nothing is dropped. It is unavailable HERE because it has already
  //     been tried and could not produce a chunk: against an old server a
  //     multi-part tiling is stored partial (silent corruption), and against a
  //     capable one (ISS-9865) the tiling exhausted the chunk budget.
  //   • REFUSE-AND-RETRY is worse than the defect. Dead-lettering the session
  //     withholds its events, agents, metadata and token events too, trading a
  //     partial degradation for total non-delivery of data that syncs fine.
  //   • STRIP-AND-FLAG is therefore kept — but it was a DISCARD, not a deferral,
  //     and that is the part that was wrong. A stripped delivery is acked like
  //     any other, so the outbox clears and the session dequeues, and selection
  //     walks `sessions.updated_at`, never "the delivery was incomplete". The
  //     claim that it "resyncs once the server advertises chunking" rested on an
  //     unrelated re-derivation happening to re-mark the row dirty.
  // So the strip now records a DURABLE DEBT on the confirmed delivery
  // (`activity_tiling_repair_owed`, see `activity-tiling-repair-store.ts`), and
  // the debt re-queues the session once the merging capability arrives. The
  // degradation is bounded in time instead of permanent, and no user-visible
  // capability is traded away to get there.
  const hasTiling = (sanitized.activitySegmentRows?.length ?? 0) > 0;
  // ISS-9865: the strip is no longer an old-server-only degrade — see above.
  const stripTiling = hasTiling;
  // OMIT the key entirely (not `[]`): an absent `activitySegmentRows` is the
  // cloud's "leave the stored tiling untouched" no-op signal, and it keeps the
  // wire payload minimal (no empty array shipped). Against an OLD server the
  // ISS-7997 metadata degrade starts from this same base, so a tiling that could
  // not ride the base is never re-added by that retry; see
  // `metadataDegradeBase` for why the capable path keeps its tiling there.
  const withoutTiling = stripTiling
    ? sessionWithoutTiling(sanitized)
    : sanitized;
  if (stripTiling) {
    const withoutTilingBytes = estimateSessionPayloadBytes(
      withoutTiling,
      sizer
    );
    if (
      withoutTilingBytes <= maxBytes &&
      // ISS-6884: same per-payload component-usage bound as the fast path above.
      !exceedsComponentUsagePayloadCap(withoutTiling) &&
      !exceedsMonitoredActivitySyncPage(withoutTiling) &&
      withinDecompressedCeiling(withoutTiling, sizer, maxDecompressedBytes)
    ) {
      return {
        kind: "session",
        session: withoutTiling,
        payloadBytes: withoutTilingBytes,
      };
    }
    const fallbackChunks = chunkOversizedSession(
      withoutTiling,
      maxBytes,
      sizer,
      maxDecompressedBytes,
      // Still false — the tiling is already stripped, so there is nothing to
      // paginate; this just chunks events/tokenEvents as usual.
      false,
      captureUnsendableUnits,
      prRefChunkingSupported
    );
    if (fallbackChunks.length > 0) {
      return withUnsendableComponentUnits(
        chunkedResult(withoutTiling, fallbackChunks, payloadBytes, sizer),
        unsendableUnits
      );
    }
  }

  // ISS-7997 — LAST RESORT, before the session stops existing for the reader.
  // The shared compaction contract bounds `metadata` per dimension and never in
  // aggregate, so a blob it admits WHOLE can exceed the cap on its own and no
  // chunk can be built at all — discarding the events, agents, token usage and
  // status that were never the problem. Absent is worse than partial, which is
  // the judgement the tiling strip above and the token-event degrade below
  // already make, so keep the metadata keys that fit and ship the rest.
  //
  // ISS-9865: which base this degrade starts from turns on the capability, and
  // deliberately keeps the pre-ISS-9865 behaviour on each path. Against an OLD
  // server the tiling rides the base, so a stripped base is the only one that can
  // fit. Against a CAPABLE one the tiling paginates into its own chunks, so the
  // strip above was a budget fallback rather than a verdict on the tiling — a
  // smaller metadata shrinks every replicated chunk base and can leave room for
  // it, and starting from the stripped base would drop a tiling that this retry
  // could still have delivered.
  const metadataDegradeBase = activityChunkingSupported
    ? sanitized
    : withoutTiling;
  const degraded = chunkWithBoundedMetadata(
    metadataDegradeBase,
    // The budget is MEASURED — the cap minus this session carrying no metadata
    // and no paginated stream — rather than assumed, so a healthy blob is never
    // trimmed further than the oversize requires. It omits whatever the real
    // base still replicates, so it can overshoot; the degrade halves on a failed
    // attempt, and the chunker it is handed decides every attempt.
    //
    // ISS-9860: the monitored carriers are a paginated stream too, so they are
    // stripped here exactly as the replicated base strips them. Measured
    // against the full carriers an uncapped session's budget reaches zero, the
    // degrade returns null, and a session that could have shipped dead-letters.
    remainingChunkByteBudget(
      {
        ...sessionWithoutMonitoredActivity(metadataDegradeBase),
        metadata: undefined,
        events: [],
        tokenEvents: [],
        activitySegmentRows: [],
        components: [],
        chunk: CHUNK_MARKER_SIZE_RESERVE,
      },
      maxBytes,
      sizer,
      maxDecompressedBytes
    ),
    (candidate) =>
      chunkOversizedSession(
        candidate,
        maxBytes,
        sizer,
        maxDecompressedBytes,
        activityChunkingSupported,
        captureUnsendableUnits,
        prRefChunkingSupported
      )
  );
  if (degraded) {
    return withUnsendableComponentUnits(
      chunkedResult(metadataDegradeBase, degraded, payloadBytes, sizer),
      unsendableUnits
    );
  }

  return {
    kind: "dead-letter",
    sessionId: sanitized.externalSessionId,
    payloadBytes,
  };
}

/** Shape a non-empty chunk list into the `chunked` prepared result. */
function chunkedResult(
  session: SyncedAgentSession,
  chunks: SyncedAgentSession[],
  payloadBytes: number,
  sizer: SyncPayloadSizer
): PreparedAgentSessionPayload {
  const [firstChunk, ...remainingChunks] = chunks;
  return {
    kind: "chunked",
    sessionId: session.externalSessionId,
    firstChunk,
    remainingChunks,
    payloadBytes,
    firstChunkBytes: estimateSessionPayloadBytes(firstChunk, sizer),
    chunkCount: chunks.length,
  };
}

/**
 * Reduce a session to the fields the cloud persists before sync. FEA-2718
 * dropped conversation turn text (`summary`/`data`) from the cloud lane: each
 * synced event is rebuilt from the retained columnar metadata only, so the
 * desktop never ships turn/tool text over the wire (the cloud transcript archive
 * — FEA-2717 — is the sole source of turn/tool detail). The desktop-local trace
 * still reads `summary`/`data` from its own SQLite, so only the sync copy is
 * slimmed.
 *
 * ISS-7775: `contentPolicy` is REQUIRED, and that is the point. FEA-2718 closed
 * the EVENT-row channel and the reasoning generalised to "prompts stay on the
 * device" while the `metadata` blob was still shipping them, because this
 * function took no tier at all — Metadata, Redacted and Full emitted identical
 * bytes. Making the policy an argument with no default means a call site cannot
 * silently inherit the permissive one; `tsc` asks every new caller which tier it
 * is speaking for. Derive it with `dataSyncLevelToMetadataContentPolicy`.
 *
 * ISS-8014: `agents[].metadata` is compacted here too. The desktop used to ship
 * it RAW (`sync-source.ts` copies the column verbatim) and rely on the cloud's
 * own `sanitizeMetadataForPersist` to strip it after arrival, so a secret in a
 * parser-supplied subagent metadata key crossed the wire in the clear. Running
 * the same shared contract producer-side makes the bytes that LEAVE match the
 * bytes the cloud stores, which is what the FEA-3693 "one shared contract"
 * claim already asserted for session metadata. It goes through
 * `compactAgentMetadataForPreview` rather than the session entry point (review:
 * davetho) — the two blobs are separate roots, so judging the agent's paths
 * against the session-rooted allow-list let an agent borrow a session slot's
 * permission by reusing its root key. See `AGENT_METADATA_PATH_ROOT`.
 */
export function sanitizeSessionForSync(
  session: SyncedAgentSession,
  contentPolicy: MetadataContentPolicy
): SyncedAgentSession {
  // ISS-10332: the local read needs `priority: null` ("no priority"); the wire
  // omits it, so an absent field is the only way a payload says "no claim".
  const { priority, ...rest } = session;
  return {
    ...rest,
    ...(priority ? { priority } : {}),
    // ISS-9864: the agent-turn key is derived only for a session the cloud
    // reads on its `$.messages` fallback — one with no synced token events.
    // `tokenEvents` is omitted from the hydrated session when empty, so absence
    // and emptiness are the same fact here.
    metadata: compactSessionMetadataForSync(session.metadata, contentPolicy, {
      hasTokenEvents: (session.tokenEvents?.length ?? 0) > 0,
    }),
    agents: session.agents.map(({ task: _task, ...agent }) => ({
      // ISS-6894: `task` is OMITTED from the wire, not nulled. The field stays
      // on `SyncedAgentSessionAgent` for the transcript-archive reconstruction
      // the cloud builds in-browser, so without this destructure the spread
      // below puts the raw delegation prompt back on the sync lane.
      //
      // `sync-source.ts` also stopped selecting the column, which is NOT a
      // reason to call this redundant — this is the egress boundary, and the
      // thing that actually fails when the scrub is removed is
      // `data-sync-egress-honesty.test.ts`, which runs this function and
      // asserts channel by channel. (Review: marisolashgrove on #7000 — do not
      // justify it by caller count; there is one production caller, line 149.)
      ...agent,
      metadata: compactAgentMetadataForPreview(agent.metadata, contentPolicy),
    })),
    events: session.events.map((event) => ({
      externalEventId: event.externalEventId,
      agentExternalId: event.agentExternalId,
      eventType: event.eventType,
      toolName: event.toolName,
      createdAt: event.createdAt,
    })),
  };
}

/**
 * Split an oversized session into multiple chunks, each within the byte cap.
 * Every chunk replicates the full session metadata, agents, and token usage;
 * the large per-row streams — `events`, (FEA-2730) `tokenEvents`, and
 * (ISS-4541) `activitySegmentRows` — are paginated across chunks, with each
 * chunk carrying a disjoint slice of exactly one stream and the others emptied.
 * All three streams merge idempotently cloud-side, so distributing their rows
 * across chunks is safe. When the session carries no tokenEvents (and no
 * paginated tiling), event chunks keep their original
 * `{ ...session, events: slice }` shape (no empty tokenEvents key), preserving
 * the pre-FEA-2730 chunking contract.
 *
 * ISS-4541: `activitySegmentRows` is paginated as a third stream ONLY when
 * `activityChunkingSupported` (the server advertised
 * `agentSessionSyncActivityChunking` and will merge the parts additively). When
 * NOT supported the tiling rides the base whole (`...session`) exactly as
 * before, so an oversized base yields no chunk at all (never a silent
 * truncation) — and ISS-9865 added a second way to reach that empty return
 * under the capability, a tiling large enough to exhaust
 * `MAX_SESSION_SYNC_CHUNKS`. Either way the CALLER degrades rather than
 * dead-letters; see `prepareAgentSessionPayload`'s bounded fallback.
 * Splitting on segment
 * BOUNDARIES (each row a `[startMs, endMs)` span with a unique startMs) keeps
 * every part a valid non-overlapping sub-tiling; the receiver's replace-on-open
 * + append-idempotent merge keys on `(agentSessionId, startMs)`, so a stale
 * partial set can never collide with a newer sequence (the chunk `{index,total}`
 * marker + the tiling's own `dataRevision`/`classifierVersion` are the
 * consistency dimensions the cloud gate uses).
 *
 * ISS-6884: `components` is paginated as a FOURTH stream once the set exceeds
 * `MAX_SYNCED_COMPONENT_USAGE` — the per-payload wire cap that was previously
 * applied as a permanent population cap at the reader. Its pagination unit is a
 * whole `(componentKind, componentKey)` group, because the cloud prune deletes a
 * PRESENT group's omitted branch buckets but leaves an ABSENT group untouched;
 * whole-group parts therefore merge correctly on any server version, so unlike
 * the tiling this stream needs no negotiated capability.
 *
 * ISS-9860: the monitored-session activity carriers are paginated as their own
 * stream whenever the session carries any: regular refs stay on every part with
 * the carrier stripped, activity-only refs leave the base, and each page puts at
 * most `MONITORED_ACTIVITY_SYNC_PAGE_EVENTS` distinct events back on the refs of
 * the targets it names. Sealed by measurement, degradable on budget exhaustion;
 * see `monitored-activity-sync-pages.ts`.
 *
 * Returns [] when metadata alone exceeds the cap (or the chunk budget is
 * exhausted), because no valid chunk can be produced without changing the
 * outbound session contract.
 *
 * FEA-4152: each chunk must satisfy BOTH the compressed wire cap (`maxBytes`)
 * AND the server's decompressed-size ceiling (`maxDecompressedBytes`). Under
 * gzip a chunk can pack many rows under the compressed cap yet decompress past
 * the ceiling; bounding both keeps every emitted chunk acceptable to the route.
 */
export function chunkOversizedSession(
  session: SyncedAgentSession,
  maxBytes: number,
  sizer: SyncPayloadSizer = identitySyncPayloadSizer,
  maxDecompressedBytes: number = SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES,
  activityChunkingSupported = false,
  // ISS-6999: called at most ONCE, only from a return that commits chunks —
  // never from a `[]`, where the session dead-letters and nothing shipped
  // without the unit. Optional and trailing, so existing callers are unaffected.
  onUnsendableComponentUnits?: (units: UnsendableComponentUnits) => void,
  // ISS-9859: may this session's PR lists (`prRefs`, `prs`) be split across
  // parts? Only a server that merges a marked part
  // (`agentSessionSyncPrRefChunking`) can take one.
  prRefChunkingSupported = false
): SyncedAgentSession[] {
  const replicated = chunkSessionStreams(
    session,
    maxBytes,
    sizer,
    maxDecompressedBytes,
    activityChunkingSupported,
    {
      paginatePrLists: false,
      onUnsendableComponentUnits,
      prRefChunkingSupported,
    }
  );
  if (
    replicated.length > 0 ||
    !canPaginatePrLists(session, prRefChunkingSupported)
  ) {
    return replicated;
  }
  // The replicated split produced nothing. Paginate the PR lists ONLY if they
  // are the reason — the probe below carries no unsendable-unit sink, because
  // it is a measurement and ships nothing.
  const withoutPrLists = chunkSessionStreams(
    sessionWithoutPrLists(session),
    maxBytes,
    sizer,
    maxDecompressedBytes,
    activityChunkingSupported,
    { paginatePrLists: false, prRefChunkingSupported: false }
  );
  if (!prListsCausedTheSplitFailure(withoutPrLists)) {
    return replicated;
  }
  return chunkSessionStreams(
    session,
    maxBytes,
    sizer,
    maxDecompressedBytes,
    activityChunkingSupported,
    {
      paginatePrLists: true,
      onUnsendableComponentUnits,
      prRefChunkingSupported,
    }
  );
}

function chunkSessionStreams(
  session: SyncedAgentSession,
  maxBytes: number,
  sizer: SyncPayloadSizer,
  maxDecompressedBytes: number,
  activityChunkingSupported: boolean,
  options: {
    // ISS-9859: split `prRefs` and `prs` into their own parts (each marked),
    // rather than replicating both whole lists into every part.
    paginatePrLists: boolean;
    onUnsendableComponentUnits?: (units: UnsendableComponentUnits) => void;
    prRefChunkingSupported: boolean;
    // ISS-9860: carry the monitored carriers on every part the pre-paging way
    // instead of paging them. Set only by the retry below, for a session whose
    // required streams left the paged stream no part at all.
    replicateMonitoredActivity?: boolean;
  }
): SyncedAgentSession[] {
  const {
    paginatePrLists,
    onUnsendableComponentUnits,
    prRefChunkingSupported,
    replicateMonitoredActivity = false,
  } = options;
  const tokenEvents = session.tokenEvents ?? [];
  const hasTokenEvents = tokenEvents.length > 0;
  // ISS-4541: paginate the tiling as its own stream only when the server merges
  // multi-part tilings additively; otherwise it rides the base whole.
  const activitySegmentRows = session.activitySegmentRows ?? [];
  const paginateActivitySegments =
    activityChunkingSupported && activitySegmentRows.length > 0;
  // ISS-6884: paginate component usage as its own stream once the set exceeds
  // what one payload may declare. Below the cap it rides the base whole (the
  // pre-ISS-6884 shape) — replicating it into every chunk is an idempotent
  // upsert cloud-side, so there is nothing to gain from splitting it.
  const paginateComponents = exceedsComponentUsagePayloadCap(session);
  // ISS-9860: monitored-session activity is paginated as its own stream whenever
  // the session carries any — the carriers leave the replicated base and ship in
  // pages of at most `MONITORED_ACTIVITY_SYNC_PAGE_EVENTS` distinct events.
  // Replicating an uncapped carrier into every chunk would let the base alone
  // exceed the cap. Needs no negotiated capability: each page carries the full
  // regular ref set plus one page of carriers, and the cloud persists monitored
  // atoms per part with an idempotent insert and no delete-replace, so any
  // server version merges the pages additively.
  const monitoredActivityItems = replicateMonitoredActivity
    ? []
    : monitoredActivityPageItems(session);
  const paginateMonitoredActivity = monitoredActivityItems.length > 0;
  const {
    buildEventChunk,
    buildTokenEventChunk,
    buildActivitySegmentChunk,
    buildComponentUsageChunk,
    buildPrRefChunk,
    buildPrChunk,
    buildMonitoredActivityChunk,
  } = createChunkBuilders(session, {
    hasTokenEvents,
    activitySegments: paginateActivitySegments,
    components: paginateComponents,
    prLists: paginatePrLists,
    monitoredActivity: paginateMonitoredActivity,
  });
  const componentUsageParts = collectComponentUsageParts({
    session,
    paginate: paginateComponents,
    buildComponentUsageChunk,
    maxBytes,
    sizer,
    maxDecompressedBytes,
  });

  const baseSession = buildEventChunk([]);
  if (
    estimateSessionPayloadBytes(baseSession, sizer) > maxBytes ||
    !withinDecompressedCeiling(baseSession, sizer, maxDecompressedBytes)
  ) {
    return [];
  }
  if (
    session.events.length === 0 &&
    !hasTokenEvents &&
    !paginateActivitySegments &&
    !paginateComponents &&
    !paginateMonitoredActivity &&
    // ISS-9859: without this, a session with no events and paginated PR lists
    // would return the single stripped base — every PR dropped, silently.
    !paginatePrLists
  ) {
    // ISS-5090: STAMP even the single-chunk result. `baseSession` still carries
    // the worst-case `CHUNK_MARKER_SIZE_RESERVE` placeholder that sizing
    // reserved, and since the chunk marker is now what classifies a rejection
    // (multi-part envelope vs whole row) and what gates the cloud's
    // delete-replace, shipping the placeholder verbatim would misreport a whole
    // session as part 99 of 100.
    return stampChunkMetadata([baseSession]);
  }

  const chunks: SyncedAgentSession[] = [];
  // The REQUIRED streams, in priority order — see
  // `appendRequiredStreamChunks` for why they take the shared chunk budget
  // before the degradable ones below, and why each one failing dead-letters.
  if (
    !appendRequiredStreamChunks(chunks, {
      events: session.events,
      buildEventChunk,
      activitySegmentRows: paginateActivitySegments ? activitySegmentRows : [],
      buildActivitySegmentChunk,
      maxActivityRowsPerChunk: MAX_SYNCED_ACTIVITY_SEGMENTS,
      ...paginatedPrListStreams(session, paginatePrLists),
      buildPrRefChunk,
      buildPrChunk,
      maxBytes,
      sizer,
      maxDecompressedBytes,
    })
  ) {
    return [];
  }
  // ISS-9860: monitored pages come AFTER the required streams and BEFORE the
  // component usage (which owns a parity retry that re-splits the whole session)
  // and the token events. Degradable like both of those: a budget exhausted
  // mid-stream keeps the pages already built, and because the items are newest
  // first the tail dropped is the oldest. Nothing defers that tail — the next
  // hydration re-reads the same carriers, pages them identically, and drops the
  // identical tail for as long as the required streams keep the budget, exactly
  // as ISS-6884 records for component usage below — so the pages that DO ship
  // are stamped `Partial`, and the cloud records the prefix as incomplete
  // evidence rather than as the whole set. When NO page ships there is no
  // carrier left to carry that stamp, so the stream falls back the way ISS-6884
  // does for component usage: re-split with the carriers REPLICATED onto every
  // part (the pre-paging shape) so removing the cap never delivers less than
  // the cap did; and when even that yields nothing, the split fails and the
  // caller degrades or dead-letters instead of acking a stripped base with
  // every monitored event silently gone.
  if (
    paginateMonitoredActivity &&
    appendMonitoredActivityStream(chunks, monitoredActivityItems, {
      buildPage: buildMonitoredActivityChunk,
      maxBytes,
      sizer,
      maxDecompressedBytes,
    }) === MonitoredActivityStreamOutcome.NothingShipped
  ) {
    return chunkSessionStreams(
      session,
      maxBytes,
      sizer,
      maxDecompressedBytes,
      activityChunkingSupported,
      { ...options, replicateMonitoredActivity: true }
    );
  }
  // ISS-6884: paginate component usage AFTER the required tiling and BEFORE the
  // best-effort token events, on WHOLE (kind,key) group boundaries. The cloud
  // prune is group-scoped — for each group PRESENT in a payload it deletes the
  // branch buckets that payload omits — so a group split across parts would have
  // its earlier branches deleted by the later part, while a group absent from a
  // part is left untouched. Whole-group parts are therefore safe against a NEW
  // and an OLD server alike, which is why this stream needs no negotiated
  // capability (unlike ISS-4541's tiling, whose merge the server had to learn).
  //
  // Degrades like token events rather than dead-lettering: if the shared
  // MAX_SESSION_SYNC_CHUNKS budget runs out mid-stream, the parts already built
  // still ship.
  //
  // `appendPaginatedChunks` returns false in exactly that case and the result is
  // deliberately NOT propagated — a component-usage overflow must not
  // dead-letter a session whose events and tiling synced fine. But be precise
  // about what the tail then does, because it is NOT deferred (ISS-6884, codex
  // review): `agent_component_session_usage` carries no sync cursor and
  // `selectComponentUsageRows` orders deterministically, so the next hydration
  // re-reads the identical set, re-packs it identically, and drops the identical
  // tail. Unlike token events — append-only and re-offered until they land — a
  // starved usage tail is dropped for as long as the session's events keep
  // consuming the budget. The guard below bounds that loss at the pre-ISS-6884
  // prefix, so this can never deliver LESS than the cap it replaced; it does not
  // make the tail eventually arrive. Closing that gap needs a durable per-session
  // usage cursor, which is its own change.
  //
  // With ONE exception. The required streams above can consume enough of the
  // budget that the paginated stream delivers FEWER rows than the pre-ISS-6884
  // bounded prefix would have — including none at all, since `baseFor` has
  // already stripped `components` from every chunk they built. The two packers
  // are not comparable: the prefix SKIPS a unit that does not fit and keeps
  // scanning, while the chunk packer SEALS there and then runs out of budget, so
  // "some parts were appended" is not evidence of parity. Removing a permanent
  // truncation must never deliver less than the truncation did, so compare the
  // rows actually delivered against that prefix and redo the split against the
  // bounded session when it wins. Last resort, not the fix: it needs a session
  // whose events/tiling alone are within a chunk or two of dead-lettering.
  if (paginateComponents) {
    const chunksBeforeComponents = chunks.length;
    appendPaginatedChunks(
      chunks,
      componentUsageParts.sendableUnits,
      maxBytes,
      buildComponentUsageChunk,
      sizer,
      maxDecompressedBytes,
      MAX_SYNCED_COMPONENT_USAGE,
      componentUsageGroupRowCount
    );
    const boundedChunks = boundedComponentUsageRetry(
      session,
      componentUsageParts.wireUnits,
      componentRowsIn(chunks, chunksBeforeComponents),
      {
        activityChunkingSupported,
        maxBytes,
        maxDecompressedBytes,
        prRefChunkingSupported,
        sizer,
      }
    );
    if (boundedChunks) {
      // ISS-6999: the retry ships a DIFFERENT partition — whole wire groups up
      // to the payload cap — so the fold-family tally above describes bytes that
      // are now not being sent. Report what THIS partition leaves behind
      // instead, measured against the same session, or the case the reader's own
      // bounded prefix cannot see would report nothing at all.
      reportUnsendableComponentUnits(
        omittedComponentUnits(session, boundedChunks),
        onUnsendableComponentUnits
      );
      return boundedChunks;
    }
  }
  // Token events are keep-all/append-only and idempotent cloud-side, and they
  // share the events'/tiling's MAX_SESSION_SYNC_CHUNKS budget. If they can't all
  // be paginated within what remains, DEGRADE: keep the chunks already built and
  // drop the overflow token events, rather than returning [] — which would
  // dead-letter the whole session and discard events/agents/metadata/tiling that
  // synced fine. appendPaginatedChunks appends greedily, so any token-event
  // chunks that DID fit are retained; the remainder resyncs on a later pass.
  // (Events and the required tiling overflowing the budget above still
  // dead-letter.)
  if (hasTokenEvents) {
    appendPaginatedChunks(
      chunks,
      tokenEvents,
      maxBytes,
      buildTokenEventChunk,
      sizer,
      maxDecompressedBytes
    );
  }

  // ISS-6999: reaching here means these chunks ARE the payload, so a row missing
  // from them is a row that will not sync. Measured the same partition-
  // independent way as the retry arm — against the delivered chunks, not against
  // the pre-filter tally — because the budget-starved tail is dropped just as
  // permanently as a unit no part could carry, and `skippedUnits` cannot see it.
  // ISS-9859: the paginated base carries neither PR list, so falling back to it
  // alone would ship a session with every PR dropped and nothing marking the
  // loss. No slice part means no valid split.
  if (paginatePrLists && chunks.length === 0) {
    return [];
  }
  const committed = chunks.length > 0 ? chunks : [baseSession];
  // ISS-9859: page 0 keeps the `prRefsPaginated: false` every PR-list part is
  // built with, so the cloud replaces both PR lists with it even at a freshness
  // tie; every later PR-list part becomes `true` and merges on top of it, and
  // the serial drain guarantees page 0 is applied first.
  //
  // Unconditional on purpose: when this split is not paginating PR lists both
  // streams are empty, so no committed chunk carries the marker, this finds
  // nothing, and the payload stays byte-identical. Guarding it on
  // `paginatePrLists` would only re-state that.
  //
  // After packing rather than inside the builder: the packer measures an empty
  // chunk (`buildChunk([])`) before it fills one, so a builder deciding
  // markedness from call order would mark the wrong part.
  markPrListContinuations(committed);
  reportUnsendableComponentUnits(
    omittedComponentUnits(session, committed),
    onUnsendableComponentUnits
  );
  return stampChunkMetadata(committed);
}

/**
 * FEA-3788 (PRD-536 D3): stamp each chunk with its `{ index, total }` position so
 * the cloud can make a chunked apply repairable after a partial (half-commit)
 * sync — the events delete-replace fires only on chunk 0 of a differing
 * `dataRevision`, and the new `dataRevision` commits only on the final chunk, so
 * an interrupted sequence leaves the stored revision at its prior value and a
 * resync re-fires `shouldReplace`. A single (unchunked) result is stamped `0 of 1`
 * so the cloud path is uniform, but the identical semantics of an unstamped whole
 * session mean an older desktop build (no marker) is still handled correctly.
 *
 * Each chunk already carries the worst-case-width `CHUNK_MARKER_SIZE_RESERVE`
 * placeholder that sizing reserved (see `withChunkMarkerReserve`); this overwrites
 * it with the real `{ index, total }`, whose serialized form is never wider than
 * the reservation, so no stamped chunk can spill past `maxBytes`.
 */
function stampChunkMetadata(
  chunks: SyncedAgentSession[]
): SyncedAgentSession[] {
  const total = chunks.length;
  return chunks.map((chunk, index) => ({
    ...chunk,
    chunk: { index, total },
  }));
}

/**
 * ISS-4578 (P1 #1): a copy of `session` with the activity tiling OMITTED (key
 * absent, not `[]`). Used by the bounded old-server fallback so the rest of the
 * session can sync while an oversized tiling defers — an absent
 * `activitySegmentRows` is the cloud's "leave the stored tiling untouched" no-op
 * signal, so nothing already stored is cleared.
 */
function sessionWithoutTiling(session: SyncedAgentSession): SyncedAgentSession {
  const { activitySegmentRows: _omittedTiling, ...rest } = session;
  // ISS-7265: stamp the strip on the payload itself rather than tracking it in a
  // parallel field. An absent `activitySegmentRows` is also what a session with
  // no tiling sends, so without this the degraded payload and a complete one are
  // the same bytes. `chunkOversizedSession`'s `baseFor` spreads the session into
  // every chunk, so the flag rides the fallback-chunked shape too.
  return { ...rest, activitySegmentRowsStripped: true };
}

/**
 * ISS-6884: does this session declare more component usage rows than ONE payload
 * may carry? The cloud wire schema `.max()`es `components` at
 * `MAX_SYNCED_COMPONENT_USAGE` and rejects the whole batch on overflow, so such a
 * session must be paginated rather than shipped (or truncated) whole.
 */
function exceedsComponentUsagePayloadCap(session: SyncedAgentSession): boolean {
  return (session.components?.length ?? 0) > MAX_SYNCED_COMPONENT_USAGE;
}

/**
 * ISS-6884: the bounded-prefix retry, or null to keep the paginated parts.
 *
 * Returns a re-split of `session` against the pre-ISS-6884 bounded prefix when
 * the paginated pass delivered FEWER rows than that prefix would have. It cannot
 * recurse twice: the bounded set is at or below the payload cap, so
 * `paginateComponents` is false on the retry. An EMPTY retry means the
 * replicated prefix no longer leaves room for the required streams — null then,
 * so the caller keeps the parts already built rather than dead-lettering a
 * session that was about to ship.
 *
 * `units` MUST be the WIRE-identity groups, not the fold-family pagination
 * units, because this measures parity against what the pre-ISS-6884 reader would
 * have shipped and that reader grouped on `(componentKind, componentKey)` alone
 * (ISS-6884, codex review). Measured against the fold-family units the guard has
 * a blind spot exactly where it is needed: a genuine `/deploy` command and a
 * `deploy` skill of 300 branch rows each are ONE 600-row fold unit, which no
 * part can carry, so pagination drops all 600 — while the baseline built from
 * those same fused units is also empty, the guard sees 0 >= 0 and stays silent,
 * and the session ships with NO usage where the old cap shipped 300.
 */
function boundedComponentUsageRetry(
  session: SyncedAgentSession,
  units: readonly SyncedComponentUsage[][],
  deliveredRows: number,
  limits: {
    activityChunkingSupported: boolean;
    maxBytes: number;
    maxDecompressedBytes: number;
    prRefChunkingSupported: boolean;
    sizer: SyncPayloadSizer;
  }
): SyncedAgentSession[] | null {
  const boundedSession = sessionWithBoundedComponentUsage(session, units);
  if (deliveredRows >= (boundedSession.components?.length ?? 0)) {
    return null;
  }
  const boundedChunks = chunkOversizedSession(
    boundedSession,
    limits.maxBytes,
    limits.sizer,
    limits.maxDecompressedBytes,
    limits.activityChunkingSupported,
    undefined,
    limits.prRefChunkingSupported
  );
  return boundedChunks.length > 0 ? boundedChunks : null;
}

/** Total component-usage rows the chunks from `from` onward carry. */
function componentRowsIn(
  chunks: readonly SyncedAgentSession[],
  from: number
): number {
  let rows = 0;
  for (let index = from; index < chunks.length; index++) {
    rows += chunks[index].components?.length ?? 0;
  }
  return rows;
}

/**
 * ISS-6884 last resort: `session` with `components` reduced to the whole
 * (kind,key) groups ONE payload can carry — the pre-ISS-6884 bounded prefix.
 * Used only when the chunk budget left the paginated stream no part at all, so
 * that removing the permanent truncation can never deliver less than it did.
 *
 * A group that does not fit is SKIPPED rather than ending the scan, matching
 * the reader's own whole-group packing: breaking would permanently starve every
 * group ordered after the first over-budget one. The key is OMITTED (not `[]`)
 * when nothing fits, because an absent `components` is the cloud's "leave the
 * stored usage untouched" no-op and ships no useless key.
 */
function sessionWithBoundedComponentUsage(
  session: SyncedAgentSession,
  groups: readonly SyncedComponentUsage[][]
): SyncedAgentSession {
  const bounded: SyncedComponentUsage[] = [];
  for (const group of groups) {
    if (bounded.length + group.length <= MAX_SYNCED_COMPONENT_USAGE) {
      bounded.push(...group);
    }
  }
  if (bounded.length === 0) {
    const { components: _dropped, ...rest } = session;
    return rest;
  }
  return { ...session, components: bounded };
}

/**
 * ISS-7265: which of these wire sessions left without their tiling, named by the
 * `externalSessionId` the queue and the server's ack echo both speak — so a
 * consumer can intersect the strip against the ids that were actually
 * CONFIRMED, rather than against the ids that merely departed.
 *
 * Reads the flag off the payload that will actually be sent, so a caller cannot
 * report a set that disagrees with the bytes it is describing.
 */
export function tilingStrippedSessionIds(
  sessions: readonly SyncedAgentSession[]
): string[] {
  return sessions
    .filter((session) => session.activitySegmentRowsStripped === true)
    .map((session) => session.externalSessionId);
}

/**
 * ISS-6999: component-usage units one prepare skipped, and the wire rows they
 * carried.
 *
 * Both numbers, because neither derives the other: `units` is how many
 * `(kind,key)` fold families will never sync, `rows` is how much usage detail
 * that cost. A fused command/skill unit can exceed the cap while every wire
 * group inside it fits, which is why the reader's bounded prefix never sees it.
 */
export type UnsendableComponentUnits = {
  units: number;
  rows: number;
};

/**
 * ISS-6999: the component-usage units `session` declared that `chunks` do not
 * carry, counted off the bytes that actually ship.
 *
 * Used for the bounded-prefix retry, whose partition is whole WIRE groups rather
 * than fold families — so the fold-family tally cannot describe it. Comparing
 * the delivered rows against the session's own set is partition-independent and
 * cannot drift from whichever packer produced the chunks.
 */
function omittedComponentUnits(
  session: SyncedAgentSession,
  chunks: readonly SyncedAgentSession[]
): UnsendableComponentUnits {
  const declared = groupComponentUsageByComponent(
    session.components,
    componentUsageWireKey
  );
  const deliveredKeys = new Set<string>();
  for (const chunk of chunks) {
    for (const usage of chunk.components ?? []) {
      deliveredKeys.add(componentUsageWireKey(usage));
    }
  }
  const omitted: UnsendableComponentUnits = { units: 0, rows: 0 };
  for (const unit of declared) {
    if (deliveredKeys.has(componentUsageWireKey(unit[0]))) {
      continue;
    }
    omitted.units += 1;
    omitted.rows += unit.length;
  }
  return omitted;
}

/**
 * ISS-6999: hand a skip to the caller's sink, or say nothing at all. The zero
 * guard lives HERE so the branch deciding whether a drop is reportable exists
 * exactly once.
 */
function reportUnsendableComponentUnits(
  units: UnsendableComponentUnits,
  report: ((units: UnsendableComponentUnits) => void) | undefined
): void {
  if (units.units > 0) {
    report?.(units);
  }
}

/**
 * ISS-6999: stamp a skip onto the payload that carries it, or leave the payload
 * exactly as it was.
 *
 * OMISSION IS THE CONTRACT: a `{ units: 0, rows: 0 }` on every healthy prepare
 * would make the field unreadable as the exception it is. `undefined` is also
 * what an older build that never measured sends, and both correctly emit
 * nothing. The `> 0` decision is not re-made here —
 * {@link reportUnsendableComponentUnits} owns it.
 */
function withUnsendableComponentUnits(
  payload: PreparedAgentSessionPayload,
  units: UnsendableComponentUnits | undefined
): PreparedAgentSessionPayload {
  if (!units) {
    return payload;
  }
  return { ...payload, unsendableComponentUnits: units };
}

const MonitoredActivityStreamOutcome = {
  Shipped: "shipped",
  NothingShipped: "nothing_shipped",
} as const;
type MonitoredActivityStreamOutcome =
  (typeof MonitoredActivityStreamOutcome)[keyof typeof MonitoredActivityStreamOutcome];

/**
 * ISS-9860: pack the monitored pages and account for what did not fit. A tail
 * left behind stamps the pages that did ship `Partial`. `NothingShipped` is the
 * one case with no carrier left to carry that stamp — no page fit the cap or
 * the chunk budget was already spent by the required streams — and the caller
 * falls back to replicating the carriers rather than dropping them silently.
 */
function appendMonitoredActivityStream(
  chunks: SyncedAgentSession[],
  items: readonly MonitoredActivityPageItem[],
  limits: {
    buildPage: (page: MonitoredActivityPageItem[]) => SyncedAgentSession;
    maxBytes: number;
    sizer: SyncPayloadSizer;
    maxDecompressedBytes: number;
  }
): MonitoredActivityStreamOutcome {
  const chunksBeforePages = chunks.length;
  const shipped = appendMonitoredActivityPages(
    chunks,
    items,
    limits.buildPage,
    (chunk) =>
      estimateSessionPayloadBytes(chunk, limits.sizer) <= limits.maxBytes &&
      withinDecompressedCeiling(
        chunk,
        limits.sizer,
        limits.maxDecompressedBytes
      ),
    MAX_SESSION_SYNC_CHUNKS
  );
  if (shipped === 0) {
    return MonitoredActivityStreamOutcome.NothingShipped;
  }
  if (shipped < items.length) {
    markMonitoredActivityPagesPartial(chunks, chunksBeforePages);
  }
  return MonitoredActivityStreamOutcome.Shipped;
}
