import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import {
  type DesktopSyncBatchEventInput,
  DesktopSyncBatchOutcome,
} from "../telemetry/app-otel-runtime.js";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";
import type {
  AgentSessionPayloadPreparer,
  PreparedAgentSessionPayload,
} from "./agent-session-sync-payload.js";
import type { AgentSessionSyncSource } from "./agent-session-sync-source.js";

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
  // ISS-4541: paginate an oversized session's activity-segment tiling across
  // chunks when the server merges multi-part tilings additively. Optional +
  // additive; omitted keeps the tiling in the base payload (old behavior).
  activityChunkingSupported = false
): Promise<IsolatedPreparationResult> {
  try {
    const prepared = await preparePayloads(
      candidateSessions,
      maxBytes,
      compress,
      activityChunkingSupported
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
      activityChunkingSupported
    );
  }
}

async function prepareEachSession(
  preparePayloads: AgentSessionPayloadPreparer,
  candidateSessions: SyncedAgentSession[],
  maxBytes: number,
  compress: boolean,
  activityChunkingSupported: boolean
): Promise<IsolatedPreparationResult> {
  const prepared: PreparedAgentSessionPayload[] = [];
  const failures: PreparedSessionFailure[] = [];
  for (const session of candidateSessions) {
    try {
      const sessionPayloads = await preparePayloads(
        [session],
        maxBytes,
        compress,
        activityChunkingSupported
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
  emitBatchTelemetry: (event: DesktopSyncBatchEventInput) => void;
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
  const oversizedRows =
    (await source.findLocallyOversizedSessions?.(
      candidateIds,
      deps.contentByteCap
    )) ?? [];
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
