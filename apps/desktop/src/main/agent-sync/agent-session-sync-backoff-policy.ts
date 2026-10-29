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
  LANE_STALL_CEILING_MS,
  LANE_STALL_RETRY_FLOOR_MS,
} from "../../shared/lane-stall-clock.js";
import { maxSessionPayloadBytesForBatch } from "./agent-session-sync-envelope-reserve.js";
import {
  BACKFILL_SESSION_BATCH_SIZE as BACKFILL_SESSION_BATCH_SIZE_LIMIT,
  INCREMENTAL_SESSION_BATCH_SIZE as INCREMENTAL_SESSION_BATCH_SIZE_LIMIT,
  INCREMENTAL_SESSION_READY_THRESHOLD as INCREMENTAL_SESSION_READY_THRESHOLD_LIMIT,
  SESSION_PAYLOAD_BYTE_CAP as SESSION_PAYLOAD_BYTE_CAP_LIMIT,
} from "./agent-session-sync-limits.js";

export const INCREMENTAL_SESSION_BATCH_SIZE =
  INCREMENTAL_SESSION_BATCH_SIZE_LIMIT;
export const INCREMENTAL_SESSION_READY_THRESHOLD =
  INCREMENTAL_SESSION_READY_THRESHOLD_LIMIT;
export const BACKFILL_SESSION_BATCH_SIZE = BACKFILL_SESSION_BATCH_SIZE_LIMIT;
export const SESSION_PAYLOAD_BYTE_CAP = SESSION_PAYLOAD_BYTE_CAP_LIMIT;
export const SESSION_PAYLOAD_CONTENT_BYTE_CAP = maxSessionPayloadBytesForBatch(
  SESSION_PAYLOAD_BYTE_CAP
);
// ISS-8605 (PRD-699 F1/F2): `MAX_CONSECUTIVE_TIMEOUTS` (3) and
// `MAX_CONSECUTIVE_RATE_LIMITED` (5) used to live here and are deleted, not
// relaxed. Both classes are ENVIRONMENTAL under the approved classification
// standard, so neither has a per-row budget left to cap:
//   - 408 was verified never to be emitted by the sync route (ISS-5088 already
//     narrowed it to an intermediary proxy/CDN, which never reads the payload).
//   - 429 comes from a limiter keyed on `direct|relay:<org>:<user>:<target>`
//     (`buildRateLimitKey`), so it can never single out a row.
// A failure no row can be blamed for may not exhaust a row's budget
// (`main/sync/AGENTS.md` invariant 4); both now terminate on
// SESSION_LANE_STALL_CEILING_MS below instead (invariant 5).
//
// ISS-7730: `ingestion_failed` has NO consecutive-failure budget, deliberately.
// It is the sync route's UNCLASSIFIED 500 fallthrough — returned after every
// taxonomized reason declines, and the desktop collapses 502/504/deploy-skew
// 404/non-contract 2xx into it too — so it means "the server failed and could
// not say why". Nothing in it is reproducible from the persisted row, which is
// exactly `main/sync/AGENTS.md` invariant 4's test for whether a failure may
// exhaust a budget, and the sibling invocation lane already classifies the
// identical server reason as transient
// (`invocation-sync-rejection-policy.ts` → `TRANSIENT_REJECTION_BUDGET`). The
// bound it lost is replaced by the wall clock below, not removed — see
// `agent-session-sync-lane-stall-fold.ts`.
// FEA-3364: a THROWN sendBatch or payload prep is a batch failure that — unlike
// an ack rejection — used to increment no counter: the batch stayed queued at
// retry-count 0 and re-sent every 5s forever. Bound consecutive throws on the
// same session so a persistently unsendable batch is eventually dead-lettered
// instead of looping. Two throws are not counted against this budget: a LOCAL
// serialization failure is dead-lettered immediately (isLocalSerializationError),
// and a dropped connection defers the whole lane (ISS-10602,
// AgentSessionSyncTransportError) — see agent-session-sync-transport-error-fold.
export const MAX_CONSECUTIVE_TRANSPORT_ERRORS = 5;
// ISS-5088: a CLIENT-side request abort (`transport_timeout`) — the local 30s
// deadline fired and the server never answered. It still gets a bounded budget
// so a session that is genuinely unsendable within the deadline on an otherwise
// healthy lane reaches a terminal path (`main/sync/AGENTS.md` invariant 5), but
// the budget is generous AND refundable: `refundTransportTimeoutBudgets()` drops
// every accumulated charge the moment the lane observes unambiguous connectivity
// loss, because that proves the window was lane-wide rather than payload-
// attributable (invariant 4 — a lane-wide failure must never burn a row's retry
// budget). Sized generously because the cause is far more likely external than
// payload-attributable; this is now the LAST bounded budget in the ambiguous
// band, the two beside it having been reclassified by ISS-8605.
export const MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS = 5;
// FEA-1461: after a `rate_limited` rejection, defer re-attempting the same
// session for this long. Prevents the 5-second sync tick from re-chunking and
// re-sending the same oversized session every cycle (the original symptom).
// Other queued sessions continue to flow through `pickReadyCandidates`.
//
// ISS-8605: also the shared window for the other three environmental classes
// that are not `ingestion_failed` — 429, 408, and an unrecognized reason. It is
// the FLOOR PRD-699 F1 names, not a whole schedule.
//
// ISS-8610 (PRD-699 F8) made that literally true: those three classes now open
// on this window and double from it toward `LANE_STALL_MAX_RETRY_MS`, read off
// each row's own stall clock (`SESSION_ENVIRONMENTAL_DEFER_POLICY`). ISS-10014
// completed it: the sync route now sends `Retry-After` on its coded 429, the ack
// union carries the parsed value, and the shared helper takes it as a MINIMUM
// against this floor. A cloud that sends no header leaves this window exactly as
// it was, which is what lets the two halves deploy independently.
export const RATE_LIMIT_BACKOFF_MS = 30_000;
// ISS-7730: how long ONE row may sit in an unbroken lane-wide ENVIRONMENTAL run
// before it is dead-lettered anyway. ISS-8605/ISS-8595 put 429, 408 and an
// unrecognized ack reason on this same clock, so it is now the terminal path for
// every class that charges no row budget — one ceiling per row, not per reason,
// because "the world has been broken for a day" is one fact about the row.
//
// The class deliberately advances no per-row counter (invariant 4), which
// removes the only bound it had; invariant 5 is explicit that every terminal
// path must stay reachable, so the bound moves from attempts to wall-clock,
// measured from the durable `lane_stalled_since`. 24h matches
// `TRANSCRIPT_LANE_STALL_CEILING_MS`, the same bound ISS-7097 chose for the
// identical class on the transcript lane — two lanes measuring the same cloud
// outage must not disagree about how long it has to last before they give up.
//
// ISS-8615 (PRD-699 §7.3): that agreement used to be two literals and a comment
// asking the next editor to keep them equal. Both are now `LANE_STALL_CEILING_MS`,
// so the lanes cannot drift apart by editing one of them.
export const SESSION_LANE_STALL_CEILING_MS = LANE_STALL_CEILING_MS;
// ISS-7730: the retry delay for a lane-wide `ingestion_failed` SPECIFICALLY —
// the other environmental classes keep the shorter RATE_LIMIT_BACKOFF_MS floor
// (see `SESSION_ENVIRONMENTAL_DEFER_POLICY`, which records why the two differ).
//
// Longer than `RATE_LIMIT_BACKOFF_MS` because the class no longer terminates
// after five attempts: a row now defers for up to
// SESSION_LANE_STALL_CEILING_MS, and re-polling a down cloud every 30s for 24h
// would be 2,880 requests per row against a server that is already failing.
// Five minutes polls an outage ~12 times an hour per row instead of 120, and is
// well inside the ceiling that terminates the run. Equal to
// `TRANSCRIPT_LANE_STALL_RETRY_MS` for the same reason the ceiling is — and, as
// on that lane since ISS-8689, it is a FLOOR rather than a whole schedule:
// ISS-8610 stages this class from here up to an hour off the same durable stall
// clock. ISS-10014 closed the last gap between them: both lanes now honor a
// server `Retry-After` as a minimum wait. The two lanes must keep agreeing on
// the CEILING; they are free to differ on the cadence, and on the floor they
// happen not to.
//
// KNOWN TRADE, recorded so it is argued from rather than rediscovered. A
// DEFERRED row stays on its queue — only a dead-letter dequeues — and
// `persistCursorIfCaughtUp` refuses to advance the watermark while either queue
// holds work. So a row that keeps drawing an unclassified 500 now pins the
// cursor for up to SESSION_LANE_STALL_CEILING_MS instead of the ~2 minutes the
// old 5-attempt budget took to dead-letter it, and a restart inside that window
// resumes from the older watermark and re-walks (the server dedupes the
// re-sends). During a TOTAL outage nothing acks anyway, so the cursor could not
// advance PAST it regardless; the cost is real only under a PARTIAL one, where a
// single row deterministically 500s while its neighbours succeed — and ISS-8041
// bounds that cost to the deferred row itself, since the watermark now settles
// just below it instead of staying wherever it last was. It is the same trade
// `UNCONFIRMED_ABSENCE_BACKOFF_MS` below already makes — "a cost paid in work,
// not in data" — and the alternative is the defect: dead-lettering healthy rows
// wholesale during an outage. Do not "fix" it by letting the watermark advance
// past a deferred row; that breaks the acked-contiguous rule, and a dead-letter
// may advance past it only because it is RECORDED.
export const SESSION_LANE_STALL_RETRY_MS = LANE_STALL_RETRY_FLOOR_MS;
// ISS-5088: after a client-side abort (`transport_timeout`), defer the same
// session rather than re-attempting on the very next 5s tick. A stalled
// transport does not clear in milliseconds, and an immediate re-send re-pays the
// full prepare + serialize cost into the same stall — which is itself part of
// the main-process contention those windows show.
export const TRANSPORT_TIMEOUT_BACKOFF_MS = RATE_LIMIT_BACKOFF_MS;
// FEA-3366: after this many consecutive `validation_failed` rejections on the
// same session, dead-letter it. Kept small — below every other surviving per-row
// budget (MAX_CONSECUTIVE_TRANSPORT_TIMEOUTS, MAX_CONSECUTIVE_TRANSPORT_ERRORS,
// MAX_CONSECUTIVE_ACK_OMITTED, all 5) — because a schema rejection is more
// likely deterministic than a transient failure — but a nonzero budget lets a session survive a transient
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
// ISS-8610 (PRD-699 F8): `UNAUTHENTICATED_BACKOFF_MS` and
// `TARGET_NOT_OWNED_BACKOFF_MS` used to live here — both flat 30s windows, both
// deleted rather than retuned. FEA-3425 was right that neither 401 nor 403 may
// burn a row budget (invariant 4), and wrong only in what it left behind: a
// defer with no clock and no terminal, re-attempting every 30s forever
// (invariant 5). Both are LANE-WIDE facts — every row would draw the identical
// answer — so they are now on the shared `LaneEnvironmentalDeferGate`, which
// stages the wait off the run's own age and terminates it on the durable 24h
// give-up. There is no per-class constant left to declare: the schedule is the
// gate's, and the re-arm doors are `AgentSessionSyncService.
// noteLaneRecoverySignal`. See `agent-session-sync-fold-runners.ts`.
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
// first: those are the sessions dead-lettered longest ago and the least urgent
// to revisit.
//
// ISS-7216: this used to say eviction was harmless because "a future cold
// restart re-walks and re-attempts it if it still exists locally". That was
// FALSE and it hid a data-loss bug — `initializeBackfillQueueIfNeeded`
// early-returns as soon as a cursor is resumed, so a device past its first
// backfill never re-walks the corpus, and a `dead_lettered` outbox row is
// invisible to `loadPendingOutboxIds` and to stranded-row adoption. What makes
// eviction safe is not a re-walk: it is that `enforceDeadLetterCap` now hands
// the durable row back to the pending outbox on the way out, so the ledger — not
// this bounded Map — carries the obligation. Keep that property if you touch the
// eviction. 1000 keeps the persisted JSON small and bounded.
export const MAX_DEAD_LETTERED_IDS = 1000;
// ISS-7730: upper bound on `laneStalledSinceMsById`, the in-memory half of the
// durable `lane_stalled_since` clock. It is keyed by EXTERNAL session id and an
// entry survives until the row acks, draws a row-attributable verdict, crosses
// the ceiling, or the identity resets — so during a broad outage nothing removes
// entries and the map would otherwise track every session in the local corpus.
// `main/sync/AGENTS.md` invariant 10 requires an explicit cap.
//
// The cap is enforced on ADMISSION, never by evicting a tracked run, and that
// asymmetry is the whole point: evicting a live clock would restart the only
// bound `ingestion_failed` has, silently handing a session a fresh 24h — the
// exact failure this ticket exists to prevent. Instead a row that arrives while
// the map is saturated is simply not tracked YET: it defers with every budget
// intact (unchanged behaviour) and writes NO stall stamp, so its durable column
// is neither invented nor overwritten. Tracked runs leave on their own terms and
// free the slot, and the untracked row is admitted on a later pass — invariant
// 10's "re-discovered later, never lost".
//
// 10,000 is sized against the measured large-install backlog cited on
// `SESSION_HYDRATION_BYTE_BUDGET` (2,946 pending rows): ~3x that install is
// tracked concurrently, at roughly a megabyte of Map, while a pathological
// corpus can no longer grow it without limit.
export const MAX_TRACKED_LANE_STALLS = 10_000;
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

// ISS-8271 (PLN-1839 Step 3): defer window for a session whose row still
// carries a mid-derivation sentinel `data_revision` (< 1). No budget is burned
// — the session is legitimately not ready — and the window makes no promise
// about how long the hold lasts: the seal normally lands when the
// import/re-derivation completes, but a session can sit at a sentinel for a
// long time (that state is first-party monitored via
// `import.sessions_pending_revision`, and an eviction-orphaned `-1` heals only
// on the next boot's rebuild). The shared 30s window just bounds how often the
// defer re-checks without letting a long import spin the drain on its own
// deferrals.
export const SENTINEL_REVISION_BACKOFF_MS = RATE_LIMIT_BACKOFF_MS;
