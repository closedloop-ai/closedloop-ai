import { DESKTOP_API_PREFIX } from "@repo/api/src/desktop-api-namespace";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { withDb } from "@repo/database";
import {
  type DispatchableCommand,
  IN_FLIGHT_DESKTOP_COMMAND_STATUSES,
  STORED_COMMAND_SELECT,
  toDispatchableCommand,
  toStoredCommand,
} from "@/lib/desktop-command-mappers";
import { MAX_IN_FLIGHT_COMMANDS_CEILING } from "@/lib/desktop-gateway-types";

const DESKTOP_GATEWAY_REQUEST_PAYLOAD_FILTER = {
  path: ["path"],
  string_starts_with: DESKTOP_API_PREFIX,
};

/**
 * The reads the ISS-8453 dispatch drain and its queue-depth sampler need.
 *
 * A sibling of `desktop-command-store` rather than more of it: that module is
 * already over the size the repo tolerates and is shrink-only, and these
 * belong to one concern — deciding which queued work is released next, and how
 * much of it there is — rather than to the store's general command lifecycle.
 */

/**
 * The oldest queued commands for a target, capped.
 *
 * Ordered and capped in SQL. The drain runs on every command completion, so
 * reading a whole backlog to take two off the front would make a deep queue
 * quadratic to drain — which is the shape of the incident this fixes.
 *
 * Deliberately NOT narrowed by gateway path, unlike the capacity count below.
 * Prisma compiles a JSON-path filter to `request_payload#>>ARRAY[$n]::text[]`
 * compared via `LIKE ($n || '%')` — a parameterized path and a pattern built at
 * runtime, so it is unindexable in principle, not for want of an index. Adding
 * one costs the `ORDER BY … LIMIT` pushdown: the planner abandons the
 * `(compute_target_id, status, created_at)` index scan and instead materializes
 * the target's WHOLE queued backlog and top-N sorts it, on every completion.
 * Measured on 1M rows with a 5k backlog: 4 buffers / 0.03ms as the index scan
 * here, against 159 buffers / 4.2ms with the filter — and that gap grows with
 * the backlog, which is exactly the deep queue this function exists to drain.
 * An expression btree, a composite carrying it, and a GIN index were each
 * ignored by the planner, so no migration recovers it.
 *
 * A legacy row therefore survives into a dispatch attempt, which the desktop's
 * cloud command parser refuses before any handler runs — one wasted round trip,
 * on rows no route has been able to create since PLN-677 (2026-05-22) added the
 * `isDesktopApiPath` refinement to `createDesktopCommandValidator`.
 */
export async function listQueuedCommandsForDispatch(
  computeTargetId: string,
  limit: number
): Promise<DispatchableCommand[]> {
  if (limit <= 0) {
    return [];
  }
  const commands = await withDb((db) =>
    db.desktopCommand.findMany({
      where: {
        computeTargetId,
        status: DesktopCommandStatus.Queued,
      },
      orderBy: { createdAt: "asc" },
      // Bounded here as well as by the caller, because `limit` arrives as a
      // plain number on an exported function and the docstring above promises
      // this read is capped in SQL — a promise only a caller-supplied bound
      // would keep. The drain derives its limit from a client-declared ceiling,
      // so an uncapped `take` here turns one hello into a whole-backlog read.
      take: Math.min(limit, MAX_IN_FLIGHT_COMMANDS_CEILING),
      select: STORED_COMMAND_SELECT,
    })
  );
  return commands.map((row) => toDispatchableCommand(toStoredCommand(row)));
}

/**
 * Gateway commands the cloud currently considers in flight on a target.
 *
 * This one keeps the path filter. It has no `LIMIT` to lose, so the predicate
 * costs a heap fetch per row it must visit anyway rather than a plan collapse
 * (measured 1.2ms → 3.1ms over the same 5k rows), and dropping it would count
 * legacy rows a reconnect leaves `accepted` on a desktop whose executor is
 * already gone — a phantom that understates `free` forever, with no path to
 * clear it, since nothing terminalizes those rows.
 */
export async function countInFlightCommandsForDispatch(
  computeTargetId: string
): Promise<number> {
  return await withDb((db) =>
    db.desktopCommand.count({
      where: {
        computeTargetId,
        status: { in: IN_FLIGHT_DESKTOP_COMMAND_STATUSES },
        requestPayload: DESKTOP_GATEWAY_REQUEST_PAYLOAD_FILTER,
      },
    })
  );
}

/**
 * Queued depth per non-sentinel target, fleet-wide, for the queue-depth sampler.
 *
 * BOUNDED BY `limit + 1` ROWS, in the database and not just on the wire
 * (ISS-8674). This read used to `groupBy` `desktop_commands` over the queued
 * rows; Prisma's `take` compiles to a `LIMIT` applied AFTER
 * `GROUP BY … ORDER BY count(*)`, so Postgres aggregated every queued row on
 * every five-minute tick and the cap only discarded the losing groups. It was
 * therefore slowest exactly when the backlog was deepest — the condition it
 * exists to report. It now reads a per-target counter instead, so the tick's
 * cost is a constant rather than a function of the backlog.
 *
 * `compute_targets_queued_depth_idx` — `(queued_command_count DESC, id)
 * WHERE is_cloud_sentinel = false AND queued_command_count > 0` — serves the
 * whole `ORDER BY … LIMIT` with no sort step, so exactly `limit + 1` index
 * entries are visited. Its predicate is also what keeps this a scan of the
 * targets that currently HOLD a backlog rather than of every target ever
 * registered: registration needs only a distinct machine name and no quota, so
 * the target set is attacker-inflatable and never drains, while the set with a
 * live backlog is small and self-draining.
 *
 * THE COUNTER CANNOT DRIFT FROM THE ROWS. Nothing in application code maintains
 * it — the `desktop_commands_queued_count_sync` trigger does, inside the same
 * transaction as every insert, status change and delete, for every writer
 * including raw SQL and an operator's manual repair of a wedged queue. A
 * `CHECK (queued_command_count >= 0)` refuses to persist an under-count. See
 * migration 20260901120000_iss8674_queued_command_count for why a trigger
 * rather than the five application write paths, and for the one-statement
 * repair if it ever does drift.
 *
 * Cloud sentinels are excluded, matching `listQueueDepthSweepPage`. They
 * run no executor, but nothing stops one being the `computeTargetId` of a
 * queued row, so without this predicate sentinel work would be gauged, warned
 * on, and able to hold one of the caller's deepest-backlog slots against a real
 * desktop. It is now a column on the row being read rather than a join.
 *
 * Targets holding no queued command are absent rather than zero — the `gt: 0`
 * predicate's whole point — the sweep page below is what turns that absence
 * into a measured value for the target.
 *
 * Deepest-first, capped, with one probe row past the cap, and unchanged by
 * ISS-8674. That shape is this read's alone: `listQueueDepthSweepPage` orders
 * by the rotation key and takes exactly its limit, because what lies past IT is
 * reported as a count rather than inferred from a probe. Ordering and
 * limiting in SQL rather than in the caller means the targets past the cap are
 * never returned at all, and the ones that survive are the deep backlogs an
 * operator can act on. `id` ascending breaks ties so a burst of freshly
 * registered targets sorts to the tail the cap drops rather than displacing the
 * fleet already being sampled. The probe row is what lets the caller tell a
 * capped read from a fleet that happens to be exactly that size; without it an
 * exactly-full result is indistinguishable from a complete one.
 */
export async function countQueuedCommandsByTarget(
  limit: number
): Promise<TargetBacklogPage> {
  const rows = await withDb((db) =>
    db.computeTarget.findMany({
      where: { isCloudSentinel: false, queuedCommandCount: { gt: 0 } },
      select: { id: true, queuedCommandCount: true },
      orderBy: [{ queuedCommandCount: "desc" }, { id: "asc" }],
      take: limit + 1,
    })
  );
  return {
    backlogs: rows.slice(0, limit).map((row) => ({
      computeTargetId: row.id,
      queuedCount: row.queuedCommandCount,
    })),
    hasMore: rows.length > limit,
  };
}

/**
 * The next page of the fleet's completeness sweep, least-recently-swept first.
 *
 * WHY A ROTATION AND NOT PRIMARY-KEY ORDER (ISS-8674). This read used to page
 * the fleet by `id` ascending, which is stable — so past `MAX_SAMPLED_TARGETS`
 * the SAME tail was dropped on every tick, forever. Ordering by
 * `queuedDepthSweptAt` and stamping what was gauged makes the cap a DEFERRAL
 * instead of a discard: every target is swept before any target is swept twice,
 * so a bounded per-tick page still covers the whole fleet over a bounded number
 * of ticks. A newly registered target carries the epoch default and therefore
 * sorts to the HEAD, gauged on the next tick rather than after a full cycle.
 *
 * Served by `compute_targets_queued_depth_sweep_idx`, so the page is an index
 * scan of exactly `limit + 1` entries rather than a sort of every target ever
 * registered — the set that never drains, because registering one costs an
 * authenticated user nothing but a distinct machine name.
 *
 * It returns each target's REAL depth, not just its id. That is what lets the
 * caller emit a measured value for every target it gauges. The previous shape
 * returned ids alone and the caller filled in a zero for anything absent from
 * the backlog page — which was a FALSE ZERO for any target holding a backlog
 * that the backlog page's own cap had dropped.
 *
 * Cloud sentinels are excluded, matching every other fleet-scoped read here:
 * they run no executor, so a queued row on one can never be taken.
 */
export async function listQueueDepthSweepPage(
  limit: number
): Promise<TargetBacklog[]> {
  const targets = await withDb((db) =>
    db.computeTarget.findMany({
      where: { isCloudSentinel: false },
      select: { id: true, queuedCommandCount: true },
      orderBy: [{ queuedDepthSweptAt: "asc" }, { id: "asc" }],
      take: limit,
    })
  );
  return targets.map((target) => ({
    computeTargetId: target.id,
    queuedCount: target.queuedCommandCount,
  }));
}

/**
 * Records that these targets were gauged, moving them to the back of the
 * rotation.
 *
 * Stamped for the ROTATION's targets, not for everything the tick gauged. A
 * target the deepest-backlog page named is gauged every tick, so stamping it
 * would keep its key permanently fresh and pin it at the rotation's tail —
 * where it would never come up for the reconciliation sample, leaving the
 * counters most likely to be lying as the ones never checked.
 *
 * RAW SQL, and that is not an optimization. `ComputeTarget.updatedAt` is
 * `@updatedAt`, which Prisma rewrites on every `update`/`updateMany` whatever
 * the `data` names — and `listByOwner` and `listAvailableForOrg` both order the
 * user's compute-target lists by `updatedAt DESC`. Stamping 500 targets every
 * five minutes through Prisma would therefore reshuffle that list on a rolling
 * basis until an idle target outranked one the user actually used, purely from
 * internal rotation bookkeeping. This writes the one column and leaves
 * `updated_at` alone.
 *
 * Touches `compute_targets` alone, so it cannot join a lock cycle with the
 * command write path, which takes a `desktop_commands` row first and its target
 * second.
 */
export async function markQueueDepthSwept(
  computeTargetIds: string[],
  sweptAt: Date
): Promise<number> {
  if (computeTargetIds.length === 0) {
    return 0;
  }
  return await withDb(
    (db) =>
      db.$executeRaw`
        UPDATE "compute_targets"
        SET "queued_depth_swept_at" = ${sweptAt}
        WHERE "id" = ANY(${computeTargetIds}::uuid[])
      `
  );
}

/**
 * How many non-sentinel targets have not been gauged since `cycleStart`.
 *
 * The sweep's honesty check, and the reason the summary can report progress as
 * a NUMBER rather than a boolean: a tick that covered part of the fleet says
 * how much is still owed instead of implying it saw everything. Counted over
 * the same partial index the sweep page reads, so it is a range scan bounded by
 * the targets actually behind, not by the fleet.
 */
export async function countTargetsAwaitingSweep(
  cycleStart: Date
): Promise<number> {
  return await withDb((db) =>
    db.computeTarget.count({
      where: { isCloudSentinel: false, queuedDepthSweptAt: { lt: cycleStart } },
    })
  );
}

/**
 * Each target's counter beside its real queued rows, for a BOUNDED set of ids.
 *
 * The counter is maintained by a trigger in the same transaction as every
 * command write, so it cannot drift while that holds. Nothing would tell us if
 * it stopped holding — a bad migration, a disabled trigger, a restore from a
 * dump taken with `--disable-triggers` — and an over-count renders as a phantom
 * backlog that never clears, which is a more authoritative lie than the visible
 * cap Option A was chosen to avoid.
 *
 * `CHECK (queued_command_count >= 0)` already makes an under-count below zero
 * unpersistable. This is the other direction, and it is why the check is exact
 * rather than a cheaper "does any queued row exist" probe: a counter of 5
 * against 3 real rows is drift the probe would call healthy.
 *
 * ONE STATEMENT, so both numbers come from ONE snapshot. Reading the counter
 * earlier in the tick and the rows later would make every command enqueued or
 * acked in between look like drift — a warn naming a healthy target, and worst
 * on the busiest ones, which is how a detector gets ignored. Raw SQL because
 * Prisma cannot express the LEFT JOIN aggregate that keeps the pair atomic;
 * `LEFT JOIN` and `count(dc.id)` rather than `count(*)` so a target with no
 * queued rows returns a real 0 instead of dropping out of the result — that
 * absence is exactly the phantom-backlog case this exists to catch.
 *
 * COST IS THE CALLER'S TO BOUND. It aggregates the queued rows of the targets
 * it is given, over `desktop_commands_queued_by_target_idx`, so it costs the
 * sum of THEIR backlogs — bounded by `ids.length` times the deepest backlog,
 * and by nothing else. Hand it a small constant slice; handing it the whole
 * fleet reinstates exactly the unbounded per-tick aggregate ISS-8674 removed.
 */
export async function reconcileQueuedCounters(
  computeTargetIds: string[]
): Promise<CounterReconciliation[]> {
  if (computeTargetIds.length === 0) {
    return [];
  }
  const rows = await withDb(
    (db) =>
      db.$queryRaw<
        { computeTargetId: string; counter: number; actual: number }[]
      >`
        SELECT ct."id" AS "computeTargetId",
               ct."queued_command_count" AS "counter",
               count(dc."id")::int AS "actual"
        FROM "compute_targets" ct
        LEFT JOIN "desktop_commands" dc
          ON dc."compute_target_id" = ct."id"
         AND dc."status" = ${DesktopCommandStatus.Queued}
        WHERE ct."id" = ANY(${computeTargetIds}::uuid[])
        GROUP BY ct."id", ct."queued_command_count"
      `
  );
  return rows.map((row) => ({
    computeTargetId: row.computeTargetId,
    counter: row.counter,
    actualQueuedRows: row.actual,
  }));
}

/**
 * How recently each of the given targets was heard from, ON ANY TRANSPORT, for
 * the ack-timeout sweep.
 *
 * `lastSeenAt` and not `presenceAt` (ISS-8897), because this caller asks a
 * different question from the idle drain's: whether the desktop is silent at
 * all, which is what explains an unacked command. A target checking in over the
 * direct Socket.IO server is NOT silent, even though the relay presence trigger
 * is not running for it. The idle drain used to share
 * this read and now has its own, `listIdleDrainCandidates` below, because
 * conflating the two clocks is what made it skip targets nothing was draining.
 *
 * ONE query over an already-capped id list, never a lookup per target: its
 * caller runs every five minutes and the id list comes from a bounded page of
 * attacker-inflatable rows, so a per-target read here would put the fleet size
 * into a cron tick's query count.
 *
 * Targets absent from the result were deleted between the two reads. The caller
 * treats that as "do not dispatch" rather than as silence of zero, because a
 * missing row is not a target that was just seen.
 */
export async function listComputeTargetLastSeen(
  computeTargetIds: string[]
): Promise<Map<string, Date>> {
  if (computeTargetIds.length === 0) {
    return new Map();
  }
  const targets = await withDb((db) =>
    db.computeTarget.findMany({
      where: { id: { in: computeTargetIds } },
      select: { id: true, lastSeenAt: true },
    })
  );
  return new Map(targets.map((target) => [target.id, target.lastSeenAt]));
}

/**
 * Returns commands the cloud believes are on a desktop back to `queued`.
 *
 * A reconnect means the desktop's in-memory executor is gone, so an `accepted`
 * or `running` row that handshake does NOT redeliver is in flight nowhere — it
 * is queued, and recording that is what lets the drain find it again. Without
 * this a capped reconnect strands every command it held back.
 *
 * Scoped to non-terminal rows so a command that finished between the flush and
 * this write is never resurrected.
 *
 * The `IN` list is NOT bounded by the hello cap. Its one caller slices it from
 * the hello's pending-command read, whose QUEUED half is capped at
 * `HELLO_QUEUED_COMMAND_LIMIT` — but that read deliberately returns every
 * `accepted`/`running` row uncapped, so what actually bounds this list is the
 * target's in-flight count, and nothing terminalizes a row stranded in flight.
 *
 * So the list is bounded HERE, by chunking. Not by a cap that drops ids: this
 * write is what records that a withheld row is in flight nowhere, so ids past a
 * limit would strand exactly the rows it exists to rescue, understating every
 * later `free` with nothing on the wire saying why. Chunking keeps every id and
 * only stops one `IN` predicate growing without bound; the chunks are written
 * sequentially so a deep backlog cannot fan out into the connection pool.
 */
export async function requeueUndeliveredCommands(
  computeTargetId: string,
  commandIds: string[]
): Promise<number> {
  const requeuedAt = new Date();
  let requeued = 0;
  for (
    let start = 0;
    start < commandIds.length;
    start += REQUEUE_ID_CHUNK_SIZE
  ) {
    const chunk = commandIds.slice(start, start + REQUEUE_ID_CHUNK_SIZE);
    const { count } = await withDb((db) =>
      db.desktopCommand.updateMany({
        where: {
          computeTargetId,
          id: { in: chunk },
          status: { in: IN_FLIGHT_DESKTOP_COMMAND_STATUSES },
        },
        data: { status: DesktopCommandStatus.Queued, queuedAt: requeuedAt },
      })
    );
    requeued += count;
  }
  return requeued;
}

/**
 * One target's counter beside its real queued rows, read together.
 *
 * The pair is a single type because the two numbers are only meaningful when
 * they come from the same snapshot — split across two reads, their difference
 * is as likely to be elapsed time as drift.
 */
export type CounterReconciliation = {
  computeTargetId: string;
  counter: number;
  actualQueuedRows: number;
};

/** One target's queued depth, as the backlog read returns it. */
export type TargetBacklog = {
  computeTargetId: string;
  queuedCount: number;
};

/**
 * The bounded backlog page a sampler reads, plus whether more targets exist.
 *
 * The accounting signal a capped read owes its caller: an
 * exactly-full page proves nothing about what lies past it, so `backlogs.length`
 * alone can neither report truncation nor stand in for a fleet total. When
 * `hasMore` is true, `backlogs.length` is a floor on the targets with a backlog,
 * not the count of them.
 */
export type TargetBacklogPage = {
  backlogs: TargetBacklog[];
  hasMore: boolean;
};

/**
 * Ids per `requeueUndeliveredCommands` write.
 *
 * A value, not a cap: every chunk is written, so no id is dropped. It exists
 * only so one `id: { in: [...] }` predicate cannot grow with a target's
 * in-flight backlog — past a few thousand ids that is a bind-parameter list and
 * a query plan that scale with the backlog, on the write whose whole job is to
 * rescue it.
 */
const REQUEUE_ID_CHUNK_SIZE = 500;

/**
 * One still-queued command that has just crossed its ack deadline.
 *
 * `createdAt` rides along because the sweep reports how long the command waited,
 * and re-deriving that from the window bounds would report the window rather
 * than the command.
 */
export type UnackedCommand = {
  commandId: string;
  computeTargetId: string;
  queuedAt: Date;
  /**
   * When the target last ANSWERED this command, or `null` if it never has.
   * Read against `queuedAt` — see `wasAnsweredOnEarlierDelivery` — to tell a
   * command that was never taken from one that was acked, requeued, and is now
   * outstanding again.
   */
  ackedAt: Date | null;
};

/** A bounded page of ack-deadline crossings, plus whether the cap bit. */
export type UnackedCommandPage = {
  commands: UnackedCommand[];
  cursor: UnackedCommandCursor | undefined;
};

/** Keyset position in the `(queuedAt, id)` ordering, for resuming a band. */
export type UnackedCommandCursor = {
  queuedAt: Date;
  id: string;
};

/**
 * Commands still `queued` whose age has just entered `[olderThanMs, youngerThanMs)`.
 *
 * A HALF-OPEN AGE BAND, not "older than the deadline", and that is the whole
 * design. A command that stays queued is still queued on the next tick, so an
 * open-ended predicate would re-report the same command every five minutes and
 * turn a count of 595 distinct silent commands into an unbounded multiple of it
 * — a confidently wrong number, which is worse than the missing one this ticket
 * exists to fix. Bounding the far side reports each crossing once.
 *
 * `now` is a TICK BOUNDARY, not the invocation instant, and the caller is
 * responsible for snapping it. Cron delay varies per firing, so bands anchored
 * to raw wall-clock overlap by `(delay1 - delay2)` whenever a firing is less
 * delayed than the one before it, and every command in the overlap is reported
 * twice. Snapping makes consecutive bands abut exactly. What snapping cannot fix
 * is a scheduler that fires twice inside one bucket (repeats that band) or skips
 * a bucket (loses it), so the result is a close bound rather than a census —
 * with no persisted watermark, exactly-once is not available here.
 *
 * BANDED ON `queuedAt`, NOT `createdAt`, so the population really is "has been
 * waiting this long for an ack". `requeueUndeliveredCommands` returns a row to
 * `queued` on reconnect, and banding on `createdAt` — which that write does not
 * touch — reported `timed_out` for a command whose ack HAD arrived, since
 * reaching `accepted` requires one. The same blind spot ran the other way: a
 * requeued command whose REDELIVERY genuinely went unacked was never looked at,
 * because its `createdAt` had already aged past the far edge of the band. The
 * requeue now stamps `queuedAt`, so each queue entry is measured from its own
 * start. What this still does not carry is an ack COUNT — a command acked, then
 * requeued, then genuinely unacked on the second delivery is reported once, for
 * the delivery that actually lost its ack, which is the intended reading.
 *
 * Served by `desktop_commands_queued_at_idx` — `(queued_at, id)
 * WHERE status = 'queued'`. Leading on `queued_at` makes the band a range seek
 * that stops at the far bound, and carrying `id` matches the tiebreak so the
 * ordering costs no sort; the `take` then stops the scan early.
 *
 * That index is not an optimization, it is what makes the read affordable.
 * Measured on 200k queued rows, the pre-index shape did NOT fall back to the
 * partial `desktop_commands_queued_by_target_idx` as expected — the planner
 * chose a Parallel Seq Scan of the whole table plus a Sort, 3285 shared buffers
 * and 24.9ms, and both grow with the table rather than the band. The same query
 * on this index is an Index Scan: 15 buffers, 0.14ms. A partial index keyed on
 * `compute_target_id` alone cannot serve a fleet-wide read that supplies no
 * target, and Postgres does not treat its predicate as a cheap enough entry
 * point to bother.
 */
export async function listCommandsCrossingAckDeadline(input: {
  now: Date;
  olderThanMs: number;
  youngerThanMs: number;
  limit: number;
  after?: UnackedCommandCursor;
}): Promise<UnackedCommandPage> {
  if (input.limit <= 0 || input.youngerThanMs <= input.olderThanMs) {
    return { commands: [], cursor: undefined };
  }
  const nowMs = input.now.getTime();
  const bandStart = new Date(nowMs - input.youngerThanMs);
  const bandEnd = new Date(nowMs - input.olderThanMs);
  const rows = await withDb((db) =>
    db.desktopCommand.findMany({
      where: {
        status: DesktopCommandStatus.Queued,
        queuedAt: { gt: bandStart, lte: bandEnd },
        // Keyset rather than OFFSET: the band is walked forward along
        // `desktop_commands_queued_at_idx`, so resuming costs a seek rather
        // than re-reading and discarding every row already reported.
        ...(input.after
          ? {
              OR: [
                { queuedAt: { gt: input.after.queuedAt, lte: bandEnd } },
                { queuedAt: input.after.queuedAt, id: { gt: input.after.id } },
              ],
            }
          : {}),
        // Sentinels run no executor, so a queued row on one can never be taken
        // and no ack for it was ever possible. Counting it as a lost ack would
        // put a command that was never dispatchable in a bucket whose whole
        // purpose is to size real losses — and the cause split would then guess
        // `target_present` off the sentinel's own `lastSeenAt`. Matches every
        // other fleet-scoped read here.
        computeTarget: { isCloudSentinel: false },
      },
      orderBy: [{ queuedAt: "asc" }, { id: "asc" }],
      // One past the page, so an exactly-full page is distinguishable from a
      // band that happens to hold exactly this many crossings.
      take: input.limit + 1,
      // `ackedAt` is projected, never filtered on: the band predicate is
      // unchanged, so this rides the same `desktop_commands_queued_at_idx` seek
      // and needs no index of its own.
      select: {
        id: true,
        computeTargetId: true,
        queuedAt: true,
        ackedAt: true,
      },
    })
  );
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    commands: page.map((row) => ({
      commandId: row.id,
      computeTargetId: row.computeTargetId,
      ackedAt: row.ackedAt,
      // Non-null in practice: the predicate selects on `queuedAt`, so a NULL
      // row cannot match. Narrowed rather than asserted, because the column is
      // nullable for the terminal rows this read never sees.
      queuedAt: row.queuedAt ?? bandEnd,
    })),
    cursor:
      rows.length > input.limit && last?.queuedAt
        ? { queuedAt: last.queuedAt, id: last.id }
        : undefined,
  };
}

/**
 * In-flight command counts for a bounded set of targets, in one grouped read.
 *
 * The per-target `countInFlightCommandsForDispatch` above answers the same
 * question for the drain, which only ever asks about the one target it is
 * draining. The ack-timeout sweep asks about every target in its page at once,
 * so asking through that helper would be a query per target on a path whose
 * page is deliberately allowed to be large.
 *
 * A target absent from the returned map has no in-flight rows; it is not
 * missing data, because the grouped read covers every id passed in.
 *
 * It keeps `DESKTOP_GATEWAY_REQUEST_PAYLOAD_FILTER` for the same reason the
 * per-target count does, and the reason is load-bearing HERE too: without it,
 * the legacy rows a reconnect strands `accepted` on a desktop whose executor is
 * already gone are counted as in-flight work, and nothing ever terminalizes
 * them. The consumer folds `> 0` to `target_busy`, so one permanent phantom row
 * would bucket EVERY later lost ack on that target as ordinary queueing — the
 * `target_present` half this ticket exists to size, silently emptied.
 */
export async function countInFlightCommandsByTarget(
  computeTargetIds: string[]
): Promise<Map<string, number>> {
  if (computeTargetIds.length === 0) {
    return new Map();
  }
  const groups = await withDb((db) =>
    db.desktopCommand.groupBy({
      by: ["computeTargetId"],
      where: {
        computeTargetId: { in: computeTargetIds },
        status: { in: IN_FLIGHT_DESKTOP_COMMAND_STATUSES },
        requestPayload: DESKTOP_GATEWAY_REQUEST_PAYLOAD_FILTER,
      },
      _count: { _all: true },
    })
  );
  return new Map(
    groups.map((group) => [group.computeTargetId, group._count._all])
  );
}

/**
 * The idle drain's candidate page, bounded AFTER the presence filter.
 *
 * ISS-8895 finding 1 (whitlockk, PR #6459). The drain used to take the deepest 100
 * backlogs and only then discard the targets the presence trigger already owns,
 * so the page size bounded the wrong set: a fleet of connected, busy desktops
 * filled all 100 slots with targets the drain then refused, and the
 * disconnected ones it exists for never reached it. The filter is now in the
 * same statement as the cap, so 100 candidates means 100 targets this sweep can
 * actually act on.
 *
 * ISS-8895 finding 2 is NOT here: `countQueuedCommandsByTarget` above stopped
 * aggregating `desktop_commands` when ISS-8674 (#6414) moved it onto the
 * trigger-maintained `queued_command_count` column, so the group-by the finding
 * asked to bound no longer exists. This read inherits that column and the same
 * `compute_targets_queued_depth_idx`.
 *
 * WHAT IS DELIBERATELY NOT FILTERED HERE: the give-up horizon. Pushing it into
 * SQL is the obvious next step and it would permanently zero `targetsGivenUp`,
 * the counter ISS-8686 added precisely because a stranded target and a
 * presence-covered one both read as `targetsDue: 0`. Stranded targets are the
 * MOST silent, so they survive the cutoff below and are counted by the caller.
 * Do not "finish the job" by adding a give-up predicate.
 *
 * ORDER AND COST. Deepest-first with `id` breaking ties, served by
 * `compute_targets_queued_depth_idx` — the same partial index
 * (`WHERE is_cloud_sentinel = false AND queued_command_count > 0`) the sampler
 * reads. The presence predicate is a filter over that scan rather than part of
 * the key, so a tick stops at `limit + 1` matching rows but, when fewer than
 * that match, walks the whole partial index. Its ceiling is the number of
 * targets currently HOLDING a backlog — the set the old shape already paged and
 * then threw most of away in JS — not the target table, which registration
 * makes attacker-inflatable and which never drains.
 *
 * `presenceAt IS NULL` is INCLUDED, not excluded: null means the relay presence
 * trigger has never covered this target, which is the strongest reason to drain
 * it rather than a reason to skip it. `createdAt` rides along so the caller can
 * measure that target's silence from a real clock instead of inventing one.
 *
 * `lte`, NOT `lt`, and the boundary is load-bearing (davetho, PR #7119). The
 * caller passes `now - IDLE_DRAIN_MIN_SILENCE_MS`, so `lt` admitted only
 * `silentMs > IDLE_DRAIN_MIN_SILENCE_MS` while `retryStrideTicks` calls
 * everything from `silentMs >= IDLE_DRAIN_MIN_SILENCE_MS` due: a target exactly
 * on the cutoff was eligible by the ladder and absent from the page, and waited
 * out another tick. The ladder is the canonical reading — the constant is the
 * silence BELOW which the presence trigger owns a target — so this predicate
 * moved to match it, and the two now admit the same instant.
 */
export async function listIdleDrainCandidates(
  limit: number,
  presentSince: Date
): Promise<IdleDrainCandidatePage> {
  const rows = await withDb((db) =>
    db.computeTarget.findMany({
      where: {
        isCloudSentinel: false,
        queuedCommandCount: { gt: 0 },
        OR: [{ presenceAt: null }, { presenceAt: { lte: presentSince } }],
      },
      select: { id: true, presenceAt: true, createdAt: true },
      orderBy: [{ queuedCommandCount: "desc" }, { id: "asc" }],
      take: limit + 1,
    })
  );
  return {
    candidates: rows.slice(0, limit).map((row) => ({
      computeTargetId: row.id,
      presenceAt: row.presenceAt,
      createdAt: row.createdAt,
    })),
    hasMore: rows.length > limit,
  };
}

/**
 * Takes the fleet-wide release lease for one target, or reports that another
 * holder has it.
 *
 * ISS-8896 (davetho, PR #6459). `releaseQueuedCommands` reads a ceiling,
 * counts what is in flight and dispatches the difference; that read-modify-write
 * was serialized only by a process-local map, so every API instance passed its
 * own gate and each dispatched a full `ceiling - inFlight` against one ceiling.
 * A gate two instances can both pass is not a gate.
 *
 * ONE conditional UPDATE, never findFirst-then-write. Under READ COMMITTED the
 * loser of a race blocks on the row lock, re-evaluates this predicate against
 * the winner's committed row, finds the lease no longer expired and updates
 * zero rows — so exactly one caller sees a count of 1 whatever the interleaving.
 * Decomposing it into a read and a write would restore the race one layer down.
 *
 * Raw SQL for the same reason as `markQueueDepthSwept` above: `updatedAt` is
 * `@updatedAt`, so any Prisma write rewrites it whatever `data` names, and the
 * user's compute-target lists order by `updatedAt DESC`.
 *
 * Expiry rather than a held lock, because the holder is a serverless invocation
 * that can vanish: a crashed release must not own a target forever.
 *
 * THE EXPIRY IS THE DATABASE'S CLOCK, NOT THE CALLER'S (whitlockk, PR #7119). A
 * caller-computed `now + ttl` is sampled BEFORE the statement's own connection
 * acquisition, which `DB_POOL_ACQUIRE_TIMEOUT_MS` bounds at 30s — twice the
 * TTL — so a claim taken through a stalled pool used to persist an expiry that
 * was already in the past, and the holder went on to dispatch believing it
 * owned a lease no concurrent acquire would even see. Evaluating `now()` at
 * execution time makes the window start when the row is actually written, and
 * removes clock skew between two serverless instances from the comparison in
 * the `WHERE` as well.
 *
 * `AT TIME ZONE 'UTC'` because the column is `TIMESTAMP(3)` without a zone and
 * Prisma reads and writes it as UTC; a bare `now()` is `timestamptz` and would
 * be cast using the session's `TimeZone`.
 *
 * Returns the written expiry, which is this holder's ownership token for
 * `renewCommandDrainLease` and `releaseCommandDrainLease`, or null when another
 * holder has the target.
 */
export async function acquireCommandDrainLease(
  computeTargetId: string,
  ttlMs: number
): Promise<Date | null> {
  const rows = await withDb(
    (db) =>
      db.$queryRaw<{ leaseUntil: Date }[]>`
        UPDATE "compute_targets"
        SET "command_drain_lease_until" =
          (now() AT TIME ZONE 'UTC')
          + make_interval(secs => ${ttlMs / 1000}::double precision)
        WHERE "id" = ${computeTargetId}::uuid
          AND (
            "command_drain_lease_until" IS NULL
            OR "command_drain_lease_until" <= (now() AT TIME ZONE 'UTC')
          )
        RETURNING "command_drain_lease_until" AS "leaseUntil"
      `
  );
  return rows.length === 1 ? rows[0].leaseUntil : null;
}

/**
 * Re-asserts an existing claim and starts the TTL again, or reports that the
 * target has moved on.
 *
 * whitlockk, PR #7119. The lease TTL (15s) is shorter than the bound on ONE of the
 * reads it wraps: `countInFlightCommandsForDispatch` and
 * `listQueuedCommandsForDispatch` each take a pooled connection, and a wait for
 * one is bounded by `DB_POOL_ACQUIRE_TIMEOUT_MS` at 30s — per acquisition, so
 * the read window alone can reach 60s against a 15s lease. A holder could
 * therefore finish those reads after another instance had legitimately claimed
 * the target, and both would dispatch against the same ceiling: exactly the
 * `N x ceiling` the lease exists to stop, only now with the lease in place.
 *
 * OWNERSHIP-SCOPED on the expiry this holder currently holds, for the same
 * reason the release below is: a holder that overran must not extend, or free,
 * a lease that now belongs to someone else. A null return is the refusal that
 * keeps the second dispatcher out.
 */
export async function renewCommandDrainLease(
  computeTargetId: string,
  heldUntil: Date,
  ttlMs: number
): Promise<Date | null> {
  const rows = await withDb(
    (db) =>
      db.$queryRaw<{ leaseUntil: Date }[]>`
        UPDATE "compute_targets"
        SET "command_drain_lease_until" =
          (now() AT TIME ZONE 'UTC')
          + make_interval(secs => ${ttlMs / 1000}::double precision)
        WHERE "id" = ${computeTargetId}::uuid
          AND "command_drain_lease_until" = ${heldUntil}
        RETURNING "command_drain_lease_until" AS "leaseUntil"
      `
  );
  return rows.length === 1 ? rows[0].leaseUntil : null;
}

/**
 * Hands the lease back early, so the next legitimate trigger does not wait out
 * the TTL.
 *
 * OWNERSHIP-SCOPED by the exact expiry this holder wrote. An unconditional
 * clear would let a release that already overran its TTL — and whose target a
 * newer holder has since claimed — free the newer lease, reopening the very
 * concurrent dispatch the lease exists to stop. Two holders cannot write the
 * same expiry for one target, because only one acquire succeeds per window.
 *
 * Pass the LATEST token: a `renewCommandDrainLease` replaces the expiry, so a
 * release quoting the acquire's original value matches nothing and leaves the
 * target locked out for a full TTL after a drain that in fact finished.
 */
export async function releaseCommandDrainLease(
  computeTargetId: string,
  heldUntil: Date
): Promise<void> {
  await withDb(
    (db) =>
      db.$executeRaw`
        UPDATE "compute_targets"
        SET "command_drain_lease_until" = NULL
        WHERE "id" = ${computeTargetId}::uuid
          AND "command_drain_lease_until" = ${heldUntil}
      `
  );
}

/**
 * One backlogged target the presence trigger is not covering.
 *
 * `presenceAt` is null when no relay presence frame has ever been observed for
 * it; `createdAt` is then the caller's clock, because a target cannot have been
 * present before it existed.
 */
export type IdleDrainCandidate = {
  computeTargetId: string;
  presenceAt: Date | null;
  createdAt: Date;
};

export type IdleDrainCandidatePage = {
  candidates: IdleDrainCandidate[];
  hasMore: boolean;
};
