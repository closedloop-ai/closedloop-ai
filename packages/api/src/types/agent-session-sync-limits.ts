// ISS-5988: how many sessions the desktop puts in ONE sync request.
//
// This was `1`, on the rationale that "desktop sends one session per request so
// server acks map to one bounded per-session ingestion transaction". Measured on
// a real 2,946-row backlog that bound was the dominant throughput cause: the
// median pending session serializes to ~3.3 KiB compressed against a 256 KiB
// request budget, so a batch of 1 used ~1.3% of every request and the lane
// drained below the rate at which sessions were being created — an unbounded
// local/cloud divergence, not a slow drain.
//
// The bound is DERIVED, not guessed, from the three real ceilings:
//   1. Server contract — `desktopAgentSessionsPayloadSchema` accepts
//      `sessions: z.array(...).max(200)` and has since PRD-365, so the cloud
//      already accepts a batch >1 today. No server change is needed and an
//      older server (which carries the same `.max(200)`) accepts it too, so
//      this is skew-safe in both directions.
//   2. Proven server coverage — `apps/api/__tests__/integration/
//      agent-session-ingestion-worst-case.test.ts` persists an 11-session
//      batch without P2028, which is what establishes that a MULTI-session
//      batch is safe on the ingest side at all. That test now pins
//      `FIXTURE_SESSION_COUNT <= this constant`, so the fixture stays a batch
//      this producer can actually emit; it does not prove every batch up to
//      this backstop, because the byte bounds in (3) are what keep real
//      batches far below it.
//   3. Peak HYDRATION HEAP — the real reason the old value was small, and the
//      ceiling this constant actually exists to enforce. Stage 1B (PR #4850)
//      measured it directly, and the cost is per SESSION HYDRATED, not per
//      query: 25 sessions = +397 MB, 50 = +640 MB, 100 = +526 MB, 200 = +814 MB,
//      whole corpus = +2,113 MB peak. (Not monotonic — GC timing moves the
//      sample — but every point above 25 sits materially higher.) That is spent
//      inside the 4 GB-caged db-host, which is ALSO the SQLite writer and the
//      durability owner, so an OOM there is not just a slow sync: it drops the
//      process that owns local durability.
//
//      ⚠️ `SESSION_HYDRATION_BYTE_BUDGET` CANNOT protect this dimension, and
//      reading it as though it does is the trap. The byte budget trims the
//      PAYLOAD; the heap above is spent PRODUCING the objects the budget then
//      trims. By the time the budget declines a session, its hydration cost has
//      already been paid. The two bounds are therefore complementary, not
//      redundant: the byte budget bounds what goes on the wire, and THIS count
//      bounds how much heap the db-host burns getting there.
//
// So this value is a SAFETY CEILING, not the throughput dial. The byte budget
// remains the real admission control and ends nearly every batch first; this
// only caps how many sessions may be hydrated at once when they are small
// enough that the byte budget would otherwise admit far more.
//
// 25 is the shape that has actually been RUN, not a projection: 11+ full soak
// cycles across three modes, heap peaking to +695 MB, zero OOM signatures. It
// is still a 25x throughput improvement over the shipped `1`, and it stays well
// under the server's own `.max(200)` schema ceiling.
export const DESKTOP_AGENT_SESSION_SYNC_MAX_SESSIONS_PER_REQUEST = 25;
export const DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES = 262_144;

// ISS-5992: the widest expansion the server will decompress a sync body to,
// expressed as a RATIO of the compressed request cap above rather than as a
// bare byte count, so the two can never drift apart.
//
// Measured over the 27 frozen sessions in `packages/golden-sessions`
// (`normalized.json`, gzip level 6): ratio max 9.79x, median 4.25x, largest raw
// session 1.55 MB. That confirms the "~5-10x" estimate the original 4 MiB
// ceiling was set against — a capped body at the worst measured ratio reaches
// only ~2.45 MiB — so 4 MiB never bound a TYPICAL session.
//
// 64x covers the tail the golden sample cannot. The most compressible agent
// transcripts are the repetitive ones (retried tool calls, duplicated logs), and
// repetition compresses far past 9.79x. It stays a BOUND deliberately: a 256 KiB
// request expanding to at most 16 MiB is a bounded allocation, where removing
// the limit entirely would hand an authenticated remote caller an unbounded heap
// allocation from a small body.
export const SYNC_MAX_DECOMPRESSION_RATIO = 64;

/**
 * SERVER-enforced ceiling on the DECOMPRESSED size of a gzip sync body — the
 * zip-bomb guard. `maxOutputLength` throws BEFORE allocating past it, so an
 * over-ceiling body is refused rather than buffered to completion.
 *
 * ISS-5992 raised this 4 MiB -> 16 MiB. What 4 MiB actually bound was not a
 * typical session (see the ratio measurement above) but the case the ticket is
 * about: a single INDIVISIBLE session over the ceiling, which the FEA-4152
 * chunker cannot split further, ships whole, and is answered `Invalid compressed
 * body` -> `validation_failed` -> DEAD-LETTER. Permanent loss of a real session.
 */
export const SYNC_DECOMPRESSED_BYTE_CEILING =
  DESKTOP_AGENT_SESSION_SYNC_REQUEST_MAX_BYTES * SYNC_MAX_DECOMPRESSION_RATIO;

/**
 * The decompressed size FEA-4152's chunker splits a payload to stay under.
 *
 * Deliberately BELOW {@link SYNC_DECOMPRESSED_BYTE_CEILING}, and deliberately
 * still 4 MiB — its value before the ceiling was raised — because the two are
 * read by independently deployed halves and only one direction is safe. A
 * desktop targeting 16 MiB against a server still enforcing 4 MiB would ship
 * payloads that are rejected and dead-lettered; a server strictly more
 * permissive than any client, old or new, breaks nothing in either deploy order.
 *
 * Relaxing this target is a follow-up that may only land once the raised server
 * ceiling is actually deployed.
 */
export const SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES = 4_194_304; // 4 MiB
