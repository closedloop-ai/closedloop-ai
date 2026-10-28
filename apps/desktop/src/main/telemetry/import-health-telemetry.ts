/**
 * @file import-health-telemetry.ts
 * @description ISS-5103 (PRD-611 gap 5): desktop import-health counters. Wraps
 * the `Importer` handed to the collector manager to tally tolerated group
 * failures by label and sessions flagged `incomplete`, and samples the
 * DATA_REVISION_IMPORT_PENDING sentinel on a fixed tick. Each tick emits one
 * `import.group_failed` record per failed label, one `import.ingest_failed`
 * record per collector ingest-failure reason (ISS-6336), plus an `import.health`
 * pass record carrying `import.outcome`, `sessions_incomplete`,
 * `sessions_pending_revision`, and the ISS-6336 quarantine gauge.
 *
 * Decorating the importer (rather than hooking `settlePass` inside the collector
 * manager) covers every import path — boot backfill, catch-up sweeps, and
 * live-watcher imports — including passes that exit early on a live-event yield,
 * with zero edits to the manager.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO, both because they would make the
 * numbers lie:
 *
 * 1. It does not drive the tick off observed results. `importSessionBounded`
 *    wraps this decorator, so a per-session timeout resolves a synthetic result
 *    ABOVE us and our `await` never returns — exactly the wedged-DB case these
 *    counters exist to catch. A fixed tick reports the stuck sentinel even when
 *    no import result is ever observed again.
 *
 * 2. It does not use `updated_at` to decide what is stuck. The revision-only
 *    heal path in write-core stamps the sentinel WITHOUT bumping `updated_at`
 *    (deliberately — it is the sync watermark), so "sentinel AND old
 *    updated_at" also matches a session being imported right now, which is the
 *    majority case during a DATA_REVISION backfill. Instead each tick snapshots
 *    the pending session ids and reports the INTERSECTION with the previous
 *    tick's snapshot: rows that were pending a full tick ago and still are.
 *    With a tick longer than the per-session import bound, a healthy in-flight
 *    import cannot appear in two consecutive snapshots.
 *
 * Everything here is best-effort per the desktop exporter-boundary rule: an
 * observation, sample, or emit failure is swallowed (optionally logged to the
 * main-process diagnostic sink) and never throws into the import pipeline.
 *
 * ISS-6335: the pass record is emitted on EVERY tick, carrying the window's
 * `ImportOutcome`. It used to be suppressed when both counters read zero, which
 * made a healthy install with nothing to import, an install whose imports never
 * land, and a process that has stopped reporting altogether all look identical
 * from the server — silence. With the suppression gone, absence of a record is
 * a statement about the process, and a counter added to this record (ISS-6336)
 * is visible in exactly the zero-session case it exists to describe.
 *
 * No dedupe or rate limit sits on top of that, deliberately. The bound is the
 * fixed tick below (one pass record per install per five minutes, plus one on
 * a clean quit); suppressing a repeat would put back the ambiguity this issue
 * removes, since a steady stream of identical `empty` records is precisely the
 * evidence that the install is alive and idle.
 *
 * ISS-6116: the same tick also emits the two HARNESS-SCOPED backfill records —
 * `import.sources_remaining` every window, `import.harness_not_advancing` when
 * a running first pass has finished nothing. Everything above is install-scoped
 * and structurally blind to a wedged backfill: a source whose import never
 * completes writes no session row, so nothing reaches the sentinel for
 * `sessions_pending_revision` to count, and its groups never FAIL — they are
 * merely slow, and the outer per-session bound abandons the import. A store
 * wedged for eight days at `codex 0/2465` reported one session at the sentinel.
 */
import {
  ImportGroupLabel,
  ImportHealthEvent,
  ImportIngestFailure,
  ImportOutcome,
  type ImportParseDegradedSite,
} from "@closedloop-ai/telemetry-contract/app";
import { TelemetryHarnessName } from "@closedloop-ai/telemetry-contract/resource";
import type { QuarantinedStageCounts } from "../../shared/ingest-quarantine-contract.js";
import {
  parseDegradedSite,
  sessionIngestFailures,
} from "../collectors/engine/collector-ingest-failure.js";
import type { IngestHarnessProgressReport } from "../collectors/engine/collector-manager-ingest-progress.js";
import type { NormalizedSession } from "../collectors/types.js";
import {
  type Importer,
  type ImportResult,
  isDurableImportProgress,
} from "../dashboard/agent-dashboard-db-types.js";
import {
  type WriteDispatchProbe,
  WriteDispatchState,
  WriteQueueCancelOutcome,
} from "../database/write-queue.js";
import type {
  DesktopImportHealthEventInput,
  MaterializeImportHealthEvent,
} from "./app-otel-runtime-import-health.js";
import { raceShutdownDeadline } from "./shutdown-deadline.js";

/**
 * Sampling period. Comfortably longer than the per-session import bound
 * (ISS-4410, ~2 min) so a session that is merely mid-import cannot survive two
 * consecutive snapshots and be miscounted as stuck.
 */
const IMPORT_HEALTH_TICK_MS = 5 * 60_000;

/**
 * Cap on the sentinel snapshot. A backlog past this is already far beyond any
 * alert threshold, so the exact number stops mattering — the cap keeps a
 * mid-backfill snapshot (where the whole corpus transits the sentinel) from
 * holding a large id array in the main process.
 */
const IMPORT_PENDING_SNAPSHOT_LIMIT = 1000;

const KNOWN_IMPORT_GROUP_LABELS: ReadonlySet<string> = new Set(
  Object.values(ImportGroupLabel)
);

/**
 * ISS-6116: the contract's closed `harness.name` set, in the same shape as the
 * group-label cap above. Fixed at module load, so it is bounded by construction.
 */
const KNOWN_TELEMETRY_HARNESS_NAMES: ReadonlySet<string> = new Set(
  Object.values(TelemetryHarnessName)
);

/**
 * ISS-6336: cap on the per-window session-quality dedupe set. Same reasoning as
 * the sentinel snapshot limit above — a backlog of this many distinct degraded
 * sessions inside one five-minute window is already far past any threshold, so
 * the exact number stops mattering and the cap keeps the set from holding an
 * id per session of a whole corpus mid-backfill.
 *
 * ISS-5822: the set now holds `(session, reason)` PAIRS, so the memory posture
 * is unchanged — still at most this many strings — while the session capacity
 * behind it divides by the number of reasons one session can carry at once, at
 * most three ({@link sessionIngestFailures} returns the mutually-exclusive
 * degraded/unreadable, plus unrouted, plus the clamp). Left at the same number
 * rather than tripled because the threshold it encodes is "far past anything
 * worth reading precisely", and a few hundred distinct degraded sessions in one
 * window is still that.
 */
const SESSION_QUALITY_DEDUPE_LIMIT = 1000;

export type ImportHealthTrackerOptions = {
  /**
   * Best-effort emit into the app-OTel runtime, whose `emitImportHealthEvent`
   * catches every serialization and dispatch failure internally and therefore
   * never throws.
   *
   * CONTRACT: a throw from this seam means the record was NOT dispatched. The
   * tracker relies on that to report a failed pass emit as an `error` window
   * instead of leaving it silent, since after ISS-6335 silence means the process
   * stopped reporting. A seam that ships a record and THEN throws would produce
   * a second, contradictory record for the same window; do not write one.
   */
  emitImportHealth: (input: DesktopImportHealthEventInput) => void;
  /**
   * Ids of sessions currently at the pending-revision sentinel, capped at
   * `limit` (see `listImportPendingSessionIds`).
   */
  listPendingRevisionSessionIds: (limit: number) => Promise<string[]>;
  /**
   * ISS-6116: per-harness backfill state for this window, read live from the
   * collector manager's ingest tracker. Optional — a context with no collector
   * manager (or a version of the wiring that predates this seam) simply reports
   * no harness records, and the install-scoped counters are unaffected.
   *
   * Read at tick time rather than accumulated from observed results ON PURPOSE,
   * for the same reason the sentinel sample is: `importSessionBounded` wraps the
   * importer decorator, so a wedged import never returns through `observe()` and
   * writes no session row. Anything derived from what this tracker SAW would be
   * silent in exactly the outage these records exist to report.
   */
  reportHarnessProgress?: () => IngestHarnessProgressReport[];
  /**
   * ISS-6336 GAUGE source: how many transcripts are quarantined RIGHT NOW, by
   * stage. Read fresh on every tick rather than accumulated, because the level
   * is the question — a source stays quarantined until its transcript changes,
   * so an occurrence count of the passes that skipped it is a sawtooth from
   * which the level cannot be recovered.
   *
   * A thunk, not a value: the collector manager that owns the quarantine stores
   * is constructed AFTER tracking is installed (it needs the decorated importer),
   * so the reader is resolved at tick time. Omitted where no manager exists, in
   * which case the gauge is absent rather than reported as a zero nobody measured.
   */
  readQuarantinedCounts?: () => QuarantinedStageCounts;
  /** Key-free diagnostic sink. */
  log?: (message: string) => void;
  /** Test override for the sampling cadence. */
  tickMs?: number;
};

export type ImportHealthTracker = {
  /** Decorate an importer so every result feeds the tally. */
  wrapImporter(importer: Importer): Importer;
  /**
   * ISS-6336: count one collector ingest failure against the current window.
   *
   * The collector engine reports the failures the IMPORTER never sees — a source
   * whose parse threw or timed out, and a source the pending scan skipped as
   * quarantined. Neither reaches `importSession`, so neither could ever move a
   * counter on the decorated path.
   *
   * Takes a contract member rather than a free string: unlike
   * `ImportResult.failedGroups`, which arrives across the db-host IPC boundary
   * from another build unit, this seam is wholly in-process in one build, so
   * there is no unrecognized value for a client-side map to absorb. Best-effort
   * like every other observation on this tracker — a report after `dispose()` is
   * dropped rather than resurrecting a torn-down window.
   */
  noteIngestFailure(reason: ImportIngestFailure): void;
  /**
   * ISS-8600: this harness's fast re-attach loop gave up while the harness had
   * no live delivery to fall back on — live delivery is now catch-up-poll only.
   * The engine gates the call: a harness whose roots never existed reports
   * nothing, so a report here always names a tool the user actually installed.
   *
   * Emitted ON THE SPOT rather than tallied into the 5-minute window, unlike
   * {@link noteIngestFailure}. An ingest failure is one of a rate the window
   * summarises; this is a state transition with no rate to summarise, and
   * holding it for up to a tick would blunt exactly the liveness signal it
   * buys. Takes the collector's harness key as a `string` and drops anything
   * outside the contract's closed `harness.name` set through the same guard the
   * ISS-6116 harness records use, so there is one mapping and not two, and
   * saying so on the collector log the way that path does — the trigger is a
   * code defect, and a silent drop would take the harness's watch-lost
   * telemetry with nothing anywhere naming the key that caused it.
   *
   * Best-effort like every other observation here — a report after `dispose()`
   * is dropped rather than resurrecting a torn-down window.
   */
  noteWatchLost(harness: string): void;
  /**
   * ISS-8600: one batch-materialized harness's pass ended without fresh
   * projections.
   *
   * The harness is the CALLER's to name, not this seam's to assume. OpenCode is
   * the only `batch: true` collector today, and a hardcode here would have
   * shipped a second one's materialize failures under `opencode` with nothing
   * failing `tsc` — an operator sent to the wrong tool by a monitoring record.
   * Typed `TelemetryHarnessName` rather than `string` because every caller is
   * in-process in this build: unlike {@link noteWatchLost}, which absorbs a
   * collector key the contract has not learned, here the type is the guard.
   *
   * The type cannot say that a SECOND batch collector owes its own name, so
   * `test/batch-harness-materialize-wiring.test.ts` does: it derives the
   * `batch: true` set from the real collector roster and fails until the
   * materialize wiring names every member.
   *
   * Accepts ONLY the two emitting outcomes. A deliberate cancel settles through
   * the same rejection path a genuine failure does, so it is filtered at the
   * sweep that can still tell them apart; typing that arm out of this signature
   * means a no-op outcome can never arrive here and be mishandled.
   */
  noteMaterializeOutcome(
    harness: TelemetryHarnessName,
    kind: MaterializeImportHealthEvent
  ): void;
  /**
   * Run one sampling tick now: emit the accumulated tally and compare the
   * sentinel snapshot against the previous one. Used by tests and by the
   * shutdown path, which must drain the tally while the DB host and the OTel
   * relay are both still alive.
   */
  flushNow(): Promise<void>;
  /** Stop sampling and drop any untallied state. Idempotent. */
  dispose(): void;
};

export function createImportHealthTracker(
  options: ImportHealthTrackerOptions
): ImportHealthTracker {
  const tickMs = options.tickMs ?? IMPORT_HEALTH_TICK_MS;

  let disposed = false;
  let sessionsIncomplete = 0;
  /**
   * Import calls that returned DURABLE progress this window — the collector
   * manager's own predicate, not merely "a result came back". A `{ failed }` or
   * a `{ skipped, !reactivated }` result wrote no row, so a window carrying only
   * those must not claim `imported`.
   */
  let importsProgressed = 0;
  /**
   * ISS-12036: import calls that SETTLED this window without landing anything
   * they needed to — no durable progress and not a byte-identical re-offer
   * (`unchanged`), or a rejection. Counted at settle, from the same result as
   * `progressed`, so both sides of the wedge test come from the same window: a
   * count taken on entry and netted against one taken at settle could straddle
   * a window reset and cancel out a genuine refusal. An import that never
   * settles is `importsInFlight`'s, below.
   *
   * Before ISS-12036 the wedge term was every ENTERED import, so a source the
   * orphan self-heal re-offered unchanged on every pass reported `wedged`
   * forever on an install where nothing was wrong — 134 of 208 outcomes on the
   * install ISS-12036 measured.
   */
  let importsUnlanded = 0;
  /**
   * Import calls entered and not yet settled. A GAUGE, deliberately NOT reset
   * by the window reset below and not cleared by `dispose()` — the promises it
   * counts are still outstanding, and zeroing it would desync the decrement.
   *
   * This is what makes a never-settling import stay visible past its first
   * window: `importSessionBounded` abandons rather than cancels, so the promise
   * of a wedged import never settles, never re-enters `importSession`, and never
   * reaches `observe()`. Window counters alone would report `wedged` once and
   * then `empty` forever, and a consecutive-window monitor could never fire on
   * the failure it exists to catch.
   */
  let importsInFlight = 0;
  const failedGroupCounts = new Map<ImportGroupLabel, number>();
  /**
   * ISS-6336 collector ingest failures for the window, keyed by reason — and,
   * since ISS-12036, by the fold site a parse-quality reason attributes to.
   *
   * Still bounded by construction: both halves of the key are closed contract
   * sets, so the map can never hold more entries than their product (six reasons
   * × four sites plus unattributed). Keyed on the PAIR because the site is one
   * value on a record whose count measures SESSIONS — a window where two
   * sessions degraded at different sites needs two records, each with its own
   * site, and summing them still gives the number of degraded sessions.
   */
  const ingestFailureCounts = new Map<string, IngestFailureTally>();
  /**
   * `(session, reason)` pairs that already moved an ingest-failure counter THIS
   * window, so a standing parse defect — or an ISS-5822 payload clamp, which
   * recurs on every re-parse of the same oversized transcript — is counted once
   * per window rather than once per import.
   *
   * Keyed on the PAIR, not the session (ISS-5822, codex review). A session's
   * degradations are independent and need not arrive together: a live transcript
   * is parse-degraded from the first line it loses, and only later grows past
   * the worker response budget and starts coming back clamped. A per-session key
   * records whichever reason arrived first and suppresses the other for the rest
   * of the window, so `session_payload_clamped` reads empty for exactly the
   * recurring live-import population it was added to make visible.
   *
   * Without it the counter measures import FREQUENCY, not failure incidence: a
   * live session with one corrupt line is re-parsed and re-imported on every
   * watcher write, so one bad transcript in an active workspace outweighs many
   * bad transcripts in a quiet one — and a monitor watching for a
   * harness-upgrade regression cannot tell the two apart. Cleared on every tick
   * and on dispose, and capped, so an unbounded corpus cannot grow it without
   * limit; past the cap the window degrades to the un-deduped count, which at
   * that scale is already far beyond any threshold worth reading precisely.
   */
  const qualityCountedReasons = new Set<string>();
  /** Sentinel ids seen at the previous tick; null until the first tick runs. */
  let previousPendingIds: ReadonlySet<string> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const logFailure = (what: string, error: unknown): void => {
    options.log?.(
      `import-health ${what} failed: ${error instanceof Error ? error.message : String(error)}`
    );
  };

  /**
   * Sample the sentinel and re-snapshot for the next comparison. `survivors` is
   * how many ids outlived a full tick — 0 on the first tick, where no prior
   * snapshot exists and nothing can be PROVEN stuck yet.
   *
   * `unprovenBacklog` is that first tick's OTHER fact: rows are parked at the
   * sentinel but survivorship cannot be computed yet. It exists so a process
   * that quits inside one tick window — whose only record is that baseline tick
   * — does not report `empty` while a backlog sits there. It is deliberately
   * false from the second tick on, where survivorship IS provable and a merely
   * mid-import row must not be counted as stuck.
   */
  const samplePendingSentinel = async (): Promise<{
    survivors: number;
    unprovenBacklog: boolean;
  }> => {
    const current = new Set(
      await options.listPendingRevisionSessionIds(IMPORT_PENDING_SNAPSHOT_LIMIT)
    );
    const previous = previousPendingIds;
    previousPendingIds = current;
    if (previous === null) {
      return { survivors: 0, unprovenBacklog: current.size > 0 };
    }
    let survivors = 0;
    for (const id of current) {
      if (previous.has(id)) {
        survivors++;
      }
    }
    return { survivors, unprovenBacklog: false };
  };

  /**
   * Report a window we could not summarize. Kept distinct from silence: after
   * ISS-6335 a missing pass record means the process stopped reporting, so a
   * failed sentinel sample has to say so rather than look like a healthy idle
   * window. The survivor count is omitted, never zeroed — it was not computed.
   * Guarded on its own because the caller's catch may have been entered by a
   * throwing emit seam, which would throw again here. Skipped entirely once
   * disposed: a read that rejects after teardown would otherwise raise the
   * fleet's error rate on every slow quit.
   */
  const emitUncomputedWindow = (incomplete: number): void => {
    if (disposed) {
      return;
    }
    try {
      options.emitImportHealth({
        kind: ImportHealthEvent.Pass,
        outcome: ImportOutcome.Error,
        sessionsIncomplete: incomplete,
      });
    } catch (error) {
      logFailure("uncomputed-window emit", error);
    }
  };

  /** One best-effort harness record; a dispatch failure never reaches a sibling. */
  const emitOne = (
    input: DesktopImportHealthEventInput,
    label = "harness progress emit"
  ): void => {
    try {
      options.emitImportHealth(input);
    } catch (error) {
      logFailure(label, error);
    }
  };

  /**
   * ISS-6116: the harness-scoped half of a settled window. `sources_remaining`
   * is UNGATED — a gauge that only spoke when something happened could not
   * separate "nothing to do" from "wedged" from "stopped reporting", the same
   * collapse ISS-6335 removed from the pass record. Guarded separately from the
   * sentinel path, which it shares no inputs with.
   */
  const emitHarnessProgress = (): void => {
    if (disposed) {
      // These read LIVE collector state rather than a drained window tally, so
      // unlike the group counters they would keep reporting a torn-down
      // process's backfill if a late tick got this far.
      return;
    }
    let report: IngestHarnessProgressReport[];
    try {
      report = options.reportHarnessProgress?.() ?? [];
    } catch (error) {
      // The seam reaches into the collector manager, so a teardown race can
      // reject here. Best-effort per the exporter-boundary rule: never reach the
      // import pipeline, and never take the pass record down with it.
      logFailure("harness progress report", error);
      return;
    }
    for (const harness of report) {
      if (!isTelemetryHarnessName(harness.harness)) {
        // A collector key the contract's closed set has not learned is dropped
        // rather than widening the label space. Logged locally, never shipped.
        options.log?.(
          `import-health harness report: unknown harness key ${harness.harness}`
        );
        continue;
      }
      // The breach goes FIRST and in its own guard. It is the record an alert
      // reads, so it must not be made conditional on the gauge's emit
      // succeeding — one shared `try` would drop it on any gauge failure.
      if (harness.notAdvancing) {
        emitOne({
          kind: ImportHealthEvent.HarnessNotAdvancing,
          harness: harness.harness,
          ...(harness.remaining === undefined
            ? {}
            : { sourcesRemaining: harness.remaining }),
        });
      }
      if (harness.remaining !== undefined) {
        emitOne({
          kind: ImportHealthEvent.SourcesRemaining,
          harness: harness.harness,
          sourcesRemaining: harness.remaining,
        });
      }
    }
  };

  /** Never rejects: every failure path is caught and (optionally) logged. */
  const tick = async (): Promise<void> => {
    const incomplete = sessionsIncomplete;
    const progressed = importsProgressed;
    const unlanded = importsUnlanded;
    const groupCounts = [...failedGroupCounts.entries()];
    const ingestFailures = [...ingestFailureCounts.values()];
    sessionsIncomplete = 0;
    importsProgressed = 0;
    importsUnlanded = 0;
    failedGroupCounts.clear();
    // First, and outside the sentinel path: the harness records describe the
    // backfill, which is exactly what a failing sentinel read cannot report on.
    emitHarnessProgress();
    ingestFailureCounts.clear();
    qualityCountedReasons.clear();
    // Emitted BEFORE the sentinel block and in their own per-record guard. The
    // counters are already drained, so a throwing group emit — or a sentinel
    // read that rejects and returns early — would otherwise discard this
    // window's ingest failures permanently instead of losing just the record
    // that actually failed.
    for (const tally of ingestFailures) {
      try {
        options.emitImportHealth({
          kind: ImportHealthEvent.IngestFailed,
          reason: tally.reason,
          count: tally.count,
          // Omitted, never nulled: an unattributable degradation and a
          // `source_*` reason both reach here with no site.
          ...(tally.degradedSite === undefined
            ? {}
            : { degradedSite: tally.degradedSite }),
        });
      } catch (error) {
        logFailure("ingest-failure emit", error);
      }
    }
    let sentinel: { survivors: number; unprovenBacklog: boolean };
    let quarantined: QuarantinedStageCounts | undefined;
    try {
      for (const [groupLabel, count] of groupCounts) {
        options.emitImportHealth({
          kind: ImportHealthEvent.GroupFailed,
          groupLabel,
          count,
        });
      }
      sentinel = await samplePendingSentinel();
      // In the same guard as the sentinel read on purpose: a gauge this window
      // could not measure must reach `emitUncomputedWindow` and be OMITTED,
      // never shipped as a zero. Zero is a real claim here — "nothing is
      // quarantined" — and the whole reason the gauge is emitted at zero is
      // that readers are meant to trust it.
      quarantined = options.readQuarantinedCounts?.();
    } catch (error) {
      // Best-effort: a failed sentinel sample or a throwing emit seam must never
      // reach the import pipeline. Group records already emitted stand, and the
      // window is reported as `error` rather than shipped with a pending count
      // we could not compute.
      logFailure("tick", error);
      emitUncomputedWindow(incomplete);
      return;
    }
    // Re-checked AFTER the await, not only on entry: `raceShutdownDeadline`
    // abandons a slow final tick and lets `dispose()` run, so this can resume on
    // a torn-down tracker — where an `empty` record would read as a healthy idle
    // install.
    if (disposed) {
      return;
    }
    try {
      options.emitImportHealth({
        kind: ImportHealthEvent.Pass,
        outcome: resolveImportOutcome({
          inFlight: importsInFlight,
          progressed,
          unlanded,
          survivors: sentinel.survivors,
          unprovenBacklog: sentinel.unprovenBacklog,
        }),
        sessionsIncomplete: incomplete,
        sessionsPendingRevision: sentinel.survivors,
        ...(quarantined ? { quarantinedByStage: quarantined } : {}),
      });
    } catch (error) {
      // Per the `emitImportHealth` contract a throw is a PRE-dispatch failure,
      // so nothing shipped for this window. Leaving it silent would say the
      // process stopped reporting, which is the one thing silence now means.
      logFailure("pass emit", error);
      emitUncomputedWindow(incomplete);
    }
  };

  const startTicking = (): void => {
    if (disposed || tickTimer) {
      return;
    }
    tickTimer = setInterval(() => {
      tick().catch((error: unknown) => logFailure("scheduled tick", error));
    }, tickMs);
    tickTimer.unref?.();
  };

  const noteIngestFailure = (
    reason: ImportIngestFailure,
    degradedSite?: ImportParseDegradedSite
  ): void => {
    if (disposed) {
      return;
    }
    const key = ingestFailureKey(reason, degradedSite);
    const tally = ingestFailureCounts.get(key);
    if (tally) {
      tally.count += 1;
      return;
    }
    ingestFailureCounts.set(key, { reason, degradedSite, count: 1 });
  };

  const noteWatchLost = (harness: string): void => {
    if (disposed) {
      return;
    }
    if (!isTelemetryHarnessName(harness)) {
      // A harness outside the contract's set means the collectors gained one the
      // contract has not learned — a code defect a guard test already fails on,
      // not a runtime condition to widen `harness.name` for. Said out loud on
      // the collector log the way the harness-progress path says its own drop:
      // sharing that path's PREDICATE while silently dropping would leave a
      // harness's watch-lost telemetry gone with nothing anywhere saying why.
      options.log?.(`import-health watch lost: unknown harness key ${harness}`);
      return;
    }
    emitOne({ kind: ImportHealthEvent.WatchLost, harness }, "watch lost emit");
  };

  const noteMaterializeOutcome = (
    harness: TelemetryHarnessName,
    kind: MaterializeImportHealthEvent
  ): void => {
    if (disposed) {
      return;
    }
    emitOne({ kind, harness }, "materialize outcome emit");
  };

  /**
   * ISS-6336: the session-quality half, read off the session the collector is
   * OFFERING rather than off the result.
   *
   * Counted at the offer and not after the import lands, because the two answer
   * different questions and only this one is answerable: `parseQuality` and
   * ISS-5822's `payloadClamped` are both properties of what reached this process,
   * so they are already true here — while the session whose import wedges never
   * returns a result at all, which is exactly the population these counters exist
   * to make visible. Nothing is counted for a clean, unclamped session:
   * `sessionIngestFailures` returns an empty list, and the loop below never runs.
   *
   * KNOWN LIMIT, ISS-7625 (whitlockk review): this is per-SESSION, so a transcript
   * whose every line is malformed never reaches it. Both parsers compute the
   * counts and then discard them with a `null` return — no usable timestamp —
   * their collectors turn that into an empty session list, and the manager marks
   * the source seen. Closing it means carrying parse quality on the SOURCE parse
   * outcome, across the historical-parse worker boundary, which is why it is a
   * separate change and not a wider guard here.
   */
  const observeSessionQuality = (session: NormalizedSession): void => {
    const reasons = sessionIngestFailures(session);
    if (reasons.length === 0) {
      return;
    }
    // ISS-12036: computed ONCE per session, not per reason — it is a property of
    // the session's parse quality, and `degraded`/`unreadable` are mutually
    // exclusive so at most one reason ever carries it.
    const site = parseDegradedSite(session.parseQuality);
    // Filtered BEFORE recording, and recorded only for reasons this session has
    // actually warranted: adding every offered session to the set would fill the
    // cap with clean sessions and stop deduping the degraded ones it exists for.
    for (const reason of reasons) {
      const key = sessionReasonKey(session.sessionId, reason);
      if (qualityCountedReasons.has(key)) {
        continue;
      }
      // Recorded and counted in the SAME branch, so past the cap the window
      // degrades to the un-deduped count rather than silently dropping a reason
      // it declined to remember.
      if (qualityCountedReasons.size < SESSION_QUALITY_DEDUPE_LIMIT) {
        qualityCountedReasons.add(key);
      }
      noteIngestFailure(
        reason,
        PARSE_QUALITY_ATTRIBUTED_REASONS.has(reason) ? site : undefined
      );
    }
  };

  const observe = (result: ImportResult): void => {
    if (disposed) {
      // `importSessionBounded` abandons — never cancels — a timed-out import, so
      // its result can land long after teardown. Ignoring it here keeps a late
      // arrival from resurrecting the timer we just stopped.
      return;
    }
    if (isDurableImportProgress(result)) {
      importsProgressed++;
    } else if (result.unchanged !== true) {
      importsUnlanded++;
    }
    if (result.incomplete) {
      sessionsIncomplete++;
    }
    for (const label of result.failedGroups ?? []) {
      // Cardinality cap: an out-of-set label (a write-core group added before
      // the contract learns it) degrades to the closed set's `unknown` bucket.
      const mapped = KNOWN_IMPORT_GROUP_LABELS.has(label)
        ? (label as ImportGroupLabel)
        : ImportGroupLabel.Unknown;
      failedGroupCounts.set(mapped, (failedGroupCounts.get(mapped) ?? 0) + 1);
    }
  };

  startTicking();

  return {
    wrapImporter(importer: Importer): Importer {
      // Forward EVERY argument, including `reason` (the diagnostic Error the
      // bounded-import timeout passes) — dropping it loses the eviction
      // diagnostic.
      //
      // Written out rather than `.bind(importer)`, which looks tidier and is a
      // trap here: in production this importer is the db-host ES Proxy, whose
      // `get` trap answers EVERY property path. `.bind` is not a real method on
      // it — reading it mints the op path `importer.cancelInFlightWrite.bind`,
      // and calling that fires an IPC invoke with the proxy itself as an
      // argument, which cannot be structured-cloned. That wedges the db-host
      // client and every later database read with it. Only `get`-then-`apply`
      // is safe on this object.
      const forwardCancel = importer.cancelInFlightWrite
        ? (sessionId: string, reason?: Error) =>
            importer.cancelInFlightWrite?.(sessionId, reason) ??
            WriteQueueCancelOutcome.None
        : undefined;
      // ISS-7256: the collector manager only ever sees this wrapper, so a hook
      // this decorator does not forward does not exist in production. Same
      // get-then-apply shape as the cancel forward above, for the same
      // db-host-proxy reason.
      const forwardHasUndispatchedWrite = importer.hasUndispatchedWrite
        ? (sessionId: string) =>
            importer.hasUndispatchedWrite?.(sessionId) ?? ABSENT_WRITE_PROBE
        : undefined;
      return {
        importSession: async (session, harness, parsePolicy) => {
          importsInFlight++;
          try {
            // Inside the guarded block, not between the increment and it: a
            // throw from here must still reach the `finally` that pairs the
            // gauge, or one bad session leaks the gauge and wedges every later
            // window at `wedged`.
            try {
              observeSessionQuality(session);
            } catch (error) {
              logFailure("observe session quality", error);
            }
            const result = await importer.importSession(
              session,
              harness,
              parsePolicy
            );
            try {
              observe(result);
            } catch (error) {
              logFailure("observe", error);
            }
            return result;
          } catch (error) {
            // A rejection settled without landing anything; it marks THIS
            // window rather than holding the gauge up for every later one.
            if (!disposed) {
              importsUnlanded++;
            }
            throw error;
          } finally {
            // Paired with the increment above on EVERY settled outcome,
            // rejection included.
            importsInFlight--;
          }
        },
        ...(forwardCancel ? { cancelInFlightWrite: forwardCancel } : {}),
        ...(forwardHasUndispatchedWrite
          ? { hasUndispatchedWrite: forwardHasUndispatchedWrite }
          : {}),
      };
    },
    noteIngestFailure,
    noteWatchLost,
    noteMaterializeOutcome,
    flushNow(): Promise<void> {
      return tick();
    },
    dispose(): void {
      disposed = true;
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      sessionsIncomplete = 0;
      importsProgressed = 0;
      importsUnlanded = 0;
      failedGroupCounts.clear();
      ingestFailureCounts.clear();
      qualityCountedReasons.clear();
      previousPendingIds = null;
      // `importsInFlight` is deliberately left alone: its outstanding promises
      // survive teardown, and zeroing it here would let a later settle drive the
      // gauge negative. Nothing reads it after dispose — `tick()` emits nothing.
    },
  };
}

/** The slice of the agent database import-health tracking reads. */
export type ImportHealthDatabase = {
  importer: Importer;
  listImportPendingSessionIds: (limit: number) => Promise<string[]>;
};

export type InstallImportHealthTrackingOptions = {
  /**
   * Best-effort emit seam, wired to the desktop OTel runtime. Undefined in
   * contexts with no telemetry runtime, in which case tracking is not installed
   * at all — no tally, and no sentinel sampling.
   */
  emitImportHealth?: (input: DesktopImportHealthEventInput) => void;
  database: ImportHealthDatabase;
  /** ISS-6116: see {@link ImportHealthTrackerOptions.reportHarnessProgress}. */
  reportHarnessProgress?: () => IngestHarnessProgressReport[];
  /** ISS-6336: see `ImportHealthTrackerOptions.readQuarantinedCounts`. */
  readQuarantinedCounts?: () => QuarantinedStageCounts;
  log: (message: string) => void;
};

export type InstalledImportHealthTracking = {
  importer: Importer;
  /**
   * ISS-6336: the collector engine's report seam, handed to `CollectorManager`
   * as `onIngestFailure`. A no-op when no telemetry seam was wired, exactly as
   * the undecorated importer above is.
   */
  noteIngestFailure: (reason: ImportIngestFailure) => void;
  /**
   * ISS-8600: the collector engine's watch-lost seam, handed to
   * `CollectorManager` as `onWatchLost`. A no-op when no telemetry seam was
   * wired, exactly as {@link noteIngestFailure} is.
   */
  noteWatchLost: (harness: string) => void;
  /**
   * ISS-8600: the transcript lane's materialize-outcome seam, reached from the
   * discovery sweep through the agent-dashboard runtime. A no-op when no
   * telemetry seam was wired.
   *
   * The harness is supplied by the lane's own wiring, which is the layer that
   * knows which store it materializes — see the tracker method it forwards to.
   */
  noteMaterializeOutcome: (
    harness: TelemetryHarnessName,
    kind: MaterializeImportHealthEvent
  ) => void;
  /**
   * Drain the tally and stop sampling. Awaited on the shutdown path, which runs
   * while the DB host and the OTel relay are both still alive, so a failure
   * inside the last tick window still reaches the relay on a clean quit.
   */
  shutdown: () => Promise<void>;
};

/**
 * Wire import-health tracking for the agent-dashboard runtime: returns the
 * importer to hand the collector manager (decorated when a telemetry seam
 * exists, the database's own importer when it does not) plus the shutdown hook.
 */
export function installImportHealthTracking(
  options: InstallImportHealthTrackingOptions
): InstalledImportHealthTracking {
  const emitImportHealth = options.emitImportHealth;
  if (!emitImportHealth) {
    return {
      importer: options.database.importer,
      noteIngestFailure: () => undefined,
      noteWatchLost: () => undefined,
      noteMaterializeOutcome: () => undefined,
      shutdown: () => Promise.resolve(),
    };
  }
  const tracker = createImportHealthTracker({
    emitImportHealth,
    listPendingRevisionSessionIds: (limit) =>
      options.database.listImportPendingSessionIds(limit),
    ...(options.reportHarnessProgress
      ? { reportHarnessProgress: options.reportHarnessProgress }
      : {}),
    ...(options.readQuarantinedCounts
      ? { readQuarantinedCounts: options.readQuarantinedCounts }
      : {}),
    log: options.log,
  });
  return {
    importer: tracker.wrapImporter(options.database.importer),
    noteIngestFailure: (reason) => tracker.noteIngestFailure(reason),
    noteWatchLost: (harness) => tracker.noteWatchLost(harness),
    noteMaterializeOutcome: (harness, kind) =>
      tracker.noteMaterializeOutcome(harness, kind),
    shutdown: async () => {
      // BOUNDED, always. The final tick does a db-host read while the db host is
      // being torn down around us, and an unbounded await here would hang
      // process exit — the ISS-4585 failure mode (`desktop-dev` force-killed
      // with SIGKILL 137) that `raceShutdownDeadline` exists to prevent. A
      // dropped last tick is an acceptable loss; a quit that never finishes is
      // not. `dispose()` still runs either way, so the interval is always
      // cleared.
      await raceShutdownDeadline(tracker.flushNow());
      tracker.dispose();
    },
  };
}

/**
 * Classify one tally window. `progressed` beats everything: an install that
 * durably imported something is advancing, whatever else is also true — the
 * counts on the same record carry the rest, and an outcome that flipped to
 * `wedged` on any lingering sentinel row would fire forever on an install with
 * one stray orphan.
 *
 * Otherwise the wedge is any of: an import that settled this window without
 * landing what it needed to (`unlanded`), an import still outstanding from ANY
 * earlier window (`inFlight`, the only term that outlives the window reset and
 * so the only one a never-settling import keeps raising), rows provably stuck at
 * the sentinel, or — first tick only — rows parked there with survivorship not
 * yet computable. A window with nothing left to explain is empty.
 *
 * ISS-12036: a byte-identical re-offer (`unchanged`) is neither progress nor a
 * wedge, so it is not `unlanded`. Both terms are counted at SETTLE, from the
 * same result, so they always describe the same window; a no-op entered in one
 * window and settled in the next cannot cancel a genuine refusal there.
 */
function resolveImportOutcome(tallyWindow: {
  inFlight: number;
  progressed: number;
  unlanded: number;
  survivors: number;
  unprovenBacklog: boolean;
}): ImportOutcome {
  if (tallyWindow.progressed > 0) {
    return ImportOutcome.Imported;
  }
  if (
    tallyWindow.unlanded > 0 ||
    tallyWindow.inFlight > 0 ||
    tallyWindow.survivors > 0 ||
    tallyWindow.unprovenBacklog
  ) {
    return ImportOutcome.Wedged;
  }
  return ImportOutcome.Empty;
}

/**
 * ISS-6116: the cardinality cap on `harness.name`. The tracker is deliberately
 * harness-agnostic and keys by `string`, so this is where the closed set is
 * enforced. A desktop guard test asserts the collector `Harness` enum and the
 * contract's set are equal, so a false answer means the collector gained a
 * harness the contract has not learned — a code defect, not a runtime condition.
 */
function isTelemetryHarnessName(key: string): key is TelemetryHarnessName {
  return KNOWN_TELEMETRY_HARNESS_NAMES.has(key);
}

/**
 * ISS-5822: the per-window dedupe key, `reason` FIRST.
 *
 * A session id is arbitrary text; an `ImportIngestFailure` is a member of a
 * closed contract enum. Putting the bounded half first, behind a NUL that
 * neither half can contain, keeps the encoding injective whatever the id holds
 * and for any reason the contract adds later — where id-first would only be
 * collision-free as long as no reason is ever a separator-preceded suffix of
 * another, which is a property of today's set rather than of the encoding. A
 * collision here would dedupe one session's real degradation away as another's
 * repeat, so it is worth not depending on an audit.
 *
 * The separator is the `\u0000` ESCAPE, never a raw NUL byte: a raw one inside
 * git's binary-detection window makes `git diff` render this whole file as
 * "Binary files differ" and hides every later change from review
 * (`no-raw-nul-byte`, `pnpm check:source-gates`).
 *
 * Never emitted: this string is a Set key inside this process, so PRD-389 §8's
 * "no session ids on the wire" is untouched — the record still carries only the
 * closed-enum reason and a count.
 */
function sessionReasonKey(
  sessionId: string,
  reason: ImportIngestFailure
): string {
  return `${reason}\u0000${sessionId}`;
}

/**
 * ISS-7256: what the dispatch probe reports when the wrapped importer's own hook
 * answers nothing.
 *
 * `Absent` and not `Queued`: an unanswered probe is no evidence that this
 * session is waiting, and the bound must never extend a deadline on no evidence.
 * Matches the `WriteQueueCancelOutcome.None` default the eviction forward above
 * uses for the same reason.
 */
const ABSENT_WRITE_PROBE: WriteDispatchProbe = {
  state: WriteDispatchState.Absent,
  taskSeq: null,
};

/**
 * ISS-12036: one window's tally for one (reason, fold site) pair.
 *
 * The site rides ON the tally rather than being re-derived at emit time, because
 * by then the sessions it was read from are gone — the window holds counts, not
 * records.
 */
type IngestFailureTally = {
  reason: ImportIngestFailure;
  degradedSite: ImportParseDegradedSite | undefined;
  count: number;
};

/**
 * ISS-12036: the reasons a fold site actually describes.
 *
 * Only the two parse-quality reasons are about a session's folded FILES. A
 * `source_*` reason describes a source that produced no session at all, and
 * `session_records_unrouted` / `session_payload_clamped` describe lines that
 * parsed fine and were lost later — attaching a corruption site to any of them
 * would publish an answer to a question they do not ask.
 *
 * A `ReadonlySet` derived from an exhaustive `Record` over the closed reason set,
 * so a reason added to the contract fails `tsc` here until someone decides
 * whether a site describes it.
 */
const PARSE_QUALITY_SITE_APPLIES: Record<ImportIngestFailure, boolean> = {
  [ImportIngestFailure.SourceParseThrew]: false,
  [ImportIngestFailure.SourceParseTimedOut]: false,
  [ImportIngestFailure.SessionParseDegraded]: true,
  [ImportIngestFailure.SessionParseUnreadable]: true,
  [ImportIngestFailure.SessionRecordsUnrouted]: false,
  [ImportIngestFailure.SessionPayloadClamped]: false,
};

const PARSE_QUALITY_ATTRIBUTED_REASONS: ReadonlySet<ImportIngestFailure> =
  new Set(
    Object.entries(PARSE_QUALITY_SITE_APPLIES)
      .filter(([, applies]) => applies)
      .map(([reason]) => reason as ImportIngestFailure)
  );

/**
 * ISS-12036: the window key for one (reason, fold site) pair.
 *
 * Same shape and the same reason as {@link sessionReasonKey} above: the NUL
 * escape separates two halves that are both closed enum members, so the
 * encoding is injective whatever members the contract gains. An absent site is
 * its own bucket, distinct from every named one.
 */
function ingestFailureKey(
  reason: ImportIngestFailure,
  degradedSite: ImportParseDegradedSite | undefined
): string {
  return `${reason}\u0000${degradedSite ?? ""}`;
}
