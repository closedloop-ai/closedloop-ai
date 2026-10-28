import {
  classifyDesktopCommandAckTimeout,
  DESKTOP_COMMAND_ACK_DEADLINE_MS,
  DesktopCommandAckOutcome,
  DesktopCommandAckTimeoutCause,
} from "@repo/api/src/types/desktop-command-ack";
import { log } from "@repo/observability/log";
import {
  countInFlightCommandsByTarget,
  listCommandsCrossingAckDeadline,
  listComputeTargetLastSeen,
  type UnackedCommand,
  type UnackedCommandCursor,
} from "@/lib/desktop-command-dispatch-queries";

/** The message `relay.command_acks` must match to count a timed-out ack. */
export const ACK_TIMEOUT_LOG_MESSAGE = "Relay command ack timed out";

/**
 * The message that says a tick's counts are a floor rather than the band.
 *
 * Its own message, and an `error` rather than a `warn`, because what it reports
 * is not a timed-out command — it is the sweep giving up mid-band, after which
 * those crossings are gone for good: the band's far edge has moved by the next
 * tick and nothing looks at them again. The route's `sweep complete` line does
 * carry `truncated`, but that message sits outside the filter the ack metric is
 * built on, so the metric could never see its own source going short. Kept OFF
 * the metric's filter deliberately, so it cannot be miscounted as one more
 * timed-out command; the Datadog change below adds it as a monitor instead.
 */
export const ACK_TIMEOUT_TRUNCATED_LOG_MESSAGE =
  "Relay command ack timeout sweep truncated";

/**
 * The cron cadence, restated so the deadline band below reads in minutes.
 *
 * MUST match the entry in `apps/api/vercel.json`. The band is exactly one tick
 * wide, so a drift between the two silently makes the sweep skip commands (band
 * narrower than the interval) or double-count them (band wider) — a pinning test
 * holds them together.
 */
export const ACK_TIMEOUT_TICK_MS = 5 * 60 * 1000;

/** Crossings read per database round trip while walking a band. */
export const ACK_TIMEOUT_PAGE_SIZE = 500;

/**
 * Crossings reported per tick, across all pages.
 *
 * A cap on LOG VOLUME, not on the sweep's accuracy, and deliberately an order of
 * magnitude past the observed ~600/day fleet-wide population. It used to be the
 * single page size, which made it an accuracy cap too: the band is half-open and
 * its far edge has moved by the next tick, so a crossing past the cap was not
 * deferred, it was lost — and a signal vanishing without a name is the exact
 * defect this sweep exists to end. The band is now walked to exhaustion and this
 * only bounds a pathological tick, which reports itself on
 * `ACK_TIMEOUT_TRUNCATED_LOG_MESSAGE` rather than passing a floor off as a band.
 */
export const ACK_TIMEOUT_MAX_PER_TICK = 5000;

/**
 * Reports commands that just crossed the ack deadline still unacked.
 *
 * Three bounded reads per tick — the age-band page, one `lastSeenAt` lookup over
 * the targets it named, and one grouped in-flight count over the same ids. Never
 * a query per command or per fleet member.
 */
export async function sweepUnackedCommands(
  now: Date = new Date()
): Promise<AckTimeoutSweepSummary> {
  // Snapped to the tick grid before it reaches the band, the same way the idle
  // drain buckets its strides. Anchoring to the raw invocation instant lets two
  // firings whose cron delays differ cover overlapping queuedAt intervals, and
  // every command in the overlap is then reported twice.
  const tickStart = new Date(
    Math.floor(now.getTime() / ACK_TIMEOUT_TICK_MS) * ACK_TIMEOUT_TICK_MS
  );
  const byCause = emptyCauseTally();
  let timedOut = 0;
  let after: UnackedCommandCursor | undefined;

  while (timedOut < ACK_TIMEOUT_MAX_PER_TICK) {
    const page = await listCommandsCrossingAckDeadline({
      now: tickStart,
      olderThanMs: DESKTOP_COMMAND_ACK_DEADLINE_MS,
      youngerThanMs: DESKTOP_COMMAND_ACK_DEADLINE_MS + ACK_TIMEOUT_TICK_MS,
      limit: Math.min(
        ACK_TIMEOUT_PAGE_SIZE,
        ACK_TIMEOUT_MAX_PER_TICK - timedOut
      ),
      ...(after ? { after } : {}),
    });
    timedOut += await reportCrossings(page.commands, now, byCause);
    if (!page.cursor) {
      return { timedOut, truncated: false, byCause };
    }
    after = page.cursor;
  }

  // The only way out of the loop: the ceiling bit while the band still had rows.
  log.error(ACK_TIMEOUT_TRUNCATED_LOG_MESSAGE, {
    reported: timedOut,
    maxPerTick: ACK_TIMEOUT_MAX_PER_TICK,
    tickStart: tickStart.toISOString(),
  });
  return { timedOut, truncated: true, byCause };
}

/**
 * Classifies and emits one page of crossings, returning how many it reported.
 *
 * The two correlation reads are per page rather than per command, and are
 * skipped entirely for an empty page so an idle tick costs one query.
 */
async function reportCrossings(
  commands: UnackedCommand[],
  now: Date,
  byCause: Record<DesktopCommandAckTimeoutCause, number>
): Promise<number> {
  if (commands.length === 0) {
    return 0;
  }
  const targetIds = [
    ...new Set(commands.map((command) => command.computeTargetId)),
  ];
  const lastSeenById = await listComputeTargetLastSeen(targetIds);
  const inFlightById = await countInFlightCommandsByTarget(targetIds);

  const nowMs = now.getTime();
  for (const command of commands) {
    const lastSeenAt = lastSeenById.get(command.computeTargetId);
    const cause = classifyDesktopCommandAckTimeout({
      // A target absent from the lookup is unknown, not silent for zero ms.
      silentMs:
        lastSeenAt === undefined ? undefined : nowMs - lastSeenAt.getTime(),
      inFlightOnTarget: inFlightById.get(command.computeTargetId) ?? 0,
    });
    byCause[cause] += 1;

    log.warn(ACK_TIMEOUT_LOG_MESSAGE, {
      commandId: command.commandId,
      computeTargetId: command.computeTargetId,
      ackOutcome: DesktopCommandAckOutcome.TimedOut,
      timeoutCause: cause,
      // Measured from the queue entry, not from dispatch: a requeued command's
      // wait for THIS delivery's ack is what the deadline bounds.
      unackedMs: nowMs - command.queuedAt.getTime(),
      // ISS-9630: whether an EARLIER delivery of this command was answered.
      // A crossing carrying `true` is one the target already took once, so it
      // is exactly the population a retry must NOT re-dispatch — and until now
      // nothing could tell it apart from a command that was never delivered.
      // Sizing it is the input the retry decision was missing.
      previouslyAcked: wasAnsweredOnEarlierDelivery(command),
    });
  }
  return commands.length;
}

/** One tick's crossings, split by what the cloud could observe. */
export type AckTimeoutSweepSummary = {
  timedOut: number;
  /**
   * Whether the per-tick cap bit.
   *
   * Kept beside the count rather than folded into it, because a capped page is
   * a FLOOR on the band and reporting it as the band's size would be the same
   * confident-wrong number this sweep exists to replace.
   */
  truncated: boolean;
  byCause: Record<DesktopCommandAckTimeoutCause, number>;
};

/**
 * A zero for every cause, so a cause that did not occur reads as an observed
 * zero rather than as an absent key a consumer has to guess at.
 */
function emptyCauseTally(): Record<DesktopCommandAckTimeoutCause, number> {
  return {
    [DesktopCommandAckTimeoutCause.TargetSilent]: 0,
    [DesktopCommandAckTimeoutCause.TargetBusy]: 0,
    [DesktopCommandAckTimeoutCause.TargetPresent]: 0,
    [DesktopCommandAckTimeoutCause.TargetUnknown]: 0,
  };
}

/**
 * ISS-9630: whether the answer on record belongs to an EARLIER delivery of this
 * command — meaning the target already took it once.
 *
 * Lives here, not in `@repo/api` (codex on #7012): it reads two
 * `desktop_commands` columns against each other to decide retry and telemetry
 * behavior, which is server-side persistence policy rather than a transport
 * contract, and this sweep is its only consumer. `packages/api/src/types/` is
 * for shapes BOTH apps speak.
 *
 * `queuedAt` dates the CURRENT delivery, and `requeueUndeliveredCommands`
 * rewrites it when a reconnect returns an accepted or running row to `queued`.
 * So an ack stamped before that instant cannot be an answer to the delivery now
 * outstanding; it answered a previous one, and the work may already have run on
 * the target. `acknowledgeCommand` stamps the queue attempt it is answering
 * rather than wall-clock now, which is what keeps this comparison sound when an
 * ack and a requeue race.
 *
 * A `null` `ackedAt` means NOT KNOWN TO HAVE BEEN ANSWERED — never "known not
 * answered". It is the honest reading for a command genuinely still waiting,
 * and for any row whose ack predates this column. The migration backfills the
 * live `accepted`/`running` rows whose state proves an answer, so the NULLs
 * that remain are queued rows never answered and terminal rows no retry reads.
 *
 * Strictly less-than, not less-than-or-equal: an ack and the queue entry it
 * answers can land on the same millisecond, and reading that as a stale answer
 * would call a correctly-acked command an earlier delivery.
 *
 * A `false` FROM THIS IS NOT A LICENSE TO REDISPATCH. It says only that no
 * earlier answer is on record, and a command that genuinely never ran and one
 * whose accept-ack and every event were lost in transit both produce it. The
 * signal is sound in one direction only: `true` means the target demonstrably
 * took the command, `false` means "not known to have run". Any retry policy
 * built on this owes an independent check that the work did not already
 * happen — the desktop's own dedupe cannot supply one, because it is in-memory
 * and does not survive the app restart a retry most expects to meet.
 */
export function wasAnsweredOnEarlierDelivery(command: {
  ackedAt: Date | null;
  queuedAt: Date;
}): boolean {
  return (
    command.ackedAt !== null &&
    command.ackedAt.getTime() < command.queuedAt.getTime()
  );
}
