/**
 * Cadence at which `apps/relay` drives `desktop.presence` for every connected
 * worker (`startWorkerHeartbeat`).
 *
 * Shared rather than re-declared because `apps/api` derives its fleet-capacity
 * sampling gate from it. A gate at or above this cadence silently drops every
 * other heartbeat, and the gauges it feeds are last-value, so the halved sample
 * density would not surface as a gap in any timeseries — only as a monitor
 * evaluating over fewer points than its window assumes.
 *
 * This is the relay transport's cadence only. The direct Socket.IO server keeps
 * its own `SOCKET_HEARTBEAT_INTERVAL_MS` (`apps/api/lib/desktop-gateway-types`),
 * which paces a different mechanism and happens to share this value — so
 * anything that must outlast BOTH periodic writers of `lastSeenAt` takes the max
 * of the two rather than deriving from this one (`COMPUTE_TARGET_STALE_MS`).
 */
export const RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Whether a reported executor occupancy is one `apps/api`'s fleet-capacity
 * classifier would accept for `executor_saturation`.
 *
 * Shared rather than re-declared because `apps/relay` CACHES this value and
 * restates it on every heartbeat (`presence-forward.ts`). A relay-side
 * predicate looser than the classifier's lets the cache hold a number the
 * classifier then rejects on every sample, so one bad frame becomes a standing
 * loss of the metric plus a `warn` per sampling slot attributed to a desktop
 * that only sent it once (ISS-8531 §2).
 *
 * `typeof` leads because the value arrives raw off the wire: an
 * `activeCommands: "2"` is a malformed payload, not the omission an older
 * desktop sends, and folding the two together is what kept the classifier's
 * warn from firing on the case it exists for.
 */
export function isReportableActiveCommands(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Silence past which the cloud treats a target as gone.
 *
 * Two heartbeats. One would call ordinary scheduling jitter a disconnect.
 *
 * Shared rather than re-derived because two sweeps decide the SAME fact from it
 * and would otherwise each multiply the base cadence locally: the idle drain's
 * "below this, the presence trigger owns the target" floor, and the ack-timeout
 * sweep's `target_silent` split. Retuning the multiplier in one place while
 * forgetting the other would leave the two silently disagreeing about which
 * targets are disconnected, with nothing failing.
 */
export const RELAY_PRESENCE_SILENCE_MS =
  2 * RELAY_PRESENCE_HEARTBEAT_INTERVAL_MS;
