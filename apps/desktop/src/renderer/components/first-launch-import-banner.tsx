import { useCallback, useEffect, useRef, useState } from "react";
import {
  type IngestProgress,
  useIngestProgress,
  useMaintenanceProgress,
} from "../hooks/use-ingest-progress";
import { describeImportProgress } from "./import-progress-display";

// Hold the completed bar at 100% briefly before collapsing, so the import reads
// as "finished" rather than vanishing mid-stream.
const SETTLE_HOLD_MS = 900;
// A first-launch backfill begins within the first moments of boot. If none has
// appeared within this window, this is an ordinary launch; stop polling so it
// never polls for the whole session.
const NO_IMPORT_GIVE_UP_MS = 120_000;
// Safety net: if an import was seen but it neither completes nor makes progress
// for this long (e.g. the collector stopped without ever reporting completion),
// collapse so the banner can't hang on screen and poll forever. Generous enough
// that the brief gaps between staggered per-harness passes never trip it, and
// paused imports are excluded (no progress is expected while paused).
const STALL_GIVE_UP_MS = 120_000;
// How often the stall watcher polls for progress while an import is in flight.
const STALL_CHECK_INTERVAL_MS = 10_000;
// FEA-2264: after the import settles the main process runs post-boot maintenance
// (data-revision rebuild + artifact-link backfill) — the residual window where
// the app still feels slow. The banner stays up with calm copy until that
// settles. This bridge covers the status-poll gap between the import completing
// and maintenance reporting active, so the banner never flickers closed in
// between; it comfortably exceeds the 1s poll interval.
const MAINTENANCE_BRIDGE_MS = 2500;
// Absolute safety cap so the calm maintenance state can't pin the banner open if
// the main process never reports maintenance finishing. The runtime always
// clears the flag on completion/cancel, so this is defense-in-depth; it is
// generous enough for a large first-launch rebuild + backfill.
const MAINTENANCE_GIVE_UP_MS = 15 * 60_000;

type ImportBannerState = {
  total: number;
  processed: number;
  importing: boolean;
  active: boolean;
  settled: boolean;
};

/**
 * Derive the banner's display state from the polled ingest payload.
 *
 * `complete` is the main process telling us every harness's boot import has
 * finished. The per-harness passes are staggered, so aggregate
 * `processed >= total` is briefly true between one harness finishing and the
 * next registering its sources; relying on `complete` keeps the banner up across
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
  // complete flag set still means a real import ran this launch, so the banner
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
  };
}

/**
 * App-wide, non-blocking banner for the first-launch session backfill. The local
 * import runs in the db-host child and can saturate the machine, so the app
 * feels sluggish with no explanation. This surfaces the existing ingest progress
 * (the same data the dashboard loading card uses) with expectation-setting copy,
 * then auto-hides once the import settles.
 *
 * The progress rail carries a continuous CSS shimmer (ob-shimmer) on TOP of the
 * determinate fill. CSS animations run off the main thread, so the rail keeps
 * visibly moving even while the main thread is blocked and the count is frozen:
 * the difference between reading as "loading" versus "hung".
 */
export function FirstLaunchImportBanner() {
  const [done, setDone] = useState(false);
  // Local pause intent. The main-process flag is in-memory and the banner is the
  // only controller, so local state stays the source of truth and resets to
  // running on app restart (matching the main process).
  const [paused, setPaused] = useState(false);
  const togglePause = useCallback(() => {
    const next = !paused;
    setPaused(next);
    window.desktopApi.setAgentMonitorImportPaused(next).catch(() => undefined);
  }, [paused]);
  const ingest = useIngestProgress(!done);
  // FEA-2264: the post-boot maintenance phase reported by the main process. The
  // banner stays up with calm copy across this window even though the import
  // itself has completed.
  const maintenance = useMaintenanceProgress(!done);
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
  // banner polling for the whole session.
  const sawImport = useRef(false);
  const { total, processed, importing, active, settled } = deriveImportState(
    ingest,
    sawImport.current
  );
  // Latch on a real import: mid-flight (`importing`) or already settled (a
  // completed import we only caught after it finished). `settled` requires a
  // positive total, so an ordinary launch that finds nothing to import never
  // latches and the no-import give-up below can still collapse the banner.
  if (importing || settled) {
    sawImport.current = true;
  }
  // `settled` (import complete + seen) implies a real import ran, so the
  // maintenance copy is scoped to the first-launch flow: ordinary launches never
  // reach `settled` and so never surface the calm maintenance state, even though
  // a quick rebuild/backfill still runs every boot.
  const inMaintenancePhase =
    settled && (maintenanceActive || sawMaintenance.current);

  // Collapse once the import has settled AND no post-boot maintenance is (still)
  // running. While maintenance is active we never schedule the collapse, so the
  // banner holds with calm copy. The hold also bridges the brief poll gap
  // between the import completing and maintenance starting: if maintenance shows
  // up during the hold, `maintenanceActive` flips and this effect re-runs to
  // cancel the pending collapse. A longer bridge applies before maintenance is
  // first seen; once it has run and gone inactive, the short settle hold applies.
  useEffect(() => {
    if (!settled || maintenanceActive) {
      return;
    }
    const holdMs = sawMaintenance.current
      ? SETTLE_HOLD_MS
      : MAINTENANCE_BRIDGE_MS;
    const timer = window.setTimeout(() => setDone(true), holdMs);
    return () => window.clearTimeout(timer);
  }, [settled, maintenanceActive]);

  // Safety backstop: never collapse WHILE maintenance is actively reported (the
  // banner must stay visible across the whole post-boot maintenance window). This
  // cap only arms once the main process has stopped reporting maintenance active,
  // covering the case where the normal settle collapse above somehow does not
  // fire; main always clears the flag on completion/cancel. A still-active
  // maintenance phase, however long, keeps the banner up rather than being
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

  // Stall give-up: collapse if a seen import neither completes nor advances for
  // a bounded window (e.g. the collector stopped without a completion signal),
  // so the banner can't hang on screen and poll forever. A poll counts the
  // elapsed stall and resets the moment progress moves, so steady progress and
  // the brief staggered-harness gaps never trip it; paused imports are excluded.
  const complete = ingest?.complete ?? false;
  const latestProcessedRef = useRef(processed);
  useEffect(() => {
    latestProcessedRef.current = processed;
  }, [processed]);
  useEffect(() => {
    if (done || paused || settled || complete || !sawImport.current) {
      return;
    }
    let lastSeen = latestProcessedRef.current;
    let stalledMs = 0;
    const id = window.setInterval(() => {
      if (latestProcessedRef.current === lastSeen) {
        stalledMs += STALL_CHECK_INTERVAL_MS;
        if (stalledMs >= STALL_GIVE_UP_MS) {
          setDone(true);
        }
      } else {
        lastSeen = latestProcessedRef.current;
        stalledMs = 0;
      }
    }, STALL_CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [done, paused, settled, complete]);

  const visible = !done && (active || settled);
  // Pause only governs the import collector; during maintenance there is nothing
  // to pause, so the rail keeps animating regardless of any earlier pause intent.
  const railPaused = paused && !inMaintenancePhase;
  const importProgress = describeImportProgress(processed, total);
  // The fill sits at 100% during maintenance (the import is done); the shimmer
  // continues to signal the remaining background work.
  const pct = inMaintenancePhase ? 100 : importProgress.pct;

  return (
    <div
      aria-hidden={!visible}
      className={`shrink-0 overflow-hidden transition-all duration-500 ease-out ${
        visible ? "max-h-12 opacity-100" : "max-h-0 opacity-0"
      }`}
      data-testid="first-launch-import-banner"
    >
      <section className="relative border-[var(--border)] border-b bg-[var(--primary)]/[0.06]">
        <BannerHeaderRow
          inMaintenancePhase={inMaintenancePhase}
          onTogglePause={togglePause}
          paused={paused}
          processed={importProgress.processed}
          railPaused={railPaused}
          total={importProgress.total}
        />
        {/* Determinate fill plus a continuous off-main-thread shimmer (paused
            while the import is paused, so the rail visibly stops progressing).
            During maintenance the fill sits at 100% and the shimmer keeps
            moving, signalling background work without a determinate count. */}
        <div
          aria-label="Session import progress"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={pct}
          className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-[var(--border)]/40"
          role="progressbar"
        >
          <div
            className="h-full bg-[var(--primary)] transition-[width] duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
          {!railPaused && (
            <div
              className="absolute inset-y-0 left-0 w-1/4 bg-gradient-to-r from-transparent via-[var(--primary)]/40 to-transparent"
              data-ob-motion
              style={{ animation: "ob-shimmer 1.8s linear infinite" }}
            />
          )}
        </div>
      </section>
    </div>
  );
}

type BannerHeaderRowProps = {
  inMaintenancePhase: boolean;
  railPaused: boolean;
  paused: boolean;
  total: number;
  processed: number;
  onTogglePause: () => void;
};

/**
 * The banner's status row: a pulsing dot, the phase copy, and (during the import
 * phase only) the pause control. Split out of `FirstLaunchImportBanner` so the
 * component's lifecycle effects and this presentational branching are not scored
 * as one oversized function.
 */
function BannerHeaderRow({
  inMaintenancePhase,
  railPaused,
  paused,
  total,
  processed,
  onTogglePause,
}: BannerHeaderRowProps) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2">
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${
          railPaused ? "bg-[var(--muted-foreground)]" : "bg-[var(--primary)]"
        }`}
        data-ob-motion
        style={
          railPaused
            ? undefined
            : { animation: "ob-pulse 1.1s ease-in-out infinite" }
        }
      />
      <div
        aria-atomic="true"
        aria-live="polite"
        className="flex min-w-0 items-center gap-2.5"
        role="status"
      >
        {inMaintenancePhase ? (
          // FEA-2264: calm "wrapping up" copy for the post-boot maintenance
          // window. No counts (the import is done) and no pause control (there is
          // no import collector left to pause).
          <span className="min-w-0 truncate font-medium text-[var(--foreground)] text-sm">
            Finishing up importing your history
          </span>
        ) : (
          <BannerImportCopy
            paused={paused}
            processed={processed}
            total={total}
          />
        )}
      </div>
      <div className="ml-auto flex items-center gap-2.5">
        {(inMaintenancePhase || !paused) && (
          // Supplementary reassurance only — hidden below `lg` so the session
          // count and Pause control never get crowded off the right edge at
          // narrow desktop widths (FEA-2935).
          <span className="hidden truncate text-[var(--muted-foreground)] text-xs lg:inline">
            The app may be slow until this finishes.
          </span>
        )}
        {!inMaintenancePhase && (
          <button
            aria-label={paused ? "Resume import" : "Pause import"}
            className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--background)]/60 px-2 py-0.5 font-medium text-[var(--foreground)] text-xs transition-colors hover:bg-[var(--accent)]"
            onClick={onTogglePause}
            type="button"
          >
            {paused ? "Resume" : "Pause"}
          </button>
        )}
      </div>
    </div>
  );
}

type BannerImportCopyProps = {
  paused: boolean;
  total: number;
  processed: number;
};

/** Import-phase label plus the determinate session count (or scanning state). */
function BannerImportCopy({ paused, total, processed }: BannerImportCopyProps) {
  return (
    <>
      <span className="min-w-0 truncate font-medium text-[var(--foreground)] text-sm">
        {paused ? "Import paused" : "Importing your agent history"}
      </span>
      {total > 0 ? (
        <span
          aria-hidden="true"
          className="shrink-0 font-mono text-[var(--muted-foreground)] text-xs tabular-nums"
        >
          {processed.toLocaleString()} / {total.toLocaleString()} sessions
        </span>
      ) : (
        <span className="shrink-0 text-[var(--muted-foreground)] text-xs">
          Scanning your local logs…
        </span>
      )}
    </>
  );
}
