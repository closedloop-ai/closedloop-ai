import {
  DESKTOP_AGENT_SESSION_SYNC_MAX_SESSIONS_PER_REQUEST,
  DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES,
} from "@repo/api/src/types/agent-session-sync-limits";

// Maximum number of candidate session IDs to pull from the queue per sync cycle.
export const INCREMENTAL_SESSION_BATCH_SIZE =
  DESKTOP_AGENT_SESSION_SYNC_MAX_SESSIONS_PER_REQUEST;

// ISS-5988: how many ready incremental sessions justify shipping a batch NOW,
// instead of waiting out `MIN_INCREMENTAL_SYNC_INTERVAL_MS` to coalesce more.
//
// This is deliberately NOT `INCREMENTAL_SESSION_BATCH_SIZE`. The two were the
// same value only because that constant used to be 1, which made "the queue is
// non-empty" and "the queue can fill a whole request" indistinguishable — so
// fusing them was invisible. Raising the request ceiling separates them, and
// reusing the ceiling here would mean any backlog SMALLER than one full request
// (the common case: the 5-session remainder after a 30-session drain, or a
// single live session) is held for the full 30 s coalescing window. That is a
// liveness regression on live sync, in the opposite direction from the ticket,
// and it is what `agent-session-sync-bulk-drain.test.ts`'s ISS-5085 case
// ("a ready multi-batch incremental backlog drains without 30s pauses")
// measures — it fails outright when this is aliased to the ceiling.
//
// 1 keeps today's shipped behaviour exactly: anything ready ships on the next
// tick. The request ceiling still bounds how many go in that one envelope, so
// the hydration-heap guard is untouched — this governs WHEN a batch leaves,
// never HOW BIG it is.
export const INCREMENTAL_SESSION_READY_THRESHOLD = 1;

// Backfill bound. This is the SINGLE knob that caps how many hydrated sessions
// the backfill ever holds in memory at once: a sync cycle picks at most this
// many ids from `backfillQueue`, hydrates exactly those, builds + sends their
// payload, releases them, then the next cycle repeats. Peak retained hydration
// is therefore one batch of this size, NOT the whole `backfillQueue` (which is
// thousands of ids on a large install).
//
// The sync hydrate passes `omitEventData: true` (FEA-2718), so a batch does NOT
// retain each event's multi-KB `data` blob — the term that drove the original
// V8 OOM (exit 5) on a whole-corpus load. That, plus the per-session measurements
// recorded on `DESKTOP_AGENT_SESSION_SYNC_MAX_SESSIONS_PER_REQUEST`, is why this
// can exceed 1 without spending the OOM guard.
//
// ISS-5988 replaced the previous claim here that "larger only buys marginal
// throughput": on a real 2,946-row backlog a batch of 1 filled ~1.3% of the
// 256 KiB request budget and drained slower than sessions were created, so the
// throughput this bound was suppressing was not marginal — it was the defect.
export const BACKFILL_SESSION_BATCH_SIZE =
  DESKTOP_AGENT_SESSION_SYNC_MAX_SESSIONS_PER_REQUEST;

// ISS-6166: how many consecutive INCREMENTAL passes may run before the next
// tick is reserved for backfill.
//
// The drain is otherwise strict priority — backfill is selected only when the
// incremental pick returns zero candidates — and `INCREMENTAL_SESSION_READY_THRESHOLD`
// is 1, so a single ready incremental row wins every tick. On an install that
// keeps producing local session updates the incremental lane never empties, and
// the historical backfill is starved indefinitely: the measured install held
// 646 backfill rows motionless for days while incremental trickled down, so
// those sessions never appeared on the web at all.
//
// ISS-4712 fixed one SOURCE of that pressure (rebuild `updated_at` churn
// re-enqueuing rows the backfill queue already owned). It cannot cover
// genuinely-new incremental work, which is unbounded on an actively-used
// machine — hence a fairness floor rather than another de-dup.
//
// This is the same shape as `loadReadyInvocationSyncOutboxParts`' never-attempted
// reservation (`main/sync/AGENTS.md` invariant 5): a FLOOR on fairness, never a
// ceiling on throughput. A reserved tick with no ready backfill work hands the
// tick straight back to incremental, so the reservation costs nothing when there
// is nothing to be fair to. The policy that reads it lives in
// `agent-session-drain-selection.ts`.
export const MAX_CONSECUTIVE_INCREMENTAL_PASSES = 4;

// Maximum serialized JSON payload size per batch (256 KiB).
export const SESSION_PAYLOAD_BYTE_CAP =
  DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES;

// ISS-5988: the bound that actually protects the db-host heap. Admission is
// capped by BYTES HELD, not by candidate count: `hydrateWithinByteBudget`
// hydrates admitted candidates in slices and stops once this many RAW JSON
// bytes are resident, so peak retained hydration is ~one request's worth
// regardless of how many candidates the count backstop admitted.
//
// Derived from the measured backlog (2,946 pending rows) rather than picked:
// the median session hydrates to ~28 KiB raw and gzips ~8.4x, so filling a
// 256 KiB COMPRESSED request takes ~2.1 MiB of raw hydration. 2 MiB is that
// figure, which lets the wire cap — not this budget — be what ends a batch in
// the common case.
//
// Measured in raw bytes on purpose, even under gzip: this bounds the JS heap
// the hydrated object graph occupies, which is a different dimension from the
// compressed wire size the accumulator packs against. Under identity encoding
// the accumulator stops at 256 KiB first, so this over-hydrates by up to the
// compression ratio — still bounded, and still ~13x below the ~26.7 MiB single
// worst-case session the old batch-of-1 path already hydrated unbounded.
export const SESSION_HYDRATION_BYTE_BUDGET = 2_097_152;

// How many candidates each hydration slice loads before the budget is re-checked.
// Bounds the overshoot past the budget to one slice: at the measured p90 raw
// size (~133 KiB) a 5-id slice overshoots by at most ~665 KiB, which keeps the
// effective peak inside the same order as the budget itself. Smaller slices
// bound the overshoot tighter at the cost of more db-host round trips.
export const SESSION_HYDRATION_SLICE_SIZE = 5;
