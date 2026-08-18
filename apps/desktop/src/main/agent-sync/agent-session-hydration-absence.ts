/**
 * @file agent-session-hydration-absence.ts
 * @description ISS-6031: what an EMPTY `loadSyncedSessions` result is allowed to
 * mean, and what it is not.
 *
 * The sync lane used to read an empty hydration as proof that the queued
 * sessions had been deleted, dead-letter them permanently, and log "locally
 * deleted after enqueue" as a fact. It was measured wrong: on a clone of a real
 * 2.1 GB store the same five sessions were destroyed on every cycle, and the
 * rows were present in `sessions` when the claim was made.
 *
 * An empty read has exactly one meaning — a read returned nothing. Deciding
 * which of the two very different causes produced it (the rows are gone / the
 * rows are there and the read failed) requires a second observation, and until
 * that observation says ABSENT the data may not be disposed of. This module is
 * that decision, kept pure and separate from the service (a grandfathered
 * over-ceiling file) so it can be tested on its own and so the two outcomes
 * cannot quietly collapse back into one branch.
 */

import type { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import {
  dropAbsentCandidates,
  retainUnprovenCandidates,
  type SessionDispositionDeps,
} from "./agent-session-sync-dispositions.js";

/** Which of the three things the follow-up presence probe actually established. */
export const HydrationAbsenceVerdict = {
  /** The probe ran and found no `sessions` row for ANY requested id. */
  ConfirmedAbsent: "confirmed_absent",
  /** The probe ran and at least one requested id still has a `sessions` row. */
  StillPresent: "still_present",
  /** The probe could not run, or threw. Nothing was established either way. */
  Unverified: "unverified",
} as const;
export type HydrationAbsenceVerdict =
  (typeof HydrationAbsenceVerdict)[keyof typeof HydrationAbsenceVerdict];

/**
 * The outcome of the presence probe, as observed — never as inferred. `ok:
 * false` is not "absent"; it is "not known", which is why it carries the reason
 * rather than a set of ids.
 */
export type SessionPresenceProbe =
  | { ok: true; presentIds: readonly string[] }
  | { ok: false; failure: string };

/** How the sync lane must treat the ids of an empty hydration. */
export type HydrationAbsenceDecision = {
  /**
   * Ids PROVEN to have no `sessions` row. Only these may be dequeued and
   * dead-lettered; there is nothing left to deliver.
   */
  disposableIds: string[];
  /**
   * Ids that are still present, or whose presence could not be established.
   * These stay queued and are retried. Never disposed of — that is the whole
   * point of the split.
   */
  retryIds: string[];
  verdict: HydrationAbsenceVerdict;
  /**
   * A statement of what was OBSERVED, for the log. Deliberately not a cause:
   * the log line this feeds replaced one that asserted a deletion nobody had
   * seen, and sent the next investigator hunting for it.
   */
  observation: string;
};

/**
 * ISS-6031: route an EMPTY `loadSyncedSessions` result by what can actually be
 * OBSERVED about the ids, instead of by the assumption that an empty read means
 * the rows were deleted.
 *
 * Ids the probe PROVES have no `sessions` row take the FEA-3473 disposal path
 * unchanged; ids still present — and ids the probe could not answer for at all —
 * are deferred and retried, because the data is still there and destroying it is
 * never the right response to a read that came back empty.
 */
export async function resolveEmptyHydration(
  config: {
    syncMode: AgentSessionSyncMode;
    ids: string[];
    backoffMs: number;
    /** Runs the source's probe; `undefined` means the source exposes none. */
    probe: () => string[] | Promise<string[]> | undefined;
  },
  deps: SessionDispositionDeps
): Promise<void> {
  if (config.ids.length === 0) {
    return;
  }
  const capturedSourceKey = deps.readSourceKey();
  const probe = await probeSessionPresence(config.probe);
  // codex review: the probe is an AWAIT, so `stop()`, an account switch, or a
  // compute-target change can land while it is outstanding — each of which runs
  // `resetSourceState()` and clears the queues, retry deadlines and dead-letter
  // set synchronously. Every disposition below writes that same state through
  // the live service, so acting on a superseded probe would repopulate
  // `nextRetryAfterMs` / `deadLetteredIds` for the PREVIOUS target and issue its
  // outbox write against the NEW one. The sibling awaits in `runSessionSyncPass`
  // already re-check here; this continuation is the one that did not, so a
  // superseded pass now leaves the cleared state cleared.
  if (
    !(deps.isCurrentSourceState() && deps.readSourceKey() === capturedSourceKey)
  ) {
    return;
  }
  const decision = decideHydrationAbsence(config.ids, probe);
  retainUnprovenCandidates(
    {
      ids: decision.retryIds,
      observation: decision.observation,
      backoffMs: config.backoffMs,
    },
    deps
  );
  dropAbsentCandidates(
    {
      syncMode: config.syncMode,
      ids: decision.disposableIds,
      observation: decision.observation,
    },
    deps
  );
}

/**
 * Run a source's local-presence probe as an OBSERVATION that is allowed to fail.
 *
 * `run` returns `undefined` when the source exposes no probe at all — a legacy
 * or fake source — and may throw. Both collapse to `ok: false` ("not
 * established"), never to an empty present-set, which would read as "all absent"
 * and re-introduce the exact silent destruction this module exists to stop.
 */
export async function probeSessionPresence(
  run: () => string[] | Promise<string[]> | undefined
): Promise<SessionPresenceProbe> {
  try {
    const presentIds = await run();
    if (presentIds === undefined) {
      return {
        ok: false,
        failure: "this sync source exposes no findExistingSessionIds probe",
      };
    }
    return { ok: true, presentIds };
  } catch (error) {
    return {
      ok: false,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Split the ids of an empty hydration into what may be disposed of and what must
 * be retried, given a presence probe.
 *
 * The `ok: false` and partial-presence cases both resolve toward RETRY. That
 * asymmetry is intentional: a wrong retry costs one more read, a wrong disposal
 * costs the only copy of the data.
 */
export function decideHydrationAbsence(
  requestedIds: readonly string[],
  probe: SessionPresenceProbe
): HydrationAbsenceDecision {
  const requested = [...requestedIds];
  if (!probe.ok) {
    return {
      disposableIds: [],
      retryIds: requested,
      verdict: HydrationAbsenceVerdict.Unverified,
      observation: `hydration returned 0 rows for ${requested.length} queued session(s) and the local presence probe could not answer (${probe.failure}), so their absence is unproven`,
    };
  }
  const present = new Set(probe.presentIds);
  const stillPresent = requested.filter((id) => present.has(id));
  if (stillPresent.length === 0) {
    return {
      disposableIds: requested,
      retryIds: [],
      verdict: HydrationAbsenceVerdict.ConfirmedAbsent,
      observation: `hydration returned 0 rows for ${requested.length} queued session(s) and a follow-up probe found no row in the local \`sessions\` table for any of them`,
    };
  }
  return {
    disposableIds: requested.filter((id) => !present.has(id)),
    retryIds: stillPresent,
    verdict: HydrationAbsenceVerdict.StillPresent,
    observation: `hydration returned 0 rows for ${requested.length} queued session(s) while ${stillPresent.length} of them still has a row in the local \`sessions\` table — a read failure, not a deletion`,
  };
}
