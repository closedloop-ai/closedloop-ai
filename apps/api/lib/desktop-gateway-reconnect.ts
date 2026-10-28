import { isDesktopApiPath } from "@repo/api/src/desktop-api-namespace";
import { log } from "@repo/observability/log";
import { MAX_IN_FLIGHT_COMMANDS_CEILING } from "@/lib/desktop-gateway-types";

export type ReconnectPendingCommand = {
  commandId: string;
  computeTargetId: string;
  path: string;
};

export type PartitionedPendingCommands<T extends ReconnectPendingCommand> = {
  emit: T[];
  skipped: T[];
};

export function partitionPendingCommandsForReconnect<
  T extends ReconnectPendingCommand,
>(commands: readonly T[]): PartitionedPendingCommands<T> {
  const emit: T[] = [];
  const skipped: T[] = [];
  for (const command of commands) {
    if (typeof command.path === "string" && isDesktopApiPath(command.path)) {
      emit.push(command);
    } else {
      skipped.push(command);
    }
  }
  return { emit, skipped };
}

/** Emits direct-socket reconnect commands while retaining the existing warning. */
export function emitPendingCommandsForReconnect<
  T extends ReconnectPendingCommand,
>(commands: readonly T[], emitCommand: (command: T) => void): void {
  const { emit, skipped } = partitionPendingCommandsForReconnect(commands);
  warnSkippedPendingCommands(skipped);
  for (const command of emit) {
    emitCommand(command);
  }
}

/**
 * The one report of a pending command this reconnect refused to replay.
 *
 * Both lanes call it with the same message string on purpose: a skipped row is
 * left non-terminal and is never replayed by either lane, so the only record
 * that it existed is this line, and one Datadog query has to cover both. The
 * relay lane dropping its `skipped` partition silently is the divergence
 * ISS-7977 exists to close — sharing the emitter is what stops it reopening.
 */
export function warnSkippedPendingCommands<T extends ReconnectPendingCommand>(
  skipped: readonly T[]
): void {
  for (const command of skipped) {
    log.warn(
      "Pending command has non-gateway path — possible legacy command in store",
      {
        commandId: command.commandId,
        computeTargetId: command.computeTargetId,
        path: command.path,
      }
    );
  }
}

/**
 * The most QUEUED commands one hello handshake will read for a target.
 *
 * Bounds only the queued page. Rows already `accepted` or `running` are read
 * whole and are never subject to this cap — see `capQueuedCommandsForReconnect`
 * for why capping those strands them permanently.
 *
 * The read this bounds runs inside `HELLO_OPERATION_TIMEOUT_MS`, so leaving it
 * uncapped makes handshake latency a function of queue depth — and that closes
 * a loop: a queue deep enough to blow 5s nacks the hello, which disconnects the
 * target that would have drained it, which deepens the queue. Production ran
 * that loop. Over the 15 days to 2026-09-01, `cl-api` logged 136
 * `pending_commands_lookup_failed` hello nacks, every one `errorKind:timeout`
 * and never a query error, and 106 of the 136 belonged to a single compute
 * target whose successful reads averaged 483ms but topped out at 4999ms against
 * the 5000ms cutoff.
 *
 * THAT EVIDENCE DOES NOT DECOMPOSE BY STATUS, and nothing here should be read as
 * claiming it does. The read it measures was a single `notIn terminal` query, so
 * 483ms/4999ms is the union of that target's queued and in-flight rows and the
 * logs do not say which population carried the depth. Which half is capped is
 * therefore settled by consequence rather than by that measurement: a truncated
 * queued row is still `queued` and still reachable by the drain and the next
 * hello, while an in-flight row dropped from this read is reachable by nothing.
 *
 * 4x `MAX_IN_FLIGHT_COMMANDS_CEILING`, expressed as that product rather than a
 * literal so the stated relationship survives a change to the ceiling. A client
 * that DECLARES a ceiling therefore never has its emitted set truncated here.
 *
 * Two paths declare none and ARE truncated by this cap — the direct socket
 * lane, which never slices by a ceiling, and a pre-ISS-8453 client the relay
 * lane still answers by emitting everything. Neither has a drain behind it
 * (`releaseQueuedCommands` returns 0 when the ceiling is undefined, and the
 * socket lane never schedules a release), so for them the remainder waits for
 * the next reconnect instead of draining. That is a delivery change, not just a
 * latency one, and it is stated here rather than implied.
 */
export const HELLO_QUEUED_COMMAND_LIMIT = 4 * MAX_IN_FLIGHT_COMMANDS_CEILING;

/** The one record that a hello's queued page was truncated. */
export const HELLO_QUEUED_CAPPED_LOG_EVENT =
  "desktop.hello.pending_commands.capped";

/**
 * Trims a hello's QUEUED page to the cap, reporting when it bound.
 *
 * Callers read `HELLO_QUEUED_COMMAND_LIMIT + 1` rows so the extra row proves a
 * deeper backlog exists; an exactly-full page proves nothing about what lies
 * past it. The warn names the target rather than counting anonymously — the
 * truncation must never look like a shallow queue.
 *
 * Queued rows ONLY. An `accepted`/`running` row dropped by a cap is stranded
 * forever: the reconnect requeue builds its id list from what this read
 * returned, so a row past the cap is neither re-emitted nor returned to
 * `queued`, nothing else terminalizes it, and it understates that target's
 * `free` until the target wedges at zero. Ordering cannot protect it either —
 * `POST /compute-targets/[id]/commands` dispatches on arrival with no capacity
 * gate, so a freshly `accepted` row carries the NEWEST `createdAt` and sorts
 * last behind any backlog.
 */
export function capQueuedCommandsForReconnect<T>(
  commands: readonly T[],
  computeTargetId: string
): T[] {
  if (commands.length <= HELLO_QUEUED_COMMAND_LIMIT) {
    return [...commands];
  }
  log.warn(HELLO_QUEUED_CAPPED_LOG_EVENT, {
    computeTargetId,
    limit: HELLO_QUEUED_COMMAND_LIMIT,
  });
  return commands.slice(0, HELLO_QUEUED_COMMAND_LIMIT);
}

/**
 * Restores one oldest-first order over the separately-read in-flight and queued
 * pages, so splitting the read does not reorder what a hello emits.
 *
 * `id` breaks the tie rather than leaving it to the merge: it is a uuid7 and so
 * creation-ordered, which is the same property `listSamplableComputeTargetIds`
 * relies on.
 */
export function byCreatedAtThenId(
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string }
): number {
  const byCreatedAt = left.createdAt.getTime() - right.createdAt.getTime();
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  return left.id.localeCompare(right.id);
}
