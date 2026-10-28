/**
 * @file agent-session-freshness-lag.ts
 * @description ISS-7496 — the desktop→cloud pipeline freshness measure behind
 * the operator question "what is the freshest session we have?".
 *
 * Split across two clocks on purpose. {@link resolveFreshestUpdatedAtMs} runs at
 * SEND time, against the payload actually on the wire, so the timestamp can
 * never disagree with the bytes it describes (the ISS-7265
 * `tilingStrippedSessionIds` precedent). {@link resolveFreshestSessionLagMs}
 * runs when the ack is processed, because the lag an operator asks about ends at
 * the moment the cloud CONFIRMED the row, not at the moment we started talking.
 *
 * Content-free: it consumes `updatedAt` and yields a duration. No session id,
 * name, path, or absolute timestamp leaves the machine.
 */

import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";

/**
 * Why a confirmed batch's freshness could not be measured.
 *
 * Both arms are impossible-by-construction data rather than ordinary absence —
 * `updatedAt` is required on the wire type and is written from the same local
 * clock this is compared against — so each is reported to the monitored lane
 * instead of being coerced into a number.
 */
export const FreshestSessionLagAnomaly = {
  /** No delivered row carried a parseable `updatedAt`; the local store is wrong. */
  UnreadableUpdatedAt: "unreadable_updated_at",
  /** The freshest delivered `updatedAt` is AHEAD of the confirmation clock. */
  FutureUpdatedAt: "future_updated_at",
} as const;

/** Literal union of freshness-measurement anomalies. */
export type FreshestSessionLagAnomaly =
  (typeof FreshestSessionLagAnomaly)[keyof typeof FreshestSessionLagAnomaly];

/**
 * `lagMs` is the measure, or `null` when it could not be taken honestly.
 *
 * Never clamped. A backward clock step would otherwise render as a lag of `0` —
 * "the cloud is perfectly current" — which is precisely the reassuring lie a
 * freshness measure exists to prevent, so the attribute is omitted instead and
 * {@link FreshestSessionLagResult.anomaly} says why.
 */
export type FreshestSessionLagResult = {
  lagMs: number | null;
  anomaly?: FreshestSessionLagAnomaly;
};

/**
 * Newest parseable `updatedAt` among the sessions on the wire, in epoch ms.
 *
 * `null` means NO session carried one. `updatedAt` is required on the wire type,
 * so for the non-empty batch this is called with, `null` is a corrupt local row
 * and not an ordinary absence; the caller reports it rather than substituting a
 * timestamp of its own.
 */
export function resolveFreshestUpdatedAtMs(
  sessions: readonly SyncedAgentSession[]
): number | null {
  let freshest: number | null = null;
  for (const session of sessions) {
    const parsed = Date.parse(session.updatedAt);
    if (Number.isFinite(parsed) && (freshest === null || parsed > freshest)) {
      freshest = parsed;
    }
  }
  return freshest;
}

/**
 * Age of the freshest confirmed session at the moment its ack was processed.
 *
 * `undefined` is "this producer did not measure one" and is silent — that is the
 * version-skew and no-op-path arm. `null` is "measured, and impossible", which
 * is a finding, so it comes back with an anomaly the caller must report.
 */
export function resolveFreshestSessionLagMs(input: {
  freshestUpdatedAtMs: number | null | undefined;
  confirmedAtMs: number;
}): FreshestSessionLagResult {
  const { freshestUpdatedAtMs, confirmedAtMs } = input;
  if (freshestUpdatedAtMs === undefined) {
    return { lagMs: null };
  }
  if (freshestUpdatedAtMs === null) {
    return {
      lagMs: null,
      anomaly: FreshestSessionLagAnomaly.UnreadableUpdatedAt,
    };
  }
  const lagMs = confirmedAtMs - freshestUpdatedAtMs;
  if (lagMs < 0) {
    return { lagMs: null, anomaly: FreshestSessionLagAnomaly.FutureUpdatedAt };
  }
  return { lagMs };
}
