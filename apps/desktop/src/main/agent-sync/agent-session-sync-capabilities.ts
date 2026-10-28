import type { ComputeTargetServerCapabilities } from "@repo/api/src/types/compute-target";
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { attributionOwnersDerived } from "../parse-policy/attribution-owners-derived.js";
import { effectiveParsePolicy } from "../parse-policy/effective-parse-policy.js";
import type { AgentSessionSyncServiceOptions } from "./agent-session-sync-service-options.js";
import {
  buildAgentSessionSyncSourceKey,
  type SyncContractCapabilities,
} from "./agent-session-sync-source.js";
import type { SessionSyncIdentityAdapter } from "./retained-compute-target-identity.js";

export type AgentSessionSyncCapabilities = {
  compression: boolean;
  activityChunking: boolean;
  /**
   * ISS-9859: the connected server MERGES a part marked `prRefsPaginated: true`
   * into the session's stored PR links and `pullRequests` blob; retraction
   * happens on the sequence's first PR-list part, marked `false`, which takes
   * the ordinary replace path even at a freshness tie. Read by the payload builder: only under this capability may `prRefs`
   * and `prs` be split across parts, because an older server REPLACES both with
   * whatever slice each part carries.
   */
  prRefChunking: boolean;
  monitoredActivity: boolean;
  /**
   * ISS-5850: the connected server stores `SessionSpan.startMs`/`endMs` rather
   * than stripping them. Read by the cursor stamp, NOT by the payload builder —
   * the pair is emitted unconditionally because it is additive and an older
   * server drops it harmlessly. See `agentSessionSyncSpanExtent`.
   */
  spanExtent: boolean;
  /**
   * ISS-7896: the connected server preserves `metadata.humanTurnTimestamps`
   * whole rather than capping it at the generic 100-item array bound. Read by
   * the cursor stamp, NOT by the payload builder — the key is emitted
   * unconditionally because an older server stores a capped copy rather than
   * rejecting the batch. See `agentSessionSyncHumanTurnTimestamps`.
   */
  humanTurnTimestamps: boolean;
  /**
   * ISS-9864: the connected server preserves `metadata.agentTurnTimestamps`
   * whole and its heatmap reads it. Same contract as `humanTurnTimestamps`:
   * read by the cursor stamp, not by the payload builder.
   */
  agentTurnTimestamps: boolean;
  /**
   * ISS-12552: the connected server accepts a token event's `agentExternalId`.
   * Read by payload preparation: owners are stripped without it, because an
   * older server rejects an owner that differs from the one it stored.
   */
  tokenEventOwner: boolean;
};

export const NO_AGENT_SESSION_SYNC_CAPABILITIES: AgentSessionSyncCapabilities =
  {
    compression: false,
    activityChunking: false,
    prRefChunking: false,
    monitoredActivity: false,
    spanExtent: false,
    humanTurnTimestamps: false,
    agentTurnTimestamps: false,
    tokenEventOwner: false,
  };

/** Capture one immutable capability snapshot for a complete sync attempt. */
export function captureAgentSessionSyncCapabilities(
  options: AgentSessionSyncServiceOptions
): AgentSessionSyncCapabilities {
  return {
    compression: options.isSyncCompressionSupported?.() ?? false,
    activityChunking: options.isSyncActivityChunkingSupported?.() ?? false,
    prRefChunking: options.isSyncPrRefChunkingSupported?.() ?? false,
    monitoredActivity: options.isSyncMonitoredActivitySupported?.() ?? false,
    spanExtent: options.isSyncSpanExtentSupported?.() ?? false,
    humanTurnTimestamps:
      options.isSyncHumanTurnTimestampsSupported?.() ?? false,
    agentTurnTimestamps:
      options.isSyncAgentTurnTimestampsSupported?.() ?? false,
    tokenEventOwner: sendsTokenEventOwners(options),
  };
}

/** Resolve the revisioned durable cursor identity from live negotiation state. */
export function resolveAgentSessionSyncSourceKey(
  options: AgentSessionSyncServiceOptions
): string | null {
  const computeTargetId = options.getSyncComputeTargetId?.() ?? null;
  return computeTargetId
    ? buildAgentSessionSyncSourceKey(
        computeTargetId,
        captureAgentSessionSyncCapabilities(options).monitoredActivity
      )
    : null;
}

/** Normalize a hello-ack capability bag into the Desktop's live snapshot. */
export function capabilitiesFromHelloAck(
  capabilities: ComputeTargetServerCapabilities | undefined
): AgentSessionSyncCapabilities {
  return {
    compression: capabilities?.agentSessionSyncCompression === true,
    activityChunking: capabilities?.agentSessionSyncActivityChunking === true,
    prRefChunking: capabilities?.agentSessionSyncPrRefChunking === true,
    monitoredActivity: capabilities?.agentSessionSyncMonitoredActivity === true,
    spanExtent: capabilities?.agentSessionSyncSpanExtent === true,
    humanTurnTimestamps:
      capabilities?.agentSessionSyncHumanTurnTimestamps === true,
    agentTurnTimestamps:
      capabilities?.agentSessionSyncAgentTurnTimestamps === true,
    tokenEventOwner: capabilities?.agentSessionSyncTokenEventOwner === true,
  };
}

/**
 * ISS-5850: does the CONNECTED server persist `SessionSpan.startMs`/`endMs`?
 *
 * Read LIVE at each durable-cursor read and write rather than taken from a
 * tick-top snapshot, so the stamp records the contract that held when the
 * watermark was actually advanced. A batch prepared while it held and acked
 * after it stopped is refused before the send by
 * {@link resolveSyncCapabilityDowngrade}, so the two cannot disagree across a
 * single accepted batch.
 */
export function serverStoresSpanExtent(
  options: AgentSessionSyncServiceOptions
): boolean {
  return options.isSyncSpanExtentSupported?.() ?? false;
}

/**
 * ISS-7896: does the CONNECTED server store `metadata.humanTurnTimestamps`
 * whole? Read LIVE for the same reason as {@link serverStoresSpanExtent}.
 */
export function serverStoresHumanTurnTimestamps(
  options: AgentSessionSyncServiceOptions
): boolean {
  return options.isSyncHumanTurnTimestampsSupported?.() ?? false;
}

/**
 * ISS-9864: does the CONNECTED server store `metadata.agentTurnTimestamps`
 * whole? Read LIVE for the same reason as {@link serverStoresSpanExtent}.
 */
export function serverStoresAgentTurnTimestamps(
  options: AgentSessionSyncServiceOptions
): boolean {
  return options.isSyncAgentTurnTimestampsSupported?.() ?? false;
}

/**
 * The contract capabilities the durable cursor's revision stamp is resolved
 * from, read live at each cursor read and write.
 *
 * Threaded as ONE object rather than a positional boolean per capability so a
 * future rung is a new field — which every call site keeps passing untouched —
 * instead of a new argument each caller must be edited to forward. Getting that
 * forwarding wrong is not a missed replay but a full corpus re-walk on every
 * boot, because the read and write sides would resolve different revisions.
 */
export function resolveSyncContractCapabilities(
  options: AgentSessionSyncServiceOptions
): SyncContractCapabilities {
  return {
    spanExtent: serverStoresSpanExtent(options),
    humanTurnTimestamps: serverStoresHumanTurnTimestamps(options),
    agentTurnTimestamps: serverStoresAgentTurnTimestamps(options),
    tokenEventOwner: sendsTokenEventOwners(options),
  };
}

/**
 * The `isSync*Supported` accessors the sync-lane composition takes, bound to one
 * LIVE snapshot getter.
 *
 * Composed here rather than spelled out at the call site so adding a capability
 * is one edit in this module instead of an easily-forgotten line in `app.ts` —
 * and each accessor still calls `serverCaps()` per invocation, so every read
 * sees the current negotiation rather than a value captured at wiring time.
 */
export function syncCapabilityAccessors(
  serverCaps: () => AgentSessionSyncCapabilities
): {
  isSyncCompressionSupported: () => boolean;
  isSyncActivityChunkingSupported: () => boolean;
  isSyncPrRefChunkingSupported: () => boolean;
  isSyncMonitoredActivitySupported: () => boolean;
  isSyncSpanExtentSupported: () => boolean;
  isSyncHumanTurnTimestampsSupported: () => boolean;
  isSyncAgentTurnTimestampsSupported: () => boolean;
  isSyncTokenEventOwnerSupported: () => boolean;
} {
  return {
    isSyncCompressionSupported: () => serverCaps().compression,
    isSyncActivityChunkingSupported: () => serverCaps().activityChunking,
    isSyncPrRefChunkingSupported: () => serverCaps().prRefChunking,
    isSyncMonitoredActivitySupported: () => serverCaps().monitoredActivity,
    isSyncSpanExtentSupported: () => serverCaps().spanExtent,
    isSyncHumanTurnTimestampsSupported: () => serverCaps().humanTurnTimestamps,
    isSyncAgentTurnTimestampsSupported: () => serverCaps().agentTurnTimestamps,
    isSyncTokenEventOwnerSupported: () => serverCaps().tokenEventOwner,
  };
}

/** Shared capability helpers for app negotiation and sync-attempt snapshots. */
export const SessionSyncCapability = {
  capture: captureAgentSessionSyncCapabilities,
  sourceKey: resolveAgentSessionSyncSourceKey,
  spanExtent: serverStoresSpanExtent,
  humanTurnTimestamps: serverStoresHumanTurnTimestamps,
  agentTurnTimestamps: serverStoresAgentTurnTimestamps,
  contract: resolveSyncContractCapabilities,
} as const;

/**
 * Which capability a batch was built under and no longer holds, so the prepared
 * payload is shaped for a server that is gone.
 */
export const SyncCapabilityDowngrade = {
  Compression: "compression",
  ActivityChunking: "activity_chunking",
  PrRefChunking: "pr_ref_chunking",
  MonitoredActivity: "monitored_activity",
  SpanExtent: "span_extent",
  HumanTurnTimestamps: "human_turn_timestamps",
  AgentTurnTimestamps: "agent_turn_timestamps",
  TokenEventOwner: "token_event_owner",
} as const;

/** Literal union of mid-tick capability downgrades. */
export type SyncCapabilityDowngrade =
  (typeof SyncCapabilityDowngrade)[keyof typeof SyncCapabilityDowngrade];

/**
 * What a sync attempt captured at the top of its tick, before the awaits.
 *
 * ISS-10526: an ALIAS of {@link AgentSessionSyncCapabilities}, not a restatement
 * of its fields. The caller spreads its tick-top snapshot in and overrides only
 * what the tick may legitimately change (compression, which the batch sizer may
 * downgrade), and a hand-copied twin bought that spread nothing while needing
 * its own edit for every new capability.
 *
 * It does NOT make a new capability reach the freshness check: that still
 * depends on someone adding a comparison to {@link resolveSyncCapabilityDowngrade}
 * by hand. Closing that would take an exhaustive `Record` the chain is derived
 * from, which this alias deliberately does not attempt.
 */
export type CapturedSyncCapabilities = AgentSessionSyncCapabilities;

/**
 * Did the socket renegotiate away a capability this batch was already built for?
 *
 * A FRESH batch captures its capabilities at the top of the tick, then awaits
 * hydration and worker prep. If the server reconnected during those awaits the
 * prepared payload is now wrong for it, and the send must be skipped — the
 * candidates were never dequeued (only an ack advances them), so the next tick
 * re-prepares them under the capabilities that actually hold.
 *
 * FEA-4152 (compression): a gzip-sized batch stamps `Content-Encoding: gzip`, and
 * posting it to a server that no longer decompresses 400s on
 * `Invalid compressed body`.
 *
 * ISS-4578 (activity chunking): sending chunk 0 of a split tiling to an OLDER
 * server — one that REPLACE-ALLs the tiling on every chunk rather than
 * negotiating additive merge — leaves it holding a PARTIAL tiling. That is silent
 * data loss, which is why the guard exists at all.
 *
 * Monitored activity is checked for ANY CHANGE, not just a loss: it is part of the
 * durable cursor's identity (`resolveAgentSessionSyncSourceKey`), so a batch
 * prepared under one value must not be sent under the other in either direction.
 *
 * ISS-5850 (span extent): the payload is unchanged either way — the extent is
 * additive and an older server just drops it. What changes is what the ACK is
 * worth. A batch captured while the server stored the extent, then acked by one
 * that strips it, is dequeued and passes under a watermark this lane may already
 * have stamped at the extent-bearing revision, so those sessions become
 * bounds-less with nothing left to re-push them. The rows are never dequeued on
 * a skip (only an ack advances them), so deferring re-prepares them under the
 * capability that actually holds. Loss only, unlike monitored activity: gaining
 * the capability mid-tick costs nothing, because the stamp is resolved at
 * persist time and a batch sent under the older contract simply keeps the lane
 * at the older revision until a full tick runs under the new one.
 *
 * A pending-chunk drain (`isPendingChunkDrain`) is exempt across the board: its
 * encoding and tail were re-checked and pinned in `resolvePendingChunkTransition`.
 */
export function resolveSyncCapabilityDowngrade(input: {
  isPendingChunkDrain: boolean;
  captured: CapturedSyncCapabilities;
  current: AgentSessionSyncCapabilities;
}): SyncCapabilityDowngrade | null {
  const { captured, current, isPendingChunkDrain } = input;
  if (isPendingChunkDrain) {
    return null;
  }
  if (captured.compression && !current.compression) {
    return SyncCapabilityDowngrade.Compression;
  }
  if (captured.activityChunking && !current.activityChunking) {
    return SyncCapabilityDowngrade.ActivityChunking;
  }
  // ISS-9859: same hazard as the tiling. A part marked `prRefsPaginated` sent to
  // a server that no longer merges it REPLACES the session's PR links and
  // `pullRequests` blob with that part's slice, the loss this ticket removes.
  if (captured.prRefChunking && !current.prRefChunking) {
    return SyncCapabilityDowngrade.PrRefChunking;
  }
  if (captured.monitoredActivity !== current.monitoredActivity) {
    return SyncCapabilityDowngrade.MonitoredActivity;
  }
  if (captured.spanExtent && !current.spanExtent) {
    return SyncCapabilityDowngrade.SpanExtent;
  }
  if (captured.humanTurnTimestamps && !current.humanTurnTimestamps) {
    return SyncCapabilityDowngrade.HumanTurnTimestamps;
  }
  // ISS-9864: same shape as the human key — loss only, gain costs nothing.
  if (captured.agentTurnTimestamps && !current.agentTurnTimestamps) {
    return SyncCapabilityDowngrade.AgentTurnTimestamps;
  }
  // ISS-12552: a batch carrying token-event owners, sent to a server that no
  // longer accepts them, is rejected whole for every session already synced.
  if (captured.tokenEventOwner && !current.tokenEventOwner) {
    return SyncCapabilityDowngrade.TokenEventOwner;
  }
  return null;
}

/**
 * Why a prepared batch must not be sent: a capability it was shaped for, or the
 * POLICY it was sanitized under, no longer holds.
 */
export type SyncPreSendDeferral =
  | { kind: "capability"; capability: SyncCapabilityDowngrade }
  | { kind: "data-sync-level"; captured: string; current: string };

/** What a data-sync level reads as in a log line when the host wires none. */
const UNSET_DATA_SYNC_LEVEL = "unset";

/**
 * The ONE pre-send freshness gate, over both dimensions a fresh batch can go
 * stale in across its hydration and worker-prep awaits.
 *
 * `src/main/sync/AGENTS.md` states this as a recurring cross-lane failure mode —
 * "re-read capability, policy, and target after every await, immediately before
 * send" — and names mirroring the guard the lane already has for one dimension
 * across the others as the remedy. This is that mirror: ISS-7775 added the
 * POLICY dimension (`dataSyncLevel` → metadata content policy) and it is checked
 * here rather than at the call site so the two cannot drift apart, and so a
 * third dimension has one obvious place to land.
 *
 * THE LEVEL IS COMPARED FOR ANY CHANGE, not just a narrowing. It decides what
 * the sanitizer withheld AND is stamped on the envelope for the cloud to read
 * (ISS-7516), so a batch whose stated level disagrees with the machine's current
 * one misdescribes itself in either direction. A downgrade additionally means
 * turn text the user just withdrew consent for is sitting in the prepared
 * payload, which is the case that makes this a privacy guard rather than a
 * bookkeeping one.
 *
 * Deferring is safe, and that is a property of the caller: a candidate is
 * dequeued only by an ack, so returning without sending leaves the work queued
 * and the next tick re-prepares it under what actually holds.
 *
 * A pending-chunk drain is exempt here for both dimensions, as it already was
 * for capabilities — its encoding and tail were re-checked and pinned in
 * `resolvePendingChunkTransition`, which is also where its pinned LEVEL is
 * re-checked and the tail discarded on a change.
 */
export function resolvePreSendDeferral(input: {
  isPendingChunkDrain: boolean;
  captured: CapturedSyncCapabilities;
  current: AgentSessionSyncCapabilities;
  capturedDataSyncLevel: DataSyncLevel | undefined;
  currentDataSyncLevel: DataSyncLevel | undefined;
}): SyncPreSendDeferral | null {
  const capability = resolveSyncCapabilityDowngrade(input);
  if (capability) {
    return { kind: "capability", capability };
  }
  if (
    input.isPendingChunkDrain ||
    input.capturedDataSyncLevel === input.currentDataSyncLevel
  ) {
    return null;
  }
  return {
    kind: "data-sync-level",
    captured: input.capturedDataSyncLevel ?? UNSET_DATA_SYNC_LEVEL,
    current: input.currentDataSyncLevel ?? UNSET_DATA_SYNC_LEVEL,
  };
}

/**
 * ISS-12068 (Perrin Upcott ruling, 2026-10-06): the last hello-ack capabilities,
 * kept across a relay disconnect. The monitored-activity flag is part of the
 * session lane's source key, and the lane keeps syncing over HTTP under the
 * retained target while the socket is down, so dropping them on every disconnect
 * re-keyed the lane and re-walked the corpus. Only a new hello ack replaces them,
 * and they apply only while the lane's sync target is the one that ack named: a
 * target, account, or environment switch changes or nulls that target, so it
 * reads None until its own handshake. Accepted cost: a server rolled back while
 * the socket is down receives payloads shaped for the newer one until then.
 */
export function createNegotiatedSessionSyncCapabilities(
  syncTarget: Pick<SessionSyncIdentityAdapter, "computeTargetId">
): {
  recordHelloAck(
    computeTargetId: string,
    serverCapabilities: ComputeTargetServerCapabilities | undefined
  ): void;
  current(): AgentSessionSyncCapabilities;
} {
  let negotiated: {
    computeTargetId: string;
    capabilities: AgentSessionSyncCapabilities;
  } | null = null;
  return {
    recordHelloAck(computeTargetId, serverCapabilities) {
      negotiated = {
        computeTargetId,
        capabilities: capabilitiesFromHelloAck(serverCapabilities),
      };
    },
    current() {
      return negotiated !== null &&
        negotiated.computeTargetId === syncTarget.computeTargetId()
        ? negotiated.capabilities
        : NO_AGENT_SESSION_SYNC_CAPABILITIES;
    },
  };
}

/**
 * ISS-12552 (PRD-800 "Rollout"): owners (and the evidence that rides the
 * same rung) go out only to a server that accepts them AND under the
 * attribution policy. Off, every owner, the parent marker included, is
 * omitted, so an organization the flag is on for never has subagent ownership
 * overwritten by a Desktop that is still off. Both the per-attempt shaping
 * snapshot and the durable cursor's contract read it, so a Desktop that is off
 * stays on the integrity rung below the owner rung (main's, so no re-walk after
 * an upgrade), and each flip to on raises the rung once, which spends exactly
 * one owner-carrying re-walk.
 */
function sendsTokenEventOwners(
  options: AgentSessionSyncServiceOptions
): boolean {
  return (
    (options.isSyncTokenEventOwnerSupported?.() ?? false) &&
    effectiveParsePolicy().attributionEvidence &&
    attributionOwnersDerived()
  );
}
