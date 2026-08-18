/**
 * The bounded-failure policy for the desktop session sync lane: how many
 * consecutive failures of each ack reason a single session may accumulate before
 * it is dead-lettered, how long a rejected session is deferred before its next
 * attempt, the progressive dead-letter retry ladder, and the caps that keep the
 * in-memory and PERSISTED id sets bounded.
 *
 * Every knob here is a policy decision, not mechanism — the service reads them
 * but owns none of them. Extracted verbatim from
 * `agent-session-sync-service.ts` (ISS-4676).
 */
import { exponentialBackoffMs } from "../../shared/exponential-backoff.js";
import {
  BACKFILL_SESSION_BATCH_SIZE as BACKFILL_SESSION_BATCH_SIZE_LIMIT,
  INCREMENTAL_SESSION_BATCH_SIZE as INCREMENTAL_SESSION_BATCH_SIZE_LIMIT,
  INCREMENTAL_SESSION_READY_THRESHOLD as INCREMENTAL_SESSION_READY_THRESHOLD_LIMIT,
  SESSION_PAYLOAD_BYTE_CAP as SESSION_PAYLOAD_BYTE_CAP_LIMIT,
} from "./agent-session-sync-limits.js";
import { maxSessionPayloadBytesForBatch } from "./agent-session-sync-payload.js";

export const INCREMENTAL_SESSION_BATCH_SIZE =
  INCREMENTAL_SESSION_BATCH_SIZE_LIMIT;
export const INCREMENTAL_SESSION_READY_THRESHOLD =
  INCREMENTAL_SESSION_READY_THRESHOLD_LIMIT;
export const BACKFILL_SESSION_BATCH_SIZE = BACKFILL_SESSION_BATCH_SIZE_LIMIT;
export const SESSION_PAYLOAD_BYTE_CAP = SESSION_PAYLOAD_BYTE_CAP_LIMIT;
export const SESSION_PAYLOAD_CONTENT_BYTE_CAP = maxSessionPayloadBytesForBatch(
  SESSION_PAYLOAD_BYTE_CAP
);
// After this many consecutive SERVER-ANSWERED ack timeouts (HTTP 408) on the
// same session, dead-letter it so one oversized or slow session does not
// permanently block the queue. ISS-5088 narrowed this class: the route itself
// does not emit 408 (a slow upsert surfaces as a 5xx → `ingestion_failed`), so
// in practice only an intermediary proxy/CDN produces one. A CLIENT-side abort,
// which is what the 30s local deadline actually produces, is now
// `transport_timeout` on its own budget below.
export const MAX_CONSECUTIVE_TIMEOUTS = 3;
// FEA-1461: after this many consecutive `rate_limited` rejections on the same
// session, dead-letter it. Higher than the timeout threshold because
// rate-limits are more legitimately transient (the relay may genuinely just
// be throttling a burst), but still bounded so a persistently-rejected
// session cannot infinite-loop the sync queue + log spam.
export const MAX_CONSECUTIVE_RATE_LIMITED = 5;
// Server-side ingestion failures are payload rejections too. Keep them bounded
// so one bad batch cannot retry forever.
export const MAX_CONSECUTIVE_INGESTION_FAILED = 5;
// FEA-3364: a THROWN sendBatch (dropped socket, serialization failure) is a
// batch failure that — unlike an ack rejection — used to increment no counter:
// the batch stayed queued at retry-count 0 and re-sent every 5s forever. Bound
// consecutive transient socket throws on the same session so a persistently
// unreachable/unencodable batch is eventually dead-lettered instead of looping.
// A LOCAL serialization/prep throw is not counted against this budget — it is a
// deterministic local bug (the identical payload re-throws every retry) and is
// dead-lettered immediately (see isLocalSerializationError / handleTransportError).
export const MAX_CONSECUTIVE_TRANSPORT_ERRORS = 5;
// ISS-5088: a CLIENT-side request abort (`transport_timeout`) — the local 30s
// deadline fired and the server never answered. It still gets a bounded budget
// so a session that is genuinely unsendable within the deadline on an otherwise
// healthy lane reaches a terminal path (`main/sync/AGENTS.md` invariant 5), but
// the budget is generous AND refundable: `refundTransportTimeoutBudgets()` drops
// every accumulated charge the moment the lane observes unambiguous connectivity
// loss, because that proves the window was lane-wide rather than payload-
// attributable (invariant 4 — a lane-wide failure must never burn a row's retry
// budget). Sized above `MAX_CONSECUTIVE_TIMEOUTS` for the same reason
// `MAX_CONSECUTIVE_RATE_LIMITED` is: the cause is far more likely external.
export const MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS = 5;
// FEA-1461: after a `rate_limited` rejection, defer re-attempting the same
// session for this long. Prevents the 5-second sync tick from re-chunking and
// re-sending the same oversized session every cycle (the original symptom).
// Other queued sessions continue to flow through `pickReadyCandidates`.
export const RATE_LIMIT_BACKOFF_MS = 30_000;
export const INGESTION_FAILED_BACKOFF_MS = RATE_LIMIT_BACKOFF_MS;
// ISS-5088: after a client-side abort (`transport_timeout`), defer the same
// session rather than re-attempting on the very next 5s tick. A stalled
// transport does not clear in milliseconds, and an immediate re-send re-pays the
// full prepare + serialize cost into the same stall — which is itself part of
// the main-process contention those windows show.
export const TRANSPORT_TIMEOUT_BACKOFF_MS = RATE_LIMIT_BACKOFF_MS;
// FEA-3366: after this many consecutive `validation_failed` rejections on the
// same session, dead-letter it. Kept small (below the rate-limit and ingestion
// budgets) because a schema rejection is more likely deterministic than a
// transient throttle — but a nonzero budget lets a session survive a transient
// server-side validation blip (e.g. a schema-deploy race) or a payload re-fetch
// that clears the rejection, instead of being dead-lettered on the very first
// failure. Each retry re-fetches + re-sanitizes the source session (the prior
// attempt's chunks are discarded), so a fix that lands between attempts takes.
// The final drop is still durable and version-fix recoverable: a later app
// version that fixes a local sanitization bug re-discovers the session via the
// persisted dead-letter set on restart.
export const MAX_CONSECUTIVE_VALIDATION_FAILED = 3;
// ISS-5090: how many times an id may be dead-lettered RECOVERABLY for a
// multi-part (chunk-envelope) validation rejection before the class becomes
// terminal like a whole-session rejection. The envelope class exists because a
// chunk part's rejection is not reproducible from the persisted row — the
// partition varies with the negotiated byte cap, the encoding, the
// activity-chunking capability, and the source stream sizes at prepare time, and
// production proved it: one ended session was rejected six times as three parts,
// dead-lettered, and then accepted in full hours later as FOUR parts. But
// "re-drivable" must not mean "forever": each recovery resets the per-attempt
// budget, so without this second-order bound a genuinely-invalid oversized row
// would re-send every 24h for the life of the process, which is the unbounded
// retry invariant 5 forbids. Three cycles comfortably covers the observed case
// (which recovered on the very next re-drive) and then stops.
export const MAX_CHUNK_ENVELOPE_DEAD_LETTERS = 3;
// FEA-3366: after a `validation_failed` rejection, defer re-attempting the same
// session for this long. Prevents the 5-second sync tick from re-fetching,
// re-sanitizing, and re-sending the same rejected session every cycle (the
// permanent-stall symptom FEA-1962 originally guarded against by dropping
// immediately) while still giving the small retry budget above a real chance to
// clear a transient rejection. Other queued sessions keep flowing through
// `pickReadyCandidates`.
export const VALIDATION_FAILED_BACKOFF_MS = RATE_LIMIT_BACKOFF_MS;
// FEA-3425: after an `unauthenticated` rejection from the HTTP transport (no
// session token, or the server answered 401), defer re-attempting the deferred
// sessions for this long. Auth loss is NEVER a payload problem, so — unlike
// every budgeted reason above — an unauthenticated defer touches no failure
// counter and can never dead-letter: the batch waits, budgets intact, until the
// session refreshes (the auth-state listener nudges `refresh()`). Since Phase 4a
// there is no socket write path to fall back to — HTTP is the only transport.
export const UNAUTHENTICATED_BACKOFF_MS = RATE_LIMIT_BACKOFF_MS;
// FEA-3425: after a `target_not_owned` rejection (the HTTP route's coded 403 —
// the sent computeTargetId failed the server's ownership check), defer for this
// long WITHOUT burning any budget. Waiting cannot fix a wrong id and
// dead-lettering would strand perfectly good sessions, so the lane defers,
// warns loudly, and waits for identity to re-resolve via the normal
// hello/refresh path (the cursor is target-scoped, so a corrected id re-scopes
// the lane wholesale).
export const TARGET_NOT_OWNED_BACKOFF_MS = RATE_LIMIT_BACKOFF_MS;
// ISS-6031: after `loadSyncedSessions` returns nothing for ids whose absence
// from `sessions` could NOT be confirmed, defer re-attempting them for this long
// WITHOUT burning any budget.
//
// This is deliberately a defer with no dead-letter ladder behind it. The other
// no-budget-burn classes (`unauthenticated`, `target_not_owned`) wait on an
// external precondition; this one waits on a LOCAL read that returned nothing
// for a row the store still has. Attaching a bounded budget to it would end in
// the same permanent dispose the empty-read inference already caused, on a
// longer timer — the row exists locally, so retrying is always the correct
// answer and destroying it never is. The stall it can produce (a queue that
// never drains, so the cursor is not persisted and the next cold start
// re-walks) is a cost paid in work, not in data.
export const UNCONFIRMED_ABSENCE_BACKOFF_MS = RATE_LIMIT_BACKOFF_MS;
// FEA-3363: after a session is dead-lettered it is dropped from the queues and,
// until now, only ever retried on a cold-restart re-backfill — which may never
// happen on a long-running desktop (observed: 52 sessions stranded live). Give
// every dead-lettered id a durable retry-after deadline so a live recovery pass
// re-enqueues it (with a reset failure counter) once this window elapses,
// guaranteeing an eventual path to the cloud regardless of restart.
//
// FEA-3795 (PRD-536 E2): the retry window is PROGRESSIVE, not a flat 24h. A flat
// window over-penalizes a transient relay-congestion strand (e.g. a brief spike
// of ack-timeouts): a session that would recover in minutes was held for a full
// day, and while dead-lettered it de-prioritizes forward progress. Instead the
// window starts short (`DEAD_LETTER_RETRY_BASE_MS`) and doubles on each
// successive dead-letter of the SAME id, capped at `DEAD_LETTER_RETRY_MAX_MS`
// (the prior 24h). So a one-off transient failure recovers fast, while an id
// that keeps re-tripping the same failure escalates toward the long window and
// stops hammering the retry path. The escalation counter survives in-process
// recovery (only a verified ack resets it); it is scoped to a running process
// and re-derives from the base on a cold restart, while FEA-3697's durable
// outbox recovery still guarantees every dead-letter an eventual path to the
// cloud across restart.
export const DEAD_LETTER_RETRY_BASE_MS = 5 * 60 * 1000; // 5 min
export const DEAD_LETTER_RETRY_MAX_MS = 24 * 60 * 60 * 1000; // 24 h (cap)
/**
 * FEA-3795: the progressive dead-letter retry delay for a given consecutive
 * dead-letter count. `deadLetterCount` is 1 for the first dead-letter of an id,
 * 2 for the next (recovered-then-re-dead-lettered), and so on. The delay is
 * `BASE * 2^(count-1)`, capped at `DEAD_LETTER_RETRY_MAX_MS`, and is
 * monotonically non-decreasing in `count`. A non-positive count is clamped to 1
 * (defensive; every recoverable dead-letter records at least one). The doubling
 * is computed with a bounded exponent so a large in-memory count can never
 * overflow to `Infinity` before the cap clamps it (the escalation count lives
 * only in the in-memory `deadLetterCountById` Map — see its field doc — and
 * re-derives from the base on a cold restart; it is never persisted).
 *
 * Thin wrapper over the shared {@link exponentialBackoffMs} ladder so this
 * schedule and the transcript-sync retry schedule stay a single source of truth.
 */
export function deadLetterRetryDelayMs(deadLetterCount: number): number {
  return exponentialBackoffMs(
    deadLetterCount,
    DEAD_LETTER_RETRY_BASE_MS,
    DEAD_LETTER_RETRY_MAX_MS
  );
}
// Upper bound on how many dead-lettered ids are retained in the in-memory Map
// AND the persisted cursor. A long-lived install that keeps dead-lettering
// distinct sessions (oversize / validation_failed) would otherwise grow this
// set — and the `dead_lettered_ids` JSON on `sync_state` — without limit. When
// the cap is exceeded, the OLDEST entries (Map insertion order) are evicted
// first: those are the sessions dead-lettered longest ago, most likely already
// recovered on a prior cold-restart re-backfill or simply the least urgent to
// revisit. Evicting an id only stops the process from remembering it was set
// aside — it is never re-uploaded incorrectly (the watermark already advanced
// past it), and a future cold restart re-walks and re-attempts it if it still
// exists locally. 1000 comfortably covers the observed real-world strand counts
// (tens) while keeping the persisted JSON small and bounded.
export const MAX_DEAD_LETTERED_IDS = 1000;
// FEA-3473 (G6): upper bound on the tied-top id set (`observedIdsAtTopUpdatedAt`)
// held in memory AND serialized into the persisted cursor's
// `observed_ids_at_top_updated_at` JSON. Sessions sharing one `updated_at` are
// preserved so same-timestamp siblings are re-selected on restart, but a
// pathological cluster (thousands of sessions stamped identically) would grow
// this set — and the JSON — without bound. When the set would exceed this cap we
// drop it entirely and fall back to re-scan-from-timestamp: an empty observed
// set means the incremental query omits its `id NOT IN (...)` exclusion term, so
// `updated_at = watermark` re-selects the WHOLE tied-top group, which the outbox
// and the server idempotently dedupe. So correctness is preserved: at worst the
// whole tied-top group is re-enumerated once. 5000 comfortably exceeds any
// realistic same-second batch while keeping the persisted JSON bounded.
export const MAX_OBSERVED_TOP_IDS = 5000;
// Goal stage 2 (atomic row-level ack): a session the server OMITTED from an
// accepted batch's `acceptedSessionIds` echo. The lane is provably healthy (the
// same request acked its neighbors), so the omission is row-attributable per
// `main/sync/AGENTS.md` invariant 4 and may burn a bounded budget. This is a
// LIVE class: the server's upsert loop throws on a FAILING slice (that path
// rejects the whole batch), but it also deliberately SKIPS a slice it will not
// write — a foreign chunk — and still accepts the batch, so that id is omitted
// from the echo. Sized to match the ingestion budget: an omitted row is most
// plausibly a server-side persistence hiccup of the same character.
export const MAX_CONSECUTIVE_ACK_OMITTED = 5;
// Defer an ack-omitted row on the shared 30s window before re-sending, so the
// self-continuing drain does not re-send the same omitted row back-to-back
// within one healthy pass.
export const ACK_OMITTED_BACKOFF_MS = RATE_LIMIT_BACKOFF_MS;
// How many times an id may be dead-lettered RECOVERABLY for `ack_omitted`
// before the class becomes terminal. Exactly the ISS-5090 second-order bound
// applied to the goal-stage-2 class, for exactly the same reason: the omission
// is worth re-driving because it is often NOT reproducible from the persisted
// row (a foreign chunk is omitted only while the server holds a mismatched
// pending assembly, which the next full re-send resolves), but "re-drivable"
// must not mean "forever". `recoverExpiredDeadLetters` clears the per-attempt
// `ackOmittedCountById` budget on every recovery, so without this bound a
// permanently-omitted id would burn a fresh MAX_CONSECUTIVE_ACK_OMITTED cycle
// every 24h for the life of the process — the unbounded retry
// `main/sync/AGENTS.md` invariant 5 forbids. Three cycles matches the sibling
// class and comfortably covers a transient server-side assembly mismatch.
export const MAX_ACK_OMITTED_DEAD_LETTERS = 3;
