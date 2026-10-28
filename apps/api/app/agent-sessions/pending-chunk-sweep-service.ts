import { type Prisma, type PrismaClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { IndexKeyOrigin } from "@/lib/index-key-lookup";
import { SESSION_DELETE_BATCH_SIZE } from "./retention-service";
import { tryAcquireSessionAdvisoryLocks } from "./service/advisory-locks";
import { PendingChunkAckContract } from "./service/pending-chunk-ack-contract";
import { SessionSyncMetric } from "./service/session-sync-metrics";

/**
 * ISS-8602 (PRD-699 §6): how long (hours) a staged chunked-apply sequence may
 * sit without receiving a chunk before this sweep reaps its marker.
 *
 * FIXED, not operator-tunable (review: davetho). An earlier revision read
 * `process.env.PENDING_CHUNK_TTL_HOURS` the way the sibling sweeps read theirs,
 * but ISS-8602 asks for a TTL sweep and not for a knob, and an override silently
 * discards the derivation below — the number is not a round guess, it is one
 * lane's retry horizon. Adding the lever back is its own change, and owes an
 * owner, a read location, and stated absent-value behavior.
 *
 * 72h is borrowed from `SESSION_MISSING_MAX_RETRY_AGE_MS`
 * (`invocation-sync-rejection-policy.ts`), where three days is chosen because it
 * "spans the parent's first ten recovery cycles (their delays sum to 66.6h)" —
 * every rung from the 5-minute first attempt through the first fully-capped 24h
 * window.
 *
 * It is NOT a proof that the tail has stopped coming, and must not be described
 * as one: that same file states the session lane re-arms its ladder after every
 * failed cycle, so "its cumulative horizon is UNBOUNDED. No finite budget can
 * outlast that". A device on a bad link can exceed 72h between chunk landings
 * while still trying. The safety of this sweep therefore does NOT rest on the
 * window being long enough. It rests on clearing being non-destructive (see
 * {@link pendingChunkSweepService.runPendingChunkSweep}) and on not handing the
 * freed row to a deleter (see the cron route's schedule note).
 */
export const PENDING_CHUNK_TTL_HOURS = 72;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * ISS-8602 (review: davetho): the drain's own ceiling, sized under the cron
 * route's `maxDuration = 300`.
 *
 * A platform timeout is not a catchable exception. A backlog large enough to
 * outlast the route takes the request past this service's `catch`, past the
 * metric emission, past the 500 and its Slack alert — so a run that repaired a
 * committed prefix and was then killed reports as no run at all, which is the
 * silent-failure shape the zero emission below exists to avoid. Stopping here
 * leaves ~60s for the emission, the response, and the log flush.
 *
 * Nothing is lost by stopping between pages: every page is a fresh query
 * against the same predicate, and each clear committed in its own transaction,
 * so tomorrow's invocation resumes from the rows still matching.
 *
 * ISS-8602 (review: marisolashgrove) — IT BOUNDS THE PAGE, NOT ONLY THE LOOP, and
 * it did not always. Checked only between pages this ceiling was no ceiling at
 * all: a page is up to `SESSION_DELETE_BATCH_SIZE` SERIAL transactions, so one
 * starting at 239s could spend the whole reserved tail and be killed by the
 * platform in exactly the way this constant exists to prevent. The same instant
 * is now passed into {@link clearOrphanedChunkMarkersBatch} as a deadline it
 * checks BEFORE opening each transaction, so the worst-case overshoot is one
 * transaction rather than one page — and `withDb.tx` caps that at its 5s default
 * timeout, leaving the route ~55s of its 300s even in the worst case.
 */
const PENDING_CHUNK_SWEEP_TIME_BUDGET_MS = 240_000;

/**
 * ISS-8602 (review: synchronizing-susan): the slice of the drain's budget held
 * back for the post-drain declined-band count, so that read stays INSIDE the
 * envelope above instead of spending the ~60s tail reserved for the emission,
 * the response, and the log flush.
 *
 * WHY IT NEEDS ITS OWN RESERVE. The count is one unbounded `count()` over a
 * population this fix deliberately leaves standing, so it grows for as long as
 * the fleet holds declined markers, and no index serves its predicate yet
 * (ISS-10067). Run unguarded after a drain that legitimately used its whole
 * budget, it could push the request past `maxDuration` — an UNCATCHABLE kill
 * that loses the response, the repair metric, and therefore the record of clears
 * that had already COMMITTED. That is the same silent-failure shape the drain's
 * own ceiling exists to prevent, one step later.
 *
 * Correlated, which is why a reserve and not optimism: the run most in need of
 * this number — a large declined backlog, a loaded table — is exactly the run
 * whose count is slowest.
 *
 * Skipping is safe BECAUSE the count reports `null` for "not measured" and the
 * metric is then not emitted at all. A skipped count costs one day of
 * visibility into a population that changes slowly; a killed request costs the
 * repair record.
 */
const PENDING_CHUNK_COUNT_RESERVE_MS = 30_000;

/**
 * ISS-8602: is there budget left for the declined-band count, or does this run
 * report it unmeasured?
 *
 * Measured against the DRAIN's start, and bounded by the drain's own ceiling
 * rather than by the route's — so the count spends the drain's reserve and never
 * the tail the emission and response need.
 */
function hasTimeForUnconfirmedAckCount(drainStartedAtMs: number): boolean {
  const elapsedMs = Date.now() - drainStartedAtMs;
  return (
    elapsedMs <=
    PENDING_CHUNK_SWEEP_TIME_BUDGET_MS - PENDING_CHUNK_COUNT_RESERVE_MS
  );
}

/** Cutoff instant: a sequence last written before this is an orphan. */
export function pendingChunkCutoff(now: Date, ttlHours: number): Date {
  return new Date(now.getTime() - ttlHours * MS_PER_HOUR);
}

type TxClient = Parameters<Parameters<typeof withDb.tx>[0]>[0];
type DbClient = TxClient | PrismaClient;

/**
 * ISS-8602: the AGE half — a `SessionDetail` carrying a staged chunked-apply
 * sequence that has received nothing since `cutoff`. Band-blind: this is every
 * abandoned sequence, whether or not the sweep may reap it.
 *
 * `lastSyncedAt` is the age anchor rather than a staged-at column (there is
 * none) and rather than `lastActivityAt` (session time, not receive time). Every
 * apply that writes a chunk stamps it — `session-slice-detail-write.ts` puts
 * `lastSyncedAt: syncTimestamp` in the same `detailData` that carries
 * `gate.pendingChunkPatch` — so the column measures the sequence's own progress,
 * not its start. A 100-chunk upload that legitimately takes a week is therefore
 * never an orphan: each arriving chunk pushes the anchor forward. A payload the
 * gate REFUSES (foreign chunk, held revision-less mid-sequence) writes nothing
 * at all, so it cannot refresh the anchor either.
 *
 * Both band predicates below are derived from THIS one rather than restating it,
 * so the reaped set and the declined set cannot drift on what "abandoned" means.
 */
function agedChunkMarkerWhere(
  cutoff: Date,
  orgId: string | null
): Prisma.SessionDetailWhereInput {
  const aged: Prisma.SessionDetailWhereInput = {
    pendingChunkRevision: { not: null },
    lastSyncedAt: { lt: cutoff },
  };
  if (orgId) {
    aged.artifact = { is: { organizationId: orgId } };
  }
  return aged;
}

/**
 * ISS-8602 (review: davetho): the markers this sweep may actually clear — an
 * abandoned sequence whose producer ASKED for the row-level ack.
 *
 * THE BAND GATE IS A DATA-LOSS GUARD, not a nicety, and it is the reason this
 * sweep does not wait on a fleet upgrade. A producer that did not request
 * `acceptedSessionIds` reads a no-echo 200 as acking every id in the batch and
 * deletes its outbox rows, so a chunk it delivers after the marker is freed is
 * foreign, written nowhere, and gone from the only place it still existed. For
 * that band the cost of clearing is not a re-send — it is the client deleting
 * its own tail. See `service/pending-chunk-ack-contract.ts`.
 *
 * UNKNOWN IS DECLINED BY SQL, not by a branch anyone has to remember. This is an
 * equality test, and under three-valued logic neither a NULL nor a value this
 * build cannot name satisfies it. So every row staged before the column existed
 * — which at deploy time is every row — is outside the sweep's reach with no
 * backfill, and a backfill guessing "capable" would have re-opened the hazard
 * for exactly the population at risk.
 *
 * NARROWED AT SELECTION, deliberately, rather than skipped at clear time. A
 * declined row shrinks nothing and still matches, so admitting it as a candidate
 * would re-select it on every page — the same non-shrinking shape the CONTENDED
 * outcome has, but permanent rather than transient. One page of declined rows
 * would then burn the whole drain budget daily and STARVE the clearable rows
 * behind them. Excluded here, they cost the drain nothing and are counted once
 * per run by {@link unconfirmedAckMarkerWhere} instead.
 */
export function orphanedChunkMarkerWhere(
  cutoff: Date,
  orgId: string | null
): Prisma.SessionDetailWhereInput {
  return {
    ...agedChunkMarkerWhere(cutoff, orgId),
    pendingChunkAckContract: PendingChunkAckContract.RowLevel,
  };
}

/**
 * ISS-8602: the exact complement of {@link orphanedChunkMarkerWhere} over the
 * same aged population — abandoned markers this sweep declined to clear.
 *
 * Counted rather than reaped, because "never cleared" is the other failure mode
 * of this fix: without a number, a fleet holding markers the sweep will not
 * touch is indistinguishable from a fleet with nothing to sweep.
 *
 * THE NULL ARM IS SPELLED OUT rather than left to `not`, whose three-valued
 * behaviour on a nullable column would silently drop every unset row — which is
 * the majority of this population and the whole reason it is being counted. The
 * two arms together are correct whichever way `NOT` treats
 * NULL, and the second arm keeps an unrecognized future band counted rather than
 * lost between the two predicates.
 */
export function unconfirmedAckMarkerWhere(
  cutoff: Date,
  orgId: string | null
): Prisma.SessionDetailWhereInput {
  return {
    ...agedChunkMarkerWhere(cutoff, orgId),
    OR: [
      { pendingChunkAckContract: null },
      {
        NOT: {
          pendingChunkAckContract: PendingChunkAckContract.RowLevel,
        },
      },
    ],
  };
}

/**
 * ISS-8602: how many aged markers this run declined because their producer band
 * is not confirmed row-level.
 *
 * ONE count per run, not per page: the declined set is excluded from selection,
 * so it is invisible to the drain and has to be asked for separately. Asking
 * once is also what keeps the number a gauge of the standing population rather
 * than a function of how many pages the drain happened to take.
 *
 * Read against the SAME `cutoff` the drain used, never a freshly computed one,
 * so the cleared count and the declined count partition one population.
 */
export async function countUnconfirmedAckMarkers(
  db: DbClient,
  cutoff: Date,
  orgId: string | null
): Promise<number> {
  return await db.sessionDetail.count({
    where: unconfirmedAckMarkerWhere(cutoff, orgId),
  });
}

export type OrphanedChunkMarkerCandidate = {
  artifactId: string;
  /** The identity the per-session advisory lock is keyed on. */
  externalSessionId: string;
};

/**
 * Reads up to `SESSION_DELETE_BATCH_SIZE` orphaned markers, carrying the
 * identity the lock is keyed on.
 *
 * Deliberately OUTSIDE the clearing transaction. This read holds nothing, so a
 * session whose next chunk lands between here and its own clear is spared by
 * that clear's recheck rather than made to queue behind this page.
 *
 * THE BOUND IS THE MODULE CONSTANT, never a caller-supplied one
 * (`no-terminal-cap-threaded`, ISS-9867). A page size arriving as a parameter
 * is a bound this function cannot vouch for — nothing here pages past it, so a
 * caller is free to hand in a number that makes the retained prefix the whole
 * answer. It is also the number the drain's own termination test is written
 * against: {@link pendingChunkSweepService.runPendingChunkSweep} decides it has
 * reached the end of the population by comparing a page against
 * `SESSION_DELETE_BATCH_SIZE`, so a page bounded by anything else would end the
 * walk on a short page that was not short. The bound and the test have to be
 * one number, and naming it once here is what keeps them from drifting apart.
 */
export async function selectOrphanedChunkMarkerCandidates(
  db: DbClient,
  cutoff: Date,
  orgId: string | null
): Promise<OrphanedChunkMarkerCandidate[]> {
  return await db.sessionDetail.findMany({
    where: orphanedChunkMarkerWhere(cutoff, orgId),
    select: { artifactId: true, externalSessionId: true },
    take: SESSION_DELETE_BATCH_SIZE,
  });
}

/** What one candidate's locked clear did. */
export const PendingChunkClearOutcome = {
  /** The UPDATE changed the row: all four marker columns are NULL. */
  Cleared: "cleared",
  /** The recheck refused it — a chunk landed after the page read. */
  Spared: "spared",
  /** Another transaction holds the session, so this run did not touch it. */
  Contended: "contended",
} as const;
export type PendingChunkClearOutcome =
  (typeof PendingChunkClearOutcome)[keyof typeof PendingChunkClearOutcome];

/**
 * Clears ONE candidate's four sequence columns under the SAME per-session
 * advisory lock a desktop apply holds, and reports what happened.
 *
 * All FOUR columns go together. `schema.prisma` states the invariant — "All
 * four are NULL when no chunked sequence is mid-apply" — and
 * `chunk-revision-gating.ts` treats `(pendingChunkRevision, pendingChunkTotal)`
 * as one sequence IDENTITY, so clearing the revision alone would leave a
 * half-open marker that satisfies neither the steady state nor a live sequence.
 *
 * ISS-8602 (review: whitlockk) — WHY THE LOCK, and not the recheck alone. Without
 * it this sweep and a live apply are two decomposed read-modify-writes over one
 * marker with nothing serializing them, which `AGENTS.md` forbids. An INTERIOR
 * chunk's patch writes `pendingChunkReceived` ALONE (`resolvePendingChunkPatch`,
 * the in-sequence non-final arm), computed from a marker read before this
 * statement and written after it — so the row is left holding a received-count
 * beside a NULL revision and total. That is the half-marker the schema says
 * cannot exist, and it is one this sweep can never reap again, because its own
 * predicate requires a non-NULL revision. Holding the apply's lock removes the
 * interleaving in both directions: the apply either reads the CLEARED marker,
 * in which case its chunk is foreign and writes no patch at all, or it commits
 * first and the recheck below spares the row.
 *
 * The lock is TRIED, never waited on. A session another transaction is writing
 * this instant is not an abandoned sequence, so the refusal already carries the
 * answer, and a once-a-day TTL sweep must not queue in front of ingest traffic
 * to learn it. Taking exactly one session's pair also keeps this transaction
 * out of any deadlock cycle, so no acquisition order has to be argued —
 * `service/artifact-links/internal-branch-target.ts` records why a batched
 * `unnest` would supply none.
 *
 * The UPDATE re-checks the full selection predicate rather than trusting the
 * captured id: the page read above took no lock, so a chunk can still have
 * committed in that gap, and it has already stamped `lastSyncedAt` — the
 * recheck spares that row instead of reaping a sequence that just resumed.
 */
export async function clearOrphanedChunkMarker(
  tx: TxClient,
  candidate: OrphanedChunkMarkerCandidate,
  cutoff: Date,
  orgId: string | null
): Promise<PendingChunkClearOutcome> {
  // ISS-8200 (review): a STORED key, for the same reason the stale reaper's is.
  const locked = await tryAcquireSessionAdvisoryLocks(
    tx,
    candidate.externalSessionId,
    IndexKeyOrigin.Stored
  );
  if (!locked) {
    return PendingChunkClearOutcome.Contended;
  }
  const result = await tx.sessionDetail.updateMany({
    where: {
      AND: [
        orphanedChunkMarkerWhere(cutoff, orgId),
        { artifactId: candidate.artifactId },
      ],
    },
    data: {
      pendingChunkRevision: null,
      pendingChunkTotal: null,
      pendingChunkReceived: null,
      // ISS-8602: the band goes with the marker it describes. Leaving it behind
      // would produce the half-marker `schema.prisma` says cannot exist — a NULL
      // revision beside a live `row_level` band — and the next chunk 0 would
      // then re-stage over a stale record of who the producer was.
      pendingChunkAckContract: null,
    },
  });
  return result.count === 1
    ? PendingChunkClearOutcome.Cleared
    : PendingChunkClearOutcome.Spared;
}

/**
 * One page of the sweep: select, then clear each candidate in its OWN
 * transaction under its OWN session lock.
 *
 * One candidate per transaction rather than one batched `updateMany`: the lock
 * is per session, so a batch would have to hold up to `SESSION_DELETE_BATCH_SIZE`
 * of them at once, and a single contended session would then cost the whole
 * page.
 *
 * ISS-8602 (review: marisolashgrove) — `deadlineAtMs` is what keeps that serial
 * shape inside the drain's ceiling. The page is up to
 * `SESSION_DELETE_BATCH_SIZE` sequential transactions, so a page ENTERED with
 * budget left can still run out mid-way; the caller's ceiling bounded the loop
 * and not the page. Checking the clock before each transaction caps the
 * overshoot at one of them, which `withDb.tx` in turn caps at its 5s default
 * timeout.
 *
 * A deadline stop returns the PARTIAL page rather than throwing: every clear
 * committed in its own transaction, so the rows already repaired are repaired,
 * and `stoppedOnDeadline` is what tells the caller the remainder was never
 * looked at — as opposed to looked at and found clean.
 */
export async function clearOrphanedChunkMarkersBatch(
  cutoff: Date,
  orgId: string | null,
  deadlineAtMs = Number.POSITIVE_INFINITY
): Promise<PendingChunkSweepBatchResult> {
  const candidates = await withDb((db) =>
    selectOrphanedChunkMarkerCandidates(db, cutoff, orgId)
  );
  let cleared = 0;
  let skippedByContention = 0;
  let processed = 0;
  for (const candidate of candidates) {
    // Checked BEFORE the transaction opens, never after: a check on the way out
    // still lets the page start a transaction it cannot afford, which is the
    // overshoot this exists to bound.
    if (Date.now() >= deadlineAtMs) {
      return {
        candidateCount: candidates.length,
        processed,
        cleared,
        skippedByContention,
        stoppedOnDeadline: true,
      };
    }
    const outcome = await withDb.tx((tx) =>
      clearOrphanedChunkMarker(tx, candidate, cutoff, orgId)
    );
    processed += 1;
    if (outcome === PendingChunkClearOutcome.Cleared) {
      cleared += 1;
    } else if (outcome === PendingChunkClearOutcome.Contended) {
      skippedByContention += 1;
    }
  }
  return {
    candidateCount: candidates.length,
    processed,
    cleared,
    skippedByContention,
    stoppedOnDeadline: false,
  };
}

export type PendingChunkSweepBatchResult = {
  /** Rows the selection matched this page. The loop pages on THIS. */
  candidateCount: number;
  /**
   * Candidates this page actually opened a transaction for. Equal to
   * `candidateCount` unless the deadline cut the page short, which is why the
   * no-progress test below reads THIS and not `candidateCount`: an untouched
   * remainder is not a contended one.
   */
  processed: number;
  /** Rows the UPDATE actually changed — the repair count, never the selection. */
  cleared: number;
  /** Candidates another transaction held; left untouched for the next run. */
  skippedByContention: number;
  /** The page stopped on the drain's ceiling with candidates still unvisited. */
  stoppedOnDeadline: boolean;
};

export type PendingChunkSweepResult = {
  summary: string;
  /** ISO timestamp; sequences last written before this are orphans. */
  cutoff: string;
  ttlHours: number;
  cleared: number;
  /**
   * ISS-8602: aged markers this run declined because their producer band is not
   * confirmed row-level. Reported beside `cleared` so the caller can tell "there
   * was nothing to repair" from "there was, and none of it was safe to touch".
   *
   * `null` means NOT MEASURED, never zero — the count runs after the drain, so
   * an errored run reports the repair it managed and no reading for this.
   */
  skippedUnconfirmedAck: number | null;
  exitCode: 0 | 1;
};

export const pendingChunkSweepService = {
  /**
   * ISS-8602: clears the staged chunk-sequence marker on sessions that have
   * received no chunk for `ttlHours`.
   *
   * WHY the orphan is permanent without this. A marker is cleared only by the
   * apply that commits its sequence, so a lost chunk 0 (or a desktop that goes
   * away mid-sequence) leaves one staged forever. That marker then makes the row
   * immortal: `phantomSessionWhere` excludes `pendingChunkRevision != null`
   * because "a chunk in flight is real data mid-arrival, not a phantom", which
   * is right for a live sequence and is exactly what strands an abandoned one.
   *
   * WHY clearing does not destroy a slow-but-real upload. The cleared row is
   * behaviorally identical to one that never staged: a later chunk 0 at an
   * advancing revision still opens (and delete-replaces) its sequence, and one at
   * the committed revision still hits `reopensCommittedSequence`. A late TAIL
   * chunk becomes foreign, which `chunk-revision-gating.ts` defines as a no-op
   * that writes nothing — "the next in-order chunk 0 re-stages the marker and
   * fully repairs the session". Nothing COMMITTED is touched either way — this
   * sweep writes only the four staged columns.
   *
   * "The cost is a re-send" holds for a producer that echoes accepted ids
   * (post-#4862) and is NOT a general claim. For the other band the cost can be
   * the client deleting its own outbox tail, so this sweep does not clear that
   * band at all: {@link orphanedChunkMarkerWhere} selects only markers stamped
   * `row_level`, and residual 2 below records what that settles and what it
   * leaves standing.
   *
   * THE THREE RESIDUALS, so the next reader does not have to re-derive them.
   *   1. Clearing lowers the forward-only floor. `maxRevision` reads
   *      `max(committed, pending)`, so a delayed payload BETWEEN the two, stale
   *      while the marker held, now advances and delete-replaces the abandoned
   *      sequence's partial rows. Those rows were never authoritative — the
   *      cloud commits a revision only from a COMPLETE sequence — so this
   *      settles the session at a complete older snapshot instead of an
   *      indefinite partial one, and a later chunk 0 still advances past it.
   *   2. A build that does not send `wantsAcceptedSessionIds` gets no
   *      per-session ack, and `splitAckedIds`
   *      (`apps/desktop/src/main/agent-sync/agent-session-sync-accepted-ack.ts`)
   *      reads a no-echo 200 as the legacy whole-batch contract: every id acked
   *      and its outbox row DELETED. The omission that protects a current build
   *      from a payload the cloud discarded is therefore absent on such a
   *      client — so if one could deliver a MID-SEQUENCE chunk after this sweep
   *      freed the marker, that chunk would be foreign, written nowhere, and
   *      dropped from the outbox (review: davetho).
   *
   *      RULED 2026-09-11 (Cosimo): gate on the PRODUCER, not on fleet upgrade.
   *      The sweep clears only markers stamped `row_level` and counts the rest,
   *      so the hazard is closed BY CONSTRUCTION rather than by anyone
   *      establishing that a legacy build cannot deliver a mid-sequence chunk.
   *      The evidence suggesting it cannot — the tail is a single in-memory slot
   *      (`agent-session-sync-service.ts`, `pendingChunks`) nulled on ANY batch
   *      failure and gone on restart, so a retry re-fetches and re-chunks from
   *      chunk 0 — did not have to be relied on, and is left here only because
   *      it bounds how much the gate actually costs.
   *
   *      WHAT THE GATE LEAVES STANDING, stated plainly because "never cleared"
   *      is its other failure mode: a declined marker keeps the row out of
   *      `phantomSessionWhere` indefinitely. It is not stranded FOREVER — any
   *      later chunk 0 or unchunked apply for that session re-stages or clears
   *      all four columns, and re-stages the band from the producer sending it,
   *      so a client that upgrades heals its own rows on their next sync. But a
   *      session whose producer never returns keeps its marker, where before
   *      this ruling the sweep would have taken it after 72h. That is the trade
   *      the ruling makes deliberately, and
   *      {@link SessionSyncMetric.OrphanedChunkMarkerSkippedUnconfirmedAck} is
   *      how much of it is standing.
   *   3. The TTL can fire on a device still retrying — see
   *      {@link PENDING_CHUNK_TTL_HOURS}. That is why the freed row
   *      must not go straight to a deleter, which the cron schedule ensures.
   *
   * `exitCode` is 1 when the sweep errored so the cron route can alert and
   * return 500.
   */
  async runPendingChunkSweep(
    now: Date = new Date(),
    ttlHours: number = PENDING_CHUNK_TTL_HOURS,
    orgId: string | null = null
  ): Promise<PendingChunkSweepResult> {
    const cutoff = pendingChunkCutoff(now, ttlHours);
    const drainStartedAtMs = Date.now();
    let cleared = 0;
    let skippedByContention = 0;
    // ISS-8602: `null` is NOT zero here. The count runs after the drain, so an
    // exit that never reached it has not measured the declined population —
    // reporting 0 would say "no markers are being held back", which is the
    // failed-reads-as-healthy collapse this sweep's zero emission exists to
    // avoid, one level in.
    let skippedUnconfirmedAck: number | null = null;
    let incomplete = false;
    try {
      // Terminates because every iteration strictly shrinks the candidate set
      // for this fixed cutoff: a cleared row's marker is now NULL, and a row the
      // recheck spared had its `lastSyncedAt` pushed past the cutoff. A row can
      // only re-enter by staging a NEW sequence, which stamps the anchor at
      // write time and so lands outside the window too.
      //
      // A CONTENDED candidate is the one outcome that shrinks nothing — it was
      // not read, not written, and still matches. So contention is what the
      // termination test has to reckon with, and ISS-8602 (review: marisolashgrove)
      // is about reckoning with it CORRECTLY. Ending the drain on the FIRST
      // contended row capped this sweep at one page — 500 markers a day — any
      // day a single session in page 1 happened to be mid-write, because a live
      // apply holding one row says nothing at all about the other 499. A
      // contended row is expected and transient; treating one as "we are done"
      // was the bug.
      //
      // What actually cannot continue is a page that moved NOTHING out of the
      // candidate set — then the next read returns the identical rows and the
      // loop cannot converge. That is `processed === skippedByContention`, and
      // it reads `processed` rather than `candidateCount` so a deadline-shortened
      // page cannot be mistaken for a fully-contended one.
      //
      // Contention still ends the RUN's report as incomplete (below the loop):
      // it stops being a reason to stop draining without becoming a reason to
      // claim the queue was emptied.
      for (;;) {
        const batch = await clearOrphanedChunkMarkersBatch(
          cutoff,
          orgId,
          drainStartedAtMs + PENDING_CHUNK_SWEEP_TIME_BUDGET_MS
        );
        cleared += batch.cleared;
        skippedByContention += batch.skippedByContention;
        if (
          batch.stoppedOnDeadline ||
          Date.now() - drainStartedAtMs > PENDING_CHUNK_SWEEP_TIME_BUDGET_MS
        ) {
          incomplete = true;
          break;
        }
        if (batch.candidateCount < SESSION_DELETE_BATCH_SIZE) {
          break;
        }
        if (batch.processed === batch.skippedByContention) {
          break;
        }
      }
      // Whatever ended the loop, a candidate another writer held is work this
      // run did not do. Reported so an operator reading `incomplete: false` can
      // take it to mean the queue was actually drained.
      if (skippedByContention > 0) {
        incomplete = true;
      }
      // ISS-8602: AFTER the drain, so a telemetry read can never block the
      // repair it is only describing. The declined population is drain-invariant
      // — those rows are excluded from selection and so are never written — so
      // reading it here measures the same set a pre-drain read would have.
      //
      // Only while the drain left its reserve unspent. See
      // {@link PENDING_CHUNK_COUNT_RESERVE_MS} for why an unguarded read here can
      // cost the whole response, and why `null` is the right answer instead.
      if (hasTimeForUnconfirmedAckCount(drainStartedAtMs)) {
        skippedUnconfirmedAck = await withDb((db) =>
          countUnconfirmedAckMarkers(db, cutoff, orgId)
        );
      }
      return buildSweepResult({
        summary: `Cleared ${cleared} orphaned pending-chunk marker(s) idle > ${ttlHours}h (cutoff ${cutoff.toISOString()})${declinedSuffix(skippedUnconfirmedAck)}${incompleteSuffix(incomplete)}`,
        cutoff,
        ttlHours,
        cleared,
        skippedByContention,
        skippedUnconfirmedAck,
        incomplete,
        exitCode: 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("[sweep-orphaned-chunk-markers] pending chunk sweep failed", {
        error: message,
        ttlHours,
        cutoff: cutoff.toISOString(),
        cleared,
      });
      return buildSweepResult({
        summary: `Pending chunk marker sweep failed after clearing ${cleared} marker(s): ${message}`,
        cutoff,
        ttlHours,
        cleared,
        skippedByContention,
        skippedUnconfirmedAck,
        // An errored drain stopped with work outstanding by definition.
        incomplete: true,
        exitCode: 1,
      });
    }
  },
};

/**
 * Reports the repair on the monitored path before answering, on BOTH the clean
 * and the errored exit — the batches that committed before a later one threw are
 * real repairs and the count would otherwise be lost.
 *
 * Counts what the database changed, never what the selection matched, so a row
 * the recheck spared cannot inflate the signal.
 *
 * Emitted on EVERY run, zero included — the gate `PoisonedWatermarkRepaired`
 * keeps is right for a per-decision counter inside the ingest path and wrong
 * here. This fires once a day, so suppressing the zero makes "nothing was
 * abandoned" and "the cron stopped running" the same no-data read, which is the
 * mistake `data-invariant-metrics.ts` documents.
 */
function buildSweepResult(result: {
  summary: string;
  cutoff: Date;
  ttlHours: number;
  cleared: number;
  skippedByContention: number;
  skippedUnconfirmedAck: number | null;
  incomplete: boolean;
  exitCode: 0 | 1;
}): PendingChunkSweepResult {
  emitTelemetryMetric({
    metric: SessionSyncMetric.OrphanedChunkMarkerCleared,
    count: result.cleared,
    // Candidates an in-flight apply held. Carried so a run that repaired
    // nothing BECAUSE every orphan was busy is distinguishable from one that
    // found nothing to repair — the same failed-reads-as-healthy collapse the
    // zero emission below exists to avoid, one level in.
    skippedByContention: result.skippedByContention,
    // Whether orphans were still outstanding when the drain stopped. Without
    // it a budget-bounded run and a fully drained one read alike, and a backlog
    // that never finishes is invisible for as long as it keeps not finishing.
    incomplete: result.incomplete,
    // Without this the two exits are byte-identical, so a sweep that threw on
    // its first batch and a clean sweep that found nothing both read `count: 0`
    // — the failed-reads-as-healthy collapse the zero emission exists to avoid.
    exitCode: result.exitCode,
    ttlHours: result.ttlHours,
    cutoff: result.cutoff.toISOString(),
  });
  emitUnconfirmedAckCount(result);
  return {
    summary: result.summary,
    cutoff: result.cutoff.toISOString(),
    ttlHours: result.ttlHours,
    cleared: result.cleared,
    skippedUnconfirmedAck: result.skippedUnconfirmedAck,
    exitCode: result.exitCode,
  };
}

/**
 * ISS-8602: reports the markers this run DECLINED to clear — its own metric, not
 * a field on the repair count, because the two describe opposite outcomes for
 * the same candidate and a shared counter would read a declined row as a
 * repaired one.
 *
 * EMITTED ONLY WHEN THE COUNT ACTUALLY RAN. A run that errored before the count
 * has not measured this population, and emitting `count: 0` for it would state
 * "no markers are being held back" on exactly the runs that know least — the
 * fabricated-measurement the root `AGENTS.md` bad-data rule forbids. The absence
 * is readable rather than silent: every run emits
 * {@link SessionSyncMetric.OrphanedChunkMarkerCleared}, so a `cutoff` with that
 * name and not this one is an errored run, and its `exitCode: 1` says so.
 *
 * A measured ZERO is still emitted, on the same terms its sibling keeps: the
 * daily cadence means suppressing it would make "the fleet holds nothing back"
 * and "the cron stopped running" one no-data read.
 */
function emitUnconfirmedAckCount(result: {
  cutoff: Date;
  ttlHours: number;
  skippedUnconfirmedAck: number | null;
  exitCode: 0 | 1;
}): void {
  if (result.skippedUnconfirmedAck === null) {
    return;
  }
  emitTelemetryMetric({
    metric: SessionSyncMetric.OrphanedChunkMarkerSkippedUnconfirmedAck,
    count: result.skippedUnconfirmedAck,
    exitCode: result.exitCode,
    ttlHours: result.ttlHours,
    cutoff: result.cutoff.toISOString(),
  });
}

/**
 * Says so when the drain stopped before it ran out — a contended session, or
 * the time budget. Deliberately NOT "orphans remain": a budget-bounded stop
 * after a full page cannot tell whether one more page would have come back
 * empty, and asserting a backlog it did not observe is the same overstatement
 * in the other direction. Reported rather than alerted, because the next daily
 * run continues and a first-pass backlog is not an incident.
 */
function incompleteSuffix(incomplete: boolean): string {
  return incomplete ? " — incomplete, the drain stopped before it ran out" : "";
}

/**
 * ISS-8602 (review: review-soul): says how many markers the run DECLINED, in the
 * one sentence a human actually reads.
 *
 * The summary is the log message, the 200 body, and the Slack alert, and without
 * this it reports `cleared` alone — so the first runs after deploy, where the
 * migration has backfilled nothing and the whole staged population is therefore
 * declined, answer `Cleared 0 …` in the same bytes as a genuinely empty fleet.
 * That is the distinction the count exists to preserve, discarded in the only
 * channel that is alertable today (the sibling metric is not — see
 * `SessionSyncMetric`).
 *
 * SILENT WHEN UNMEASURED (`null`) and when zero: a run that declined nothing has
 * nothing to report, and a run that could not measure must not imply it did.
 * Both cases are recoverable from the structured log's `skippedUnconfirmedAck`,
 * which distinguishes them.
 */
function declinedSuffix(skippedUnconfirmedAck: number | null): string {
  if (skippedUnconfirmedAck === null || skippedUnconfirmedAck === 0) {
    return "";
  }
  return ` — declined ${skippedUnconfirmedAck} with an unconfirmed producer band`;
}
