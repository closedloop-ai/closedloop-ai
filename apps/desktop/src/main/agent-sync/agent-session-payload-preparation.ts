import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { MetadataContentPolicy } from "@repo/lib/agent-sessions/metadata-preview";
import { dataSyncLevelToMetadataContentPolicy } from "../../shared/data-sync-level.js";
import {
  DesktopSyncBatchOutcome,
  type SessionSyncBatchEvent,
} from "../telemetry/app-otel-runtime.js";
import { reportCollectorRecordsDropped } from "../telemetry/collector-records-dropped-telemetry.js";
import { CollectorRecordsDroppedReason } from "../telemetry/telemetry-protocol.js";
import {
  type AgentSessionSyncCapabilities,
  NO_AGENT_SESSION_SYNC_CAPABILITIES,
} from "./agent-session-sync-capabilities.js";
import { syncPayloadSizerFor } from "./agent-session-sync-compression.js";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";
import {
  type AgentSessionPayloadPreparer,
  type PreparedAgentSessionPayload,
  prepareAgentSessionPayload,
  type UnsendableComponentUnits,
} from "./agent-session-sync-payload.js";
import type { AgentSessionSyncSource } from "./agent-session-sync-source.js";
import { readLocallyOversizedSessions } from "./sync-source-reply-boundary.js";

/**
 * FEA-4014: outcome of preparing a candidate batch with per-session failure
 * isolation.
 *
 * `prepared` holds every payload that serialized successfully (batched or,
 * after a batch-level failure, per-session). `failures` holds ONLY the sessions
 * whose own preparation failed — so the caller charges its bounded
 * transport-error / dead-letter budget against the actual offender(s), never a
 * healthy sibling that happened to ride in the same batch.
 */
export type IsolatedPreparationResult = {
  prepared: PreparedAgentSessionPayload[];
  failures: PreparedSessionFailure[];
};

export type PreparedSessionFailure = {
  session: SyncedAgentSession;
  error: unknown;
};

/**
 * The default, in-process payload preparer: serialize each candidate on the
 * calling thread.
 *
 * The production lane injects a worker-backed preparer instead
 * (`agent-session-sync-payload-worker-runner.ts`); this is the fallback the sync
 * service constructs when none is supplied, and what most tests exercise.
 *
 * It lives here rather than inline in `agent-session-sync-service.ts` because
 * that file is on the `noExcessiveLinesPerFile` grandfather list, which is
 * SHRINK-ONLY — an inline arrow that grows by a parameter makes a required gate
 * red. Every argument it forwards is also a capability the server negotiated, so
 * forgetting one silently disables a whole feature for the in-process path:
 * `prRefChunkingSupported` (ISS-9859) is the seventh, and without it a session
 * would never paginate its `prRefs` or `prs` however the server answered.
 */
export const inProcessAgentSessionPayloadPreparer: AgentSessionPayloadPreparer =
  (
    sessions,
    maxBytes,
    compress,
    activityChunkingSupported,
    policy,
    prRefChunkingSupported
  ) => {
    const sizer = syncPayloadSizerFor(compress === true);
    return Promise.resolve(
      sessions.map((session) =>
        prepareAgentSessionPayload(
          session,
          maxBytes,
          sizer,
          undefined,
          activityChunkingSupported === true,
          policy,
          prRefChunkingSupported === true
        )
      )
    );
  };

/**
 * FEA-4014: prepare a candidate batch, isolating any single failing session.
 *
 * The payload worker serializes the whole candidate batch in one round-trip, so
 * a single pathological session that hangs (worker timeout), errors, or throws
 * during serialization rejects the ENTIRE batch. The old call site charged that
 * one rejection against every candidate id — up to 3 backfill or 10 incremental
 * sessions — so one offender could dead-letter its healthy neighbors after the
 * consecutive-error budget.
 *
 * This prepares the batch as a whole first (the fast, common path). Only when
 * that rejects does it fall back to preparing each session on its own so the
 * failure is attributed to the exact session(s) that fail; the survivors are
 * still returned for this pass. A single-candidate batch degrades to one
 * per-session attempt with no extra round-trip beyond the retry.
 */
export async function prepareCandidatePayloadsIsolated(
  preparePayloads: AgentSessionPayloadPreparer,
  candidateSessions: SyncedAgentSession[],
  maxBytes: number,
  // FEA-4138: size the cap/chunk decision against gzip bytes when the server
  // negotiated decompression. Optional + additive; omitted keeps raw-JSON prep.
  compress = false,
  // The tick's capability snapshot. ISS-4541 `activityChunking` paginates an
  // oversized session's activity-segment tiling across chunks; ISS-9859
  // `prRefChunking` paginates `prRefs` and `prs` when they are why the
  // replicated split fails; ISS-12552 `tokenEventOwner` keeps token-event
  // owners. Omitted, each keeps the older server's shape.
  capabilities: PreparationCapabilities = NO_AGENT_SESSION_SYNC_CAPABILITIES,
  // ISS-7775: this machine's reconciled data-sync level, which decides what the
  // producer may keep inside `metadata`. The level → policy mapping happens HERE
  // rather than at the call site so there is exactly one of it, and `undefined`
  // (no level wired) is forwarded as `undefined` rather than substituted with a
  // default — the producer resolves an unstated policy to the WITHHOLDING one,
  // and a default invented here could only widen that.
  dataSyncLevel?: DataSyncLevel
): Promise<IsolatedPreparationResult> {
  return await prepareIsolated(
    preparePayloads,
    withTokenEventOwnersFor(candidateSessions, capabilities.tokenEventOwner),
    maxBytes,
    compress,
    capabilities.activityChunking,
    dataSyncLevel && dataSyncLevelToMetadataContentPolicy(dataSyncLevel),
    capabilities.prRefChunking
  );
}

async function prepareIsolated(
  preparePayloads: AgentSessionPayloadPreparer,
  candidateSessions: SyncedAgentSession[],
  maxBytes: number,
  compress: boolean,
  activityChunkingSupported: boolean,
  contentPolicy: MetadataContentPolicy | undefined,
  prRefChunkingSupported: boolean
): Promise<IsolatedPreparationResult> {
  try {
    const prepared = await preparePayloads(
      candidateSessions,
      maxBytes,
      compress,
      activityChunkingSupported,
      contentPolicy,
      prRefChunkingSupported
    );
    return { prepared, failures: [] };
  } catch (batchError) {
    // A single-session batch has no sibling to protect: the batch failure IS the
    // per-session failure, so re-attributing it without a redundant retry.
    if (candidateSessions.length <= 1) {
      return {
        prepared: [],
        failures: candidateSessions.map((session) => ({
          session,
          error: batchError,
        })),
      };
    }
    return await prepareEachSession(
      preparePayloads,
      candidateSessions,
      maxBytes,
      compress,
      activityChunkingSupported,
      contentPolicy,
      prRefChunkingSupported
    );
  }
}

async function prepareEachSession(
  preparePayloads: AgentSessionPayloadPreparer,
  candidateSessions: SyncedAgentSession[],
  maxBytes: number,
  compress: boolean,
  activityChunkingSupported: boolean,
  contentPolicy: MetadataContentPolicy | undefined,
  prRefChunkingSupported: boolean
): Promise<IsolatedPreparationResult> {
  const prepared: PreparedAgentSessionPayload[] = [];
  const failures: PreparedSessionFailure[] = [];
  for (const session of candidateSessions) {
    try {
      const sessionPayloads = await preparePayloads(
        [session],
        maxBytes,
        compress,
        activityChunkingSupported,
        contentPolicy,
        prRefChunkingSupported
      );
      prepared.push(...sessionPayloads);
    } catch (sessionError) {
      failures.push({ session, error: sessionError });
    }
  }
  return { prepared, failures };
}

/**
 * FEA-4014: dependencies the service injects so the failure handler can charge
 * its bounded transport-error / dead-letter budget and emit batch telemetry
 * without pulling all of that private state into this module.
 */
export type PreparationFailureDeps = {
  // Charges one session's transport-error budget; returns whether it was
  // dead-lettered on this attempt.
  chargeTransportError: (sessionId: string, error: unknown) => boolean;
  emitBatchTelemetry: (event: SessionSyncBatchEvent) => void;
};

/**
 * FEA-4014: charge the bounded transport-error / dead-letter budget for the
 * sessions whose payload preparation actually failed, then emit one batch
 * outcome so the dashboard counts the failed/dead-lettered batch (the caller's
 * outer catch only logs). Each failing session is classified by ITS OWN error,
 * so a deterministic local serialization bug dead-letters immediately while a
 * transient worker hang gets the consecutive-error budget — and only the
 * offender's budget is spent, never a healthy sibling that shared the batch.
 */
export function handlePreparationFailures(
  deps: PreparationFailureDeps,
  failures: PreparedSessionFailure[],
  prepStartedMs: number
): void {
  let anyDeadLettered = false;
  for (const failure of failures) {
    const deadLettered = deps.chargeTransportError(
      failure.session.externalSessionId,
      failure.error
    );
    anyDeadLettered ||= deadLettered;
  }
  deps.emitBatchTelemetry({
    outcome: anyDeadLettered
      ? DesktopSyncBatchOutcome.DeadLetter
      : DesktopSyncBatchOutcome.Failure,
    payloadBytes: 0,
    latencyMs: Math.max(0, Date.now() - prepStartedMs),
    reason: SyncReason.TransportError,
  });
}

/**
 * Drop candidates whose SLIM (post-sanitize) payload still can't fit the sync
 * cap; those genuinely can't be synced and are dead-lettered. FEA-2718 removed
 * the separate raw-event-`data` "unhydratable" gate: now that the sync path
 * hydrates with `omitEventData` (never loading event `data`), a session with
 * large local event data but small metadata no longer risks a hydration crash
 * and must NOT be skipped — its slim metadata syncs fine.
 *
 * FEA-4152: the prefilter uses the FIXED 256 KiB identity cap
 * (`contentByteCap` = `SESSION_PAYLOAD_CONTENT_BYTE_CAP`), which is only a
 * valid pre-hydrate oversize proof on the UNCOMPRESSED path. When gzip is
 * negotiated the wire cap bounds COMPRESSED bytes, and a session whose raw
 * base row exceeds 256 KiB routinely gzips well under it — so applying the
 * identity prefilter would dead-letter a session that the gzip path syncs
 * fine, and it would never reach that path. Bypass the prefilter entirely
 * under gzip: the real gzip sizer + chunker (compression-aware since Fix 1)
 * bounds both the compressed wire cap and the decompressed ceiling after
 * hydration, and a genuinely un-shippable session still dead-letters there
 * (bounded), so skipping the cheap pre-hydrate proof only costs one hydrate
 * for the rare large-but-compressible session it used to wrongly reject.
 *
 * Extracted from the grandfathered sync service (goal stage 2); the service
 * wires `deadLetterOversized` to `deadLetterOversizedLocalSession` in
 * `agent-session-sync-dispositions.ts`, so the oversize drop shares the same
 * queue/telemetry/cursor collaborator as every other pre-send disposition.
 */
export async function selectHydratableCandidateIds(
  source: AgentSessionSyncSource,
  candidateIds: string[],
  compress: boolean,
  deps: {
    contentByteCap: number;
    deadLetterOversized: (id: string, payloadBytes: number) => void;
  }
): Promise<string[]> {
  if (compress) {
    return candidateIds;
  }
  // ISS-8135: the delegate-absence test is a separate statement from the reply
  // validation, and deliberately so. The `?? []` it replaces conflated "this
  // source predates the proof" with "the peer answered something this build
  // cannot read" — the first is a legacy source behaving as designed, the second
  // is a version-skew fault worth counting, and only the second may be reported.
  if (!source.findLocallyOversizedSessions) {
    return candidateIds;
  }
  const oversizedRows = readLocallyOversizedSessions(
    await source.findLocallyOversizedSessions(
      candidateIds,
      deps.contentByteCap
    ),
    deps.contentByteCap
  );
  if (oversizedRows.length === 0) {
    return candidateIds;
  }

  const oversizedById = new Map(
    oversizedRows.map((row) => [row.id, row.payloadBytes])
  );
  const hydratableIds: string[] = [];
  for (const id of candidateIds) {
    const payloadBytes = oversizedById.get(id);
    if (payloadBytes === undefined) {
      hydratableIds.push(id);
      continue;
    }
    if (hydratableIds.length > 0) {
      break;
    }
    deps.deadLetterOversized(id, payloadBytes);
  }
  return hydratableIds;
}

/**
 * ISS-6999: route the component-usage rows a delivery shipped without to the
 * `collector.records_dropped` event.
 *
 * The loss is PERMANENT rather than deferred — the usage read is deterministic
 * and `agent_component_session_usage` carries no sync cursor — so a session that
 * ships without those rows is otherwise indistinguishable from one that never
 * had them.
 *
 * ROWS, not units, is the count: the event names the records that will not sync.
 * A pass that skipped nothing emits nothing rather than a reassuring `0`.
 *
 * CALLED ONLY FROM A PROVEN DELIVERY (whitlockk, cid 3846110703; codex, cid
 * 3846063729). Preparing a payload, and even folding it into a batch, proves
 * nothing: three separate `return`s (empty batch, stale source, capability
 * downgrade) and a throwing `sendBatch` sit between the fold and the wire, and
 * every one of them leaves the outbox queued for a re-prepare that would report
 * the same rows again. The caller is therefore the accepted-ack delivery path,
 * gated on the FINAL chunk and counted over the ids the SERVER confirmed.
 */
export function reportUnsendableComponentUsage(
  units: UnsendableComponentUnits | undefined
): void {
  reportCollectorRecordsDropped({
    reason: CollectorRecordsDroppedReason.ComponentUsagePayloadBudget,
    count: units?.rows ?? 0,
  });
}

export type PreparationCapabilities = Pick<
  AgentSessionSyncCapabilities,
  "activityChunking" | "prRefChunking" | "tokenEventOwner"
>;

/**
 * ISS-12552: a token event's owner (`agentExternalId`) and the session's
 * operation evidence go only when the attempt's snapshot says owners are sent:
 * the server accepts them and the attribution parse policy is on (PRD-800
 * "Rollout"). An older server rejects an owner differing from the one it
 * stored, and every event it holds was stored without one, so a resync would
 * fail the whole batch; it also drops evidence it does not keep. With the
 * policy off neither goes, including evidence still stored from an on period
 * that no rebuild has cleared yet.
 */
export function withTokenEventOwnersFor(
  sessions: SyncedAgentSession[],
  ownersAccepted: boolean
): SyncedAgentSession[] {
  if (ownersAccepted) {
    return sessions;
  }
  return sessions.map((session) => {
    const { operationEvidence: _evidence, ...withoutEvidence } = session;
    return session.tokenEvents?.some(
      (event) => event.agentExternalId !== undefined
    )
      ? {
          ...withoutEvidence,
          tokenEvents: session.tokenEvents.map(
            ({ agentExternalId: _owner, ...event }) => event
          ),
        }
      : withoutEvidence;
  });
}
