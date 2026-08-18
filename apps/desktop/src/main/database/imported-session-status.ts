/**
 * @file imported-session-status.ts
 * @description FEA-4187: terminal-status classification for a HISTORICALLY
 * imported harness run (the collector/rebuild import path in `write-core.ts`).
 *
 * The live `SessionEnd` hook path already maps a run that ended on an
 * unrecovered API error to `ERROR` (see `write-core.ts` + `trailing-api-error.ts`).
 * The historical import path did NOT: any non-recently-active run was recorded
 * as `COMPLETED` unconditionally, so a failed harness run was imported and
 * displayed as "Completed" — the UI lied about the outcome. These helpers apply
 * the same failed-vs-completed rule to imports so the two paths agree.
 */

import {
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import type { NormalizedSession } from "../collectors/types.js";
import { deriveEndedOnUnrecoveredError } from "../collectors/types.js";
import { DESKTOP_AGENT_STATUS } from "./db-constants.js";

/**
 * ISS-4586: whether an imported run ended on an unrecovered error — the durable
 * `ends_with_error` signal persisted at import. The worker stamps
 * `endedOnUnrecoveredError` from the FULL parsed session before the
 * worker-response clamp, so an explicit boolean — `true` OR `false` — is
 * AUTHORITATIVE and trusted as-is. Re-deriving from the on-hand
 * `apiErrors`/`messages` is a nullish fallback used only when the flag is absent
 * (`undefined`): in-process parses and version-skewed cached payloads that
 * predate the worker stamp. Deriving from the possibly-clamped arrays when the
 * worker already computed `false` would wrongly flip a recovered run to failed
 * if the clamp dropped its trailing recovery message — the nullish guard
 * prevents that.
 */
export function resolveImportedEndsWithError(
  session: Pick<
    NormalizedSession,
    "apiErrors" | "endedOnUnrecoveredError" | "messages"
  >
): boolean {
  return (
    session.endedOnUnrecoveredError ?? deriveEndedOnUnrecoveredError(session)
  );
}

/**
 * Status for a newly-imported (previously-unseen) session's row (ISS-4586).
 *
 * - A recently-active run is still live → `ACTIVE`.
 * - Otherwise the run is terminal: `ERROR` when it ended on an unrecovered error
 *   (see {@link resolveImportedEndsWithError}), else `INACTIVE` — the neutral
 *   "finished, not failed" state that supersedes the former `completed`.
 */
export function resolveImportedSessionStatus(
  session: Pick<
    NormalizedSession,
    "apiErrors" | "endedOnUnrecoveredError" | "messages"
  >,
  recentlyActive: boolean
): SessionStatus {
  if (recentlyActive) {
    return SESSION_STATUS.ACTIVE;
  }
  return resolveImportedEndsWithError(session)
    ? SESSION_STATUS.ERROR
    : SESSION_STATUS.INACTIVE;
}

/**
 * The main agent status that mirrors a newly-imported session's status: a failed
 * session's main agent is `ERROR`, an inactive (finished) session's is
 * `COMPLETED` (the agent vocabulary keeps its own `completed` terminal), and any
 * non-terminal (active) session's is `WAITING` (the live/awaiting-input default).
 */
export function importedMainAgentStatus(
  sessionStatus: SessionStatus
): (typeof DESKTOP_AGENT_STATUS)[keyof typeof DESKTOP_AGENT_STATUS] {
  if (sessionStatus === SESSION_STATUS.ERROR) {
    return DESKTOP_AGENT_STATUS.ERROR;
  }
  if (sessionStatus === SESSION_STATUS.INACTIVE) {
    return DESKTOP_AGENT_STATUS.COMPLETED;
  }
  return DESKTOP_AGENT_STATUS.WAITING;
}
