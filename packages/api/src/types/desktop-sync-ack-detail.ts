/**
 * @file ISS-8734: the `details.reason` values the desktop write-lane routes send
 * on a coded 400 for a rejection that is a property of the LANE rather than of
 * anything in the batch.
 *
 * Shared rather than spelled on each side because it is a cross-process wire
 * contract: `apps/api` writes the value and `apps/desktop` switches its RETRY
 * BEHAVIOUR on it, so two copies of the literal can drift into a lane that
 * dead-letters rows for a condition no row caused.
 *
 * Deliberately separate from `summarizeParseIssues`
 * (`apps/api/lib/desktop-agent-sessions-parse-guards.ts`), which owns the
 * reasons derived from a PAYLOAD parse. These are rejected before the body is
 * read at all, so no parse issue exists to summarize.
 */

/**
 * The `computeTargetId` query param was absent, blank, or not a UUID.
 *
 * Lane-wide by construction: the desktop does not mint this id, it reads it
 * from the relay's hello ack (`parseDesktopHelloAck`, which accepts any
 * non-empty string), so a malformed one is identical for every batch the lane
 * will send until the connection is re-established. No session in the batch can
 * be at fault for it, and no retry of any individual row can fix it.
 *
 * This exists because the ISS-8734 UUID guard turned this case from a 500 into
 * a 400. The 500 classed as `IngestionFailed` — lane-wide, budget-neutral, and
 * self-healing. Without a reason the desktop can discriminate on, the 400
 * classes as `ValidationFailed` and is charged to whichever rows are in flight,
 * which dead-letters them non-recoverably after
 * `MAX_CONSECUTIVE_VALIDATION_FAILED` attempts — turning a bad-retry problem
 * into a never-retry one on the same input.
 */
export const DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID =
  "compute_target_id_invalid" as const;
