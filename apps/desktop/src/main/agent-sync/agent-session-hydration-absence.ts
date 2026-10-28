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
import { readSessionPresenceIds } from "./sync-source-reply-boundary.js";

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
    /**
     * The sync source, named structurally by the ONE delegate this module uses
     * so the module stays decoupled from the full source type.
     *
     * Taken whole rather than as a pre-built `probe` thunk on purpose: whether
     * the delegate EXISTS is the fact that decides fault-versus-not, and a
     * thunk built by the caller has already destroyed it — optional chaining
     * answers `undefined` both for a missing delegate and for one that returned
     * nothing. {@link buildSessionPresenceProbe} makes that call here, where the
     * delegate itself is still visible.
     */
    source: { findExistingSessionIds?: (ids: string[]) => unknown };
  },
  deps: SessionDispositionDeps
): Promise<void> {
  if (config.ids.length === 0) {
    return;
  }
  const capturedSourceKey = deps.readSourceKey();
  const probe = await probeSessionPresence(
    buildSessionPresenceProbe(config.source, config.ids)
  );
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
 * `run` IS `undefined` when the source exposes no probe at all — a legacy or
 * fake source — and an invoked probe may throw. Both resolve to `ok: false`
 * ("not established"), never to an empty present-set, which would read as "all
 * absent" and re-introduce the exact silent destruction this module exists to
 * stop.
 *
 * The absent probe is carried by the CALLBACK being absent, not by the callback
 * answering `undefined`, and that distinction is load-bearing. The production
 * caller reaches the delegate through optional chaining
 * (`source.findExistingSessionIds?.(ids)`), which answers `undefined` both when
 * the delegate is missing and when a delegate that exists returned nothing — two
 * different facts, only one of them a fault. `buildSessionPresenceProbe` decides
 * that question once, at the only place that can see the delegate itself, so a
 * source with no probe never builds a callback and every reply that arrives here
 * came from an op this build actually called.
 *
 * ISS-8115 — a THIRD way to fail was reachable and was not handled. In the
 * FEA-2038 build this probe is a db-host IPC call: `db-host-invoke-dispatch`
 * delivers the child's structured clone verbatim and the main-side Proxy is a
 * single cast, so `string[]` is an assertion about the peer, not a fact. The
 * `=== undefined` check below does not catch `null`, and `new Set(null)` is an
 * empty Set rather than a throw — so a peer answering `null` used to arrive here
 * as `ok: true` with no ids, which `decideHydrationAbsence` reads as
 * `ConfirmedAbsent` and DISPOSES of every queued id. `readSessionPresenceIds`
 * closes that by admitting only a real id list and degrading everything else to
 * "not established", where the retry path already lives.
 */
export async function probeSessionPresence(
  /**
   * ISS-8115 — deliberately `unknown` rather than
   * `() => string[] | Promise<string[]> | undefined`. Under the db-host build
   * this callback is an IPC round-trip, so the narrower annotation was an
   * ASSERTION about the peer that read like a guarantee, and it was the thing
   * that made the `null` case below look impossible. Typing it honestly is what
   * removes the implicit cast; `readSessionPresenceIds` is what re-establishes
   * the shape.
   */
  run: (() => unknown) | undefined
): Promise<SessionPresenceProbe> {
  try {
    if (run === undefined) {
      return {
        ok: false,
        failure: "this sync source exposes no findExistingSessionIds probe",
      };
    }
    const reply = await run();
    // `undefined` is NOT short-circuited to the no-probe answer above: the
    // delegate EXISTS on this path, so an `undefined` reply is a peer answering
    // outside its own contract. It goes through the schema like every other
    // unreadable reply, so it degrades to "not established" AND is reported on
    // the monitored facet, instead of being filed as a legacy source with
    // nothing to say.
    const presentIds = readSessionPresenceIds(reply);
    if (presentIds === undefined) {
      return {
        ok: false,
        failure:
          "the findExistingSessionIds reply did not match this build's schema for that op, so no presence was established",
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

/**
 * Build the presence-probe callback for a source, or `undefined` when the source
 * exposes no probe at all.
 *
 * This exists so ONE place decides "does this source have a probe", and it is
 * the only place that can: past this point the answer is a reply, and a reply
 * cannot distinguish a missing delegate from a delegate that returned nothing.
 * Deciding it here is what lets {@link probeSessionPresence} treat every
 * `undefined` it sees as a peer answering outside its contract — a monitored
 * fault — while a legacy or fake source stays correctly non-faulty.
 *
 * The delegate is invoked as a MEMBER call inside the closure, never captured as
 * a detached reference: in the db-host build `source` is the FEA-2038 forwarding
 * Proxy, whose `get` trap answers `call`/`apply`/`bind` with `undefined`, so a
 * detached reference would throw and degrade the probe to "unverified" on
 * exactly the build that matters. Same constraint, and same shape, as
 * `buildComponentCursorPersist`.
 */
export function buildSessionPresenceProbe(
  source: { findExistingSessionIds?: (ids: string[]) => unknown },
  ids: string[]
): (() => unknown) | undefined {
  if (!source.findExistingSessionIds) {
    return undefined;
  }
  return () => source.findExistingSessionIds?.(ids);
}
