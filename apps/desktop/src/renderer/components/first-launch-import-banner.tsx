import { cn } from "@closedloop-ai/design-system/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type IngestProgress,
  useIngestProgress,
  useMaintenanceProgress,
} from "../hooks/use-ingest-progress";
import { useTranscriptSyncStatus } from "../hooks/use-transcript-sync-status";
import { ImportSplashBody } from "./import-splash/import-splash-body";
import { ImportSplashCompact } from "./import-splash/import-splash-compact";
import { deriveImportSplashCompactState } from "./import-splash/import-splash-compact-state";
import {
  deriveImportSplashState,
  type ImportSplashState,
} from "./import-splash/import-splash-state";
import { useImportSplashCollapsed } from "./import-splash/use-import-splash-collapsed";

// Hold the completed bar at 100% briefly before collapsing, so the import reads
// as "finished" rather than vanishing mid-stream.
const SETTLE_HOLD_MS = 900;
// A first-launch backfill begins within the first moments of boot. If none has
// appeared within this window, this is an ordinary launch; stop polling so it
// never polls for the whole session.
const NO_IMPORT_GIVE_UP_MS = 120_000;
// Safety net: if an import was seen but it neither completes nor makes progress
// for this long (e.g. the collector stopped without ever reporting completion),
// surface the graceful partial-failure state so the splash can't hang on screen
// and poll forever. Generous enough that the brief gaps between staggered
// per-harness passes never trip it, and paused imports are excluded (no progress
// is expected while paused).
const STALL_GIVE_UP_MS = 120_000;
// How often the stall watcher polls for progress while an import is in flight.
const STALL_CHECK_INTERVAL_MS = 10_000;
// ISS-6118: how long the producer must hold BOTH its terminal `drained` signal
// and an aggregate at N of N before the splash accepts that as the end of the
// import, when `complete` has not arrived.
//
// The reachable gap this exists for is the watcher's SHARED DRAIN PROMISE
// staying open on queued live work after the historical pass has settled
// (wongk review). `complete` is gated on `Promise.allSettled` over each
// harness's first-import promise, and for a `"watcher"`-mode harness that
// promise is `queueImport(null)` — i.e. `ensureDrainingImports()`, the ONE
// promise shared by the whole drain loop, which resolves only once the loop
// finds no work of ANY kind left. A live file event that lands while the
// historical sweep is running keeps `pendingEvents` non-empty, so after
// `settlePass` the loop keeps running on the live batch and that shared promise
// stays pending — and `complete` with it. The tracker meanwhile is finished by
// its own rules: live batches import with `lowDutyImport: false` and the
// settled harness is out of `isFirstPassPending`, so they never touch it,
// leaving `drained` true and `total` fixed at N. Drained at N of N, `complete`
// false, indefinitely.
//
// The states the ORIGINAL rationale here named are all handled elsewhere and
// cannot reach this timer, which is why it no longer claims them: a watchdog
// timeout routes through `timedOut` straight to the failure path (see
// `resolveGiveUp`); a backfill parked on the pause gate keeps its `startedAt`
// entry, so `isDrained()` is false and the predicate never holds; and a
// `stop()` clears the tracker's progress map, which drops `drained` for the
// same reason.
//
// This cannot be keyed on `processed >= total` alone, which is the regression
// the `complete` coupling exists to avoid: the per-harness passes are staggered,
// so the aggregate is briefly at its total between one harness settling and the
// next registering. `drained` is the producer's own answer and is READ, never
// re-derived — but it too reports true inside that gap (a settled pass keeps its
// progress entry with no shortfall, and the next harness has no tracker
// footprint until its own deferred task fires), so it is confirmed across a
// window rather than trusted on one poll. Any harness registering inside the
// window drops `drained` or grows `total`, which disarms the timer.
//
// So the window is sized against that stagger, not against the live tail above:
// `historicalImportStaggerMs` is 1000ms per harness over the collector set, so
// the widest reachable gap is a few seconds. This is several times that, and
// still an order of magnitude inside the 120s window it replaces on this path.
const DRAINED_SETTLE_CONFIRM_MS = 15_000;
// FEA-2264: after the import settles the main process runs post-boot maintenance
// (data-revision rebuild + artifact-link backfill) — the residual window where
// the app still feels slow. The splash stays up with the Compute stage until
// that settles. This bridge covers the status-poll gap between the import
// completing and maintenance reporting active, so the splash never flickers
// closed in between; it comfortably exceeds the 1s poll interval.
const MAINTENANCE_BRIDGE_MS = 2500;
// Absolute safety cap so the Compute stage can't pin the splash open if the main
// process never reports maintenance finishing. The runtime always clears the
// flag on completion/cancel, so this is defense-in-depth; it is generous enough
// for a large first-launch rebuild + backfill.
const MAINTENANCE_GIVE_UP_MS = 15 * 60_000;
// ISS-5258: the expanded panel's id, referenced by the disclosure control that
// collapses it (`aria-controls`). Only set while the panel is rendered — the
// collapsed row's expand control has nothing on screen to point at, so it
// carries `aria-expanded={false}` and no dangling `aria-controls`.
const IMPORT_SPLASH_PANEL_ID = "first-launch-import-splash-panel";

type ImportBannerState = {
  total: number;
  processed: number;
  importing: boolean;
  active: boolean;
  settled: boolean;
  /**
   * ISS-5281: the MAIN PROCESS reporting that every first pass it began has
   * ended, nothing is scanning, and nothing was left for retry — so nothing
   * remains that COULD advance `processed`. Distinct from `settled`, which is the
   * main process confirming the boot import lifecycle itself finished.
   *
   * This is read straight off the payload rather than inferred from the counters
   * (wongk review). `processed >= total && !preparing` is a different claim and
   * false in three reachable places: `preparing` covers only a harness's FIRST
   * scan, so every yield/resume re-scans with it off while `processed === total`
   * and then grows `total`; a 0-total harness is filtered out of the aggregate
   * entirely, so a wedge there is invisible to it; and `settlePass` settles a
   * finished pass's bar to 100%, hiding any source it left retryable.
   */
  drained: boolean;
};

/**
 * Derive the banner's lifecycle state from the polled ingest payload.
 *
 * `complete` is the main process telling us every harness's boot import has
 * finished. The per-harness passes are staggered, so aggregate
 * `processed >= total` is briefly true between one harness finishing and the
 * next registering its sources; relying on `complete` keeps the splash up across
 * that gap instead of collapsing and missing the later harness.
 */
function deriveImportState(
  ingest: IngestProgress | null,
  sawImport: boolean
): ImportBannerState {
  const total = ingest?.total ?? 0;
  const processed = ingest?.processed ?? 0;
  const preparing = ingest?.preparing ?? false;
  const complete = ingest?.complete ?? false;
  const importing = total > 0 && processed < total;
  // A real import is or was in progress (`sawImport` latches across renders), or
  // it already finished before the first useful poll: a positive total with the
  // complete flag set still means a real import ran this launch, so the splash
  // (and its maintenance window) must engage even though we never observed the
  // mid-flight `importing` state.
  const seen = sawImport || importing || (complete && total > 0);
  return {
    total,
    processed,
    importing,
    // Visible from the first import until the whole boot import completes,
    // covering the pre-scan preparing phase and the staggered-harness gaps.
    active: importing || (preparing && total === 0) || (seen && !complete),
    settled: seen && complete,
    // ISS-5281 (wongk review): the producer's own answer, never re-derived here.
    // An older main process omits the field, which degrades to `false` — the
    // splash then reports the stall as a failure exactly as it did before, the
    // honest direction when we cannot prove the queue emptied.
    drained: ingest?.drained === true,
  };
}

/**
 * App-wide, non-blocking first-launch import splash. The local import runs in the
 * db-host child and can saturate the machine, so the app feels sluggish with no
 * explanation. This grows the earlier thin banner into the agreed splash design
 * (FEA-3645 / FEA-4057): a Scan → Import → Compute → Ready phase stepper, live
 * per-harness session counts from the real ingest breakdown, a graceful
 * partial-failure state, and a persistent on-device reassurance — while
 * inheriting the banner's engineering (the pause control, the off-main-thread
 * shimmer that keeps moving while the main thread is blocked, the post-boot
 * maintenance bridge). It auto-collapses once the import settles.
 *
 * It stays mounted inline in the app chrome (non-blocking): the app is usable
 * behind it, and the collectors keep running even after the splash is dismissed
 * or gives up.
 *
 * ISS-5258: the panel can be collapsed to `ImportSplashCompact` — one slim row
 * — because the splash's own "Runs in the background" copy and its
 * always-maximal height contradicted each other, pushing the Sessions content
 * below the fold for the whole import. The choice persists across navigation
 * and relaunch; the existing settle collapse still dismisses the whole thing at
 * Ready either way. ISS-6118 retired the `collapsible-import-splash` Labs flag
 * enabled, so this is unconditional and the component reads no flags at all.
 */
export function FirstLaunchImportBanner({
  // ISS-6241: read by `StartupReadinessBannerGate` and passed down, so this
  // component still reads no flags itself and its many bare test mounts keep
  // working without a `FeatureFlagAdapterProvider`. Defaults to the flag-off
  // behaviour: the Compute step renders its bare activity dot.
  showComputeProgress = false,
}: {
  showComputeProgress?: boolean;
} = {}) {
  const [done, setDone] = useState(false);
  // A hard stall the user chose to dismiss (Continue), or the stall give-up
  // fired. Latches the splash into the collapsed state without waiting on a poll.
  const [dismissed, setDismissed] = useState(false);
  // The stall give-up fired: surface the graceful partial-failure state.
  const [stalled, setStalled] = useState(false);
  // Local pause intent. The main-process flag is in-memory and the splash is the
  // only controller, so local state stays the source of truth and resets to
  // running on app restart (matching the main process).
  const [paused, setPaused] = useState(false);
  const togglePause = useCallback(() => {
    const next = !paused;
    setPaused(next);
    window.desktopApi?.setAgentMonitorImportPaused(next).catch(() => undefined);
  }, [paused]);
  // Dismissal (Continue, or the stall give-up) is terminal for the polling
  // lifecycle too, not just the visible panel: once dismissed there is nothing
  // left for the poll to drive, so stop the 1s status subscriptions rather than
  // leave them running for the whole session behind a collapsed panel.
  const pollEnabled = !(done || dismissed);
  const ingest = useIngestProgress(pollEnabled);
  // FEA-2264: the post-boot maintenance phase reported by the main process. The
  // splash stays up with the Compute stage across this window even though the
  // import itself has completed.
  const maintenance = useMaintenanceProgress(pollEnabled);
  const maintenanceActive = maintenance?.active === true;
  // Latches once we've observed maintenance running, so the collapse logic can
  // tell "maintenance finished" (seen, now inactive) apart from "maintenance has
  // not started yet" (never seen) during the bridge gap after the import settles.
  const sawMaintenance = useRef(false);
  if (maintenanceActive) {
    sawMaintenance.current = true;
  }
  // Latch only on a REAL import (total observed), never on a preparing-only
  // scan. A normal launch flags `preparing` during its scan but may find zero
  // pending sources (total stays 0); latching there would make `settled` stay
  // false and the no-import give-up below refuse to fire, leaving the hidden
  // splash polling for the whole session.
  const sawImport = useRef(false);
  const { total, processed, importing, active, settled, drained } =
    deriveImportState(ingest, sawImport.current);
  if (importing || settled) {
    sawImport.current = true;
  }
  const timedOut = ingest?.timedOut ?? false;
  // ISS-6118: the producer's terminal signal held across a window wider than the
  // staggered-harness gap. See DRAINED_SETTLE_CONFIRM_MS for why one poll of
  // `drained` (let alone `processed >= total`) is not enough to end the import.
  const atAggregateEnd = total > 0 && processed >= total;
  const [drainedConfirmed, setDrainedConfirmed] = useState(false);
  // Deliberately NOT gated on `paused` (wongk review). A pause the producer can
  // still act on is already excluded by `drained` itself: a pass parked on the
  // pause gate keeps its `startedAt` entry, so `isDrained()` reports false and
  // the predicate below never holds. By the time it DOES hold there is no
  // historical pass left to pause — only the live watcher tail, which is
  // unpausable by design ("only the historical (lowDuty) pass is pausable; live
  // watcher imports continue"). Reading the pause here would therefore only ever
  // pin a finished import open until Resume, over work the pause does not reach.
  useEffect(() => {
    if (!(drained && atAggregateEnd) || settled) {
      // A later harness registering drops `drained` or grows `total`, which
      // lands here and disarms — the gap can never confirm.
      setDrainedConfirmed(false);
      return;
    }
    const timer = window.setTimeout(
      () => setDrainedConfirmed(true),
      DRAINED_SETTLE_CONFIRM_MS
    );
    return () => window.clearTimeout(timer);
  }, [drained, atAggregateEnd, settled]);
  const { importSettled, gaveUp } = resolveGiveUp({
    stalled,
    timedOut,
    drained,
    settled,
    drainedConfirmed,
  });
  // A settled import (complete + seen, or drained past the give-up) implies a real
  // import ran, so the Compute stage is scoped to the first-launch flow: ordinary
  // launches never reach it and so never surface it, even though a quick
  // rebuild/backfill still runs every boot.
  const inMaintenancePhase =
    importSettled && (maintenanceActive || sawMaintenance.current);

  // Collapse once the import has settled AND no post-boot maintenance is (still)
  // running. While maintenance is active we never schedule the collapse, so the
  // splash holds on the Compute stage. The hold also bridges the brief poll gap
  // between the import completing and maintenance starting: if maintenance shows
  // up during the hold, `maintenanceActive` flips and this effect re-runs to
  // cancel the pending collapse. A longer bridge applies before maintenance is
  // first seen; once it has run and gone inactive, the short settle hold applies.
  useEffect(() => {
    if (!importSettled || maintenanceActive) {
      return;
    }
    const holdMs = sawMaintenance.current
      ? SETTLE_HOLD_MS
      : MAINTENANCE_BRIDGE_MS;
    const timer = window.setTimeout(() => setDone(true), holdMs);
    return () => window.clearTimeout(timer);
  }, [importSettled, maintenanceActive]);

  // Safety backstop: never collapse WHILE maintenance is actively reported (the
  // splash must stay visible across the whole post-boot maintenance window). This
  // cap only arms once the main process has stopped reporting maintenance active,
  // covering the case where the normal settle collapse above somehow does not
  // fire; main always clears the flag on completion/cancel. A still-active
  // maintenance phase, however long, keeps the splash up rather than being
  // collapsed by an elapsed-time ceiling.
  useEffect(() => {
    if (!inMaintenancePhase || maintenanceActive) {
      return;
    }
    const timer = window.setTimeout(
      () => setDone(true),
      MAINTENANCE_GIVE_UP_MS
    );
    return () => window.clearTimeout(timer);
  }, [inMaintenancePhase, maintenanceActive]);

  // Ordinary launch (no first-pass import): give up polling after the window.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!sawImport.current) {
        setDone(true);
      }
    }, NO_IMPORT_GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // Stall give-up: a seen import that neither completes nor advances for a bounded
  // window (e.g. the collector stopped without a completion signal) flips into the
  // graceful partial-failure state — what imported is still usable, and the user
  // can dismiss — instead of silently collapsing or hanging forever. A poll counts
  // the elapsed stall and resets the moment progress moves, so steady progress and
  // the brief staggered-harness gaps never trip it; paused imports are excluded.
  const complete = ingest?.complete ?? false;
  const latestProcessedRef = useRef(processed);
  useEffect(() => {
    latestProcessedRef.current = processed;
  }, [processed]);
  // This latch is the RENDERER's own no-movement heuristic and nothing else.
  // FEA-4156's watchdog `timedOut` used to be folded in here, which made the two
  // give-ups indistinguishable downstream and let a drained aggregate settle a
  // wedge the main process had authoritatively reported. It now reaches `failed`
  // directly through `gaveUp`, so it still surfaces the graceful partial-import
  // state immediately, without waiting out this window and without being
  // eligible for the drain settle. Paused is never a wedge (the watchdog re-arms
  // while paused), so that path is honored regardless of the pause guard below.
  useEffect(() => {
    if (done || paused || importSettled || complete || !sawImport.current) {
      return;
    }
    let lastSeen = latestProcessedRef.current;
    let stalledMs = 0;
    const id = window.setInterval(() => {
      if (latestProcessedRef.current === lastSeen) {
        stalledMs += STALL_CHECK_INTERVAL_MS;
        if (stalledMs >= STALL_GIVE_UP_MS) {
          setStalled(true);
        }
      } else {
        // Progress resumed: reset the stall accounting AND clear a stall that
        // already tripped, so a temporarily-wedged import that recovers drops
        // back out of the partial-failure state instead of staying failed.
        lastSeen = latestProcessedRef.current;
        stalledMs = 0;
        setStalled(false);
      }
    }, STALL_CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [done, paused, importSettled, complete]);

  const handleContinue = useCallback(() => setDismissed(true), []);
  // ISS-5258: the persisted collapsed/expanded choice.
  const { collapsed, collapse, expand, surfaceRef } =
    useImportSplashCollapsed();

  const failed = gaveUp && !importSettled;
  // ISS-5281: `failed` keeps the splash on screen in its own right. The watchdog
  // can report a wedge before any harness ever registered a total — a scan that
  // froze — in which case `active` is false and `importSettled` is false, and the
  // splash used to render the partial-import state into a collapsed, inert
  // container: a failure the user is told about but cannot reach the Continue
  // button for. A state worth rendering is worth being visible.
  const visible = !(done || dismissed) && (active || importSettled || failed);
  // Pause only governs the import collector; during maintenance there is nothing
  // to pause, so the rail keeps animating regardless of any earlier pause intent.
  const railPaused = paused && !inMaintenancePhase;
  // Hold the overall rail monotonic across polls: as later harnesses register
  // their session totals the aggregate denominator jumps, which would drop the
  // raw ratio and make the fill visibly retreat (reads as broken). Latch the
  // running max here — the component owns cross-poll memory — and floor the
  // derived rail at it. The "N / M sessions" count still grows honestly.
  const maxOverallPctRef = useRef(0);
  const rawOverallPct =
    total > 0 ? Math.min(100, (processed / total) * 100) : 0;
  if (rawOverallPct > maxOverallPctRef.current) {
    maxOverallPctRef.current = rawOverallPct;
  }
  // ISS-4716: gate the status poll on the splash actually being on screen. This
  // component never unmounts (`visible` only drives opacity/max-height/inert),
  // so an ungated poll would hit the db-host worker every few seconds for the
  // whole session. ISS-5348 dropped the retired Labs-flag conjunct along with
  // the flag itself, so visibility is now the only gate.
  const transcriptSync = useTranscriptSyncStatus(visible);
  const splashState = deriveImportSplashState({
    ingest,
    processed,
    total,
    paused,
    inMaintenancePhase,
    complete: importSettled && !inMaintenancePhase,
    maintenance,
    failed,
    minOverallPct: maxOverallPctRef.current,
    transcriptSync,
    showComputeProgress,
  });

  return (
    <div
      aria-hidden={!visible}
      className={`shrink-0 overflow-hidden transition-all duration-500 ease-out ${
        // 48rem is the collapse animation's finite ceiling — it must clear the
        // tallest state (the Failed state stacks the header, stepper, error
        // Alert, one row per harness, and Continue) so overflow-hidden never
        // clips the content. Larger than the visible content ever needs; only
        // the transition uses it.
        visible ? "max-h-[48rem] opacity-100" : "max-h-0 opacity-0"
      }`}
      data-testid="first-launch-import-banner"
      // Fully remove the collapsed splash from the tab order and the a11y tree,
      // so focus can't park on the now-invisible Continue/Pause controls (an
      // aria-hidden ancestor over focusable descendants is itself an a11y bug).
      inert={!visible}
    >
      {/* Collapsed, the compact row draws its own bottom edge in every state
          (ISS-5367 made that hairline unconditional there, once its rail stopped
          doubling as the edge), so a `border-b` here too would be two rules
          where the design wants one. Expanded, the panel has no edge of its own
          and this is it. */}
      <section
        aria-label="Importing your agent history"
        className={cn(
          "bg-primary/5",
          collapsed ? null : "border-border border-b"
        )}
        ref={surfaceRef}
      >
        <ImportSplashSurface
          collapsed={collapsed}
          onCollapse={collapse}
          onContinue={handleContinue}
          onExpand={expand}
          onTogglePause={togglePause}
          railPaused={railPaused}
          state={splashState}
        />
      </section>
    </div>
  );
}

type ImportSplashSurfaceProps = {
  state: ImportSplashState;
  railPaused: boolean;
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  onTogglePause: () => void;
  onContinue: () => void;
};

/**
 * ISS-5258: pick the collapsed row or the expanded panel.
 *
 * Split out of `FirstLaunchImportBanner` so that component stays the lifecycle
 * orchestrator (polls, latches, give-up timers) and does not also carry the
 * presentation branch.
 */
function ImportSplashSurface({
  state,
  railPaused,
  collapsed,
  onCollapse,
  onExpand,
  onTogglePause,
  onContinue,
}: ImportSplashSurfaceProps) {
  if (collapsed) {
    return (
      <ImportSplashCompact
        onContinue={onContinue}
        onExpand={onExpand}
        onTogglePause={onTogglePause}
        railPaused={railPaused}
        state={deriveImportSplashCompactState(state)}
      />
    );
  }
  return (
    <ImportSplashBody
      onCollapse={onCollapse}
      onContinue={onContinue}
      onTogglePause={onTogglePause}
      panelId={IMPORT_SPLASH_PANEL_ID}
      railPaused={railPaused}
      state={state}
    />
  );
}

/**
 * ISS-5281: reconcile the two give-ups against the producer's terminal signal.
 *
 * `stalled` is the RENDERER's own no-movement heuristic. It watches only whether
 * `processed` advances, and nothing can advance once every begun pass has ended,
 * so on a drained run it is guaranteed to fire eventually and what it caught is a
 * completion the boot-import lifecycle has not reported yet, not a halt. The
 * splash used to render exactly that as "Import didn't finish — Stopped after 90
 * of 90" while its own per-harness rows all read complete.
 *
 * `timedOut` is deliberately NOT eligible for that settle (review). It is not a
 * movement heuristic: the main-process watchdog watches whether every harness's
 * first-import promise SETTLED, and it fires only after
 * DEFAULT_BOOT_IMPORT_WATCHDOG_MS (30 minutes), at which point main is
 * authoritatively reporting a wedged harness. FEA-4156's contract is that this is
 * the degraded signal and must surface the graceful partial-import state, so it
 * stays on the failure path even when the aggregate happens to read drained —
 * which it can, because a harness wedged where the aggregate does not account for
 * it (a 0-total harness `snapshot()` filters out) contributes nothing to
 * `processed`/`total`.
 */
function resolveGiveUp({
  stalled,
  timedOut,
  drained,
  settled,
  drainedConfirmed,
}: {
  stalled: boolean;
  timedOut: boolean;
  drained: boolean;
  settled: boolean;
  /**
   * ISS-6118: the producer reported `drained` at N of N continuously for
   * {@link DRAINED_SETTLE_CONFIRM_MS} — the state a watcher harness is left in
   * when its shared drain promise is still open on queued live work, so
   * `complete` cannot arrive. Reaches the same settle the stall heuristic does,
   * just without waiting out a 120s no-movement window for a queue the producer
   * has already said is empty. It is subject to the same `!timedOut` guard, so a
   * watchdog-reported wedge still resolves to failed.
   */
  drainedConfirmed: boolean;
}): { importSettled: boolean; gaveUp: boolean } {
  return {
    importSettled:
      settled || ((stalled || drainedConfirmed) && !timedOut && drained),
    // Either give-up, of either kind. Only the renderer's own may be settled
    // away by a drained queue; the watchdog's always resolves to failed.
    gaveUp: stalled || timedOut,
  };
}
