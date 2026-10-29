import { withDb } from "@repo/database";

/**
 * Records a relay `presence` frame — the ONLY writer of `presenceAt`.
 *
 * ISS-8897. `presenceAt` and `lastSeenAt` are two different facts that shared
 * one column until now, and the drain was the reader that could not tell them
 * apart. `lastSeenAt` answers "has this desktop checked in, on any transport" —
 * registration, the direct Socket.IO server's own 30s timer, and the
 * per-target SSE stream,
 * which re-stamps on the relay heartbeat cadence for as long as it is held
 * (ISS-10111 — it used to stamp once at stream open, which read as silence).
 * `presenceAt` answers the narrower question the idle drain actually asks: "is
 * the relay presence trigger waking this target's backlog", which is true only
 * of a relay `presence` frame, because that frame is the sole thing that drives
 * `emitPresenceFleetCapacityMetrics`.
 *
 * Split out of `service.ts` rather than added to it, and kept as a sibling of
 * `heartbeat` rather than a flag on it: a boolean parameter would put the two
 * clocks back behind one call and make the writer set impossible to read off
 * the type. The presence path is the one caller, and `handlePresence` is it.
 *
 * `lastSeenAt` is stamped here too. A presence frame IS a check-in, so omitting
 * it would make the relay transport the one path that leaves `lastSeenAt` stale
 * while the desktop is demonstrably live — a second defect of the same shape as
 * the one this split fixes.
 */
export async function recordRelayPresence(
  id: string,
  organizationId: string,
  userId: string
): Promise<boolean> {
  const now = new Date();
  const updated = await withDb((db) =>
    db.computeTarget.updateMany({
      where: { id, organizationId, userId },
      data: {
        isOnline: true,
        lastSeenAt: now,
        presenceAt: now,
      },
    })
  );
  return updated.count > 0;
}
