/**
 * @file agent-session-sync-envelope-reserve.ts
 * @description ISS-8327 — how many of a sync request's bytes the BATCH ENVELOPE
 * claims, and therefore how many are left for session content.
 *
 * The route judges the whole serialized batch against
 * `DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES`, but the chunker packs SESSIONS.
 * The two are reconciled by reserving the envelope's width up front, so a part
 * packed to fill the remaining budget still fits the cap once wrapped.
 *
 * That reserve used to be a hand-written envelope literal listing five fields,
 * and `buildAgentSessionSyncBatch` grew three more it was never taught:
 * `encoding` (FEA-4138), `wantsAcceptedSessionIds` (PR #4862) and `dataSyncLevel`
 * (ISS-7516). Measured on 2026-08-31 the literal reserved 126 bytes against a
 * 200-byte worst-case emission — a 74-byte under-reserve, so every part the
 * packer filled to that budget sat in a window where the built batch exceeded the
 * route cap. (The ticket cites 134 vs 237 / 72 bytes; the shape is identical and
 * the direction is the same, but the literals have since moved, so the numbers
 * here are the measured ones.) ISS-7775 fixed exactly one lane — the since-removed
 * trace-comment recovery push — by deriving its own budget; the session sync lane
 * kept the literal.
 *
 * That window had TWO exits, and which one a part took depended on whether its
 * lane re-measured before posting. A first chunk or a lone whole session is
 * re-measured against the cap by the accumulator, so it was DEAD-LETTERED locally
 * — a healthy session discarded, and for a chunked one its pinned remainder
 * dropped with it. A tail chunk was not: `resolvePendingChunkTransition` built
 * the batch and sent it, so it reached the wire and came back a 413 the client
 * could neither anticipate nor avoid. ISS-8710 gave that lane the same
 * re-measure, so no lane relies on this reserve to keep an over-cap batch off the
 * wire. It is
 * still what keeps a HEALTHY session away from that re-measure: packed against
 * the full cap instead, a session within one envelope of it prepares whole,
 * wraps past the cap and is dead-lettered. That is what keeps the derivation
 * below load-bearing.
 *
 * So the reserve is DERIVED from the emitted envelope: it calls the real builder
 * over the full value domain of the builder's own input and takes the worst case.
 * A new field on the OUTPUT is counted automatically because the real builder
 * emits it. A new field on the INPUT fails `tsc` here (see
 * {@link ENVELOPE_RESERVE_AXES}) until it is given a domain to be measured across.
 */

import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { DATA_SYNC_LEVELS } from "@repo/api/src/types/data-sync-level";
import {
  type AgentSessionSyncBatchInput,
  buildAgentSessionSyncBatch,
} from "./agent-session-sync-contract.js";
import { estimateAgentSessionSyncBatchBytes } from "./agent-session-sync-payload.js";

/**
 * The `batchId` every measured envelope carries. Fixed-width on purpose: every
 * producer stamps a `randomUUID()`, whose serialized width is constant, so one
 * representative value measures them all.
 */
const RESERVE_BATCH_ID = "00000000-0000-4000-8000-000000000000";

/**
 * `AgentSessionSyncBatchInput` with every key made REQUIRED, `-?` and all.
 *
 * This alias is load-bearing, not cosmetic. A plain mapped type over
 * `keyof AgentSessionSyncBatchInput` is homomorphic, so it PRESERVES the `?`
 * modifier — and an object literal annotated with a type only has to supply that
 * type's required members. Both guards below would therefore stay green for an
 * OPTIONAL new input, which is precisely the shape a new envelope field takes
 * here: `encoding`, `dataSyncLevel` and `wantsAcceptedSessionIds` are all
 * optional on the batch, and this module exists because those three were added
 * and the reserve was never taught them. Stripping the modifier makes a missing
 * key a `tsc` error whether or not the new input is optional.
 *
 * `-?` also drops `undefined` from an optional key's VALUE type, so such an
 * input's domain names only real values and is never measured absent. That is
 * the correct direction and not a gap: the builder OMITS an absent optional, so
 * present is always the wider envelope, and a worst-case reserve only needs the
 * wider one. A key declared required-but-nullable (`dataSyncLevel:
 * DataSyncLevel | undefined`) has no modifier to strip, so it keeps `undefined`
 * in its domain and is still measured both ways.
 */
type EnvelopeReserveInput = {
  [K in keyof AgentSessionSyncBatchInput]-?: AgentSessionSyncBatchInput[K];
};

/**
 * Every value each builder input can take, as a list per key.
 *
 * The `satisfies` is the guard the acceptance criteria ask for: it is a mapped
 * type over every key of {@link EnvelopeReserveInput}, so adding an input to
 * `buildAgentSessionSyncBatch` fails typecheck here until this table names the
 * values that input must be measured across. The two closed sets are read from
 * their canonical owners rather than relisted, so a new sync mode or data-sync
 * level widens the reserve with no edit at all.
 *
 * `sessions` is measured EMPTY, which makes the reserve EXACT for a ONE-session
 * batch and only that — see {@link maxSessionPayloadBytesForBatch}. `compress` is
 * measured both ways, and the `true` arm (which adds `encoding`) is the wider
 * one — deliberately reserved even on the identity path, because a raw-byte
 * over-reserve only ever leaves a batch smaller than the cap.
 */
const ENVELOPE_RESERVE_AXES = {
  batchId: [RESERVE_BATCH_ID],
  syncMode: Object.values(AgentSessionSyncMode),
  sessions: [[]],
  compress: [false, true],
  dataSyncLevel: [undefined, ...DATA_SYNC_LEVELS],
} satisfies {
  readonly [K in keyof EnvelopeReserveInput]: readonly EnvelopeReserveInput[K][];
};

/**
 * The widest envelope `buildAgentSessionSyncBatch` can emit, in serialized UTF-8
 * bytes, over every combination of its inputs.
 */
export const AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES = Math.max(
  ...agentSessionSyncBatchEnvelopeInputs().map((input) =>
    estimateAgentSessionSyncBatchBytes(buildAgentSessionSyncBatch(input))
  )
);

/**
 * How many RAW JSON bytes of a `maxBatchBytes` request ONE session's serialized
 * content may use.
 *
 * BOTH numbers are raw JSON bytes, and the unit is the contract (ISS-8710).
 * Because `sessions` is measured empty and a batch's JSON embeds each session's
 * own serialization verbatim, `raw(batch) = raw(envelope) + raw(session)`
 * exactly, so subtracting the reserve is EXACT and not a rounded-down estimate.
 * That identity is what makes this a proof, and it holds only under raw bytes:
 * gzip is not additive over concatenation, so `gzip(batch) - gzip(session)` is
 * content-dependent and is NOT this reserve. A caller that packs against this
 * budget while SIZING with `gzipSyncPayloadSizer` is therefore bounding the
 * wrong quantity, so the gzip-capable lane does not trust it: the bulk
 * accumulator and the tail-chunk drain both re-measure their BUILT batch
 * against the request cap with the tick's own sizer before posting.
 *
 * The one-session scope is the whole contract, and every caller is inside it:
 * `SESSION_PAYLOAD_CONTENT_BYTE_CAP` bounds a single hydrated session in the
 * oversize prefilter and a single chunk in the packer.
 *
 * It is deliberately NOT a per-batch budget: a K-session batch additionally
 * spends K-1 separators and any extra `sessionCount` digits, which this does not
 * reserve. Nothing needs it to — the multi-session accumulator measures the
 * BUILT batch against the request cap on every append
 * (`accumulateSessionPayload`), so it never sizes from this number.
 *
 * Floors at 0 rather than going negative: a request cap smaller than the
 * envelope leaves no content budget, which the chunker reads as "nothing fits"
 * and dead-letters loudly, where a negative budget would be an impossible size
 * every comparison silently mishandles.
 */
export function maxSessionPayloadBytesForBatch(maxBatchBytes: number): number {
  return Math.max(0, maxBatchBytes - AGENT_SESSION_SYNC_BATCH_ENVELOPE_BYTES);
}

/**
 * The cartesian product of {@link ENVELOPE_RESERVE_AXES}.
 *
 * The object literal is annotated {@link EnvelopeReserveInput}, so this is the
 * second place a newly added input fails `tsc` — the axes table above says the
 * value must EXIST, this says it must be USED.
 */
function agentSessionSyncBatchEnvelopeInputs(): EnvelopeReserveInput[] {
  const inputs: EnvelopeReserveInput[] = [];
  for (const batchId of ENVELOPE_RESERVE_AXES.batchId) {
    for (const syncMode of ENVELOPE_RESERVE_AXES.syncMode) {
      for (const sessions of ENVELOPE_RESERVE_AXES.sessions) {
        for (const compress of ENVELOPE_RESERVE_AXES.compress) {
          for (const dataSyncLevel of ENVELOPE_RESERVE_AXES.dataSyncLevel) {
            const input: EnvelopeReserveInput = {
              batchId,
              syncMode,
              sessions,
              compress,
              dataSyncLevel,
            };
            inputs.push(input);
          }
        }
      }
    }
  }
  return inputs;
}
