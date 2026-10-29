/**
 * Character ceiling for an owner-authored session name.
 *
 * Shared rather than route-local because two boundaries must agree on it: the
 * `PATCH /agent-sessions/[id]` body and the `nameOverride` field of the desktop
 * sync payload. A value one boundary accepts and the other rejects would let a
 * rename land on one surface and bounce on the other.
 */
export const AGENT_SESSION_NAME_MAX_CHARS = 200;

/** Raw request byte cap for `PATCH /agent-sessions/[id]`. */
export const AGENT_SESSION_RENAME_REQUEST_MAX_BYTES = 4096;
