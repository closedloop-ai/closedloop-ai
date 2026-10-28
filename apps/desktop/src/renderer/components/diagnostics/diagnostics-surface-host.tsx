import {
  DIAGNOSTICS_SURFACE_DESCRIPTION,
  DiagnosticsSurfaceV2,
} from "@repo/app/diagnostics/components/diagnostics-surface-v2";
import type { DiagnosticsPayload } from "@repo/app/diagnostics/lib/diagnostics-payload";
import {
  DEFAULT_DIAGNOSTICS_SECTION_ID,
  DiagnosticsSectionId,
} from "@repo/app/diagnostics/lib/diagnostics-sections";
import {
  type DiagnosticsSource,
  DiagnosticsTransportStatus,
} from "@repo/app/diagnostics/lib/diagnostics-source";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useCallback, useEffect, useRef, useState } from "react";
import { ACTIVITY_COVERAGE_AXIS_LABELS } from "../../../shared/diagnostics-contract";
import {
  DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY,
  DESKTOP_OPENCODE_WITHHELD_DIAGNOSTICS_FEATURE_FLAG_KEY,
} from "../../../shared/feature-flags-labs-detail";
import { cleanIpcError } from "../../clean-ipc-error";
import { useCancelledRef } from "../../hooks/use-cancelled-ref";
import { pageTitleForNav } from "../../navigation/nav-config";
import { NavId } from "../../navigation/route-table";
import { PageShell } from "../layout/page-shell";
import { LogsPanel } from "./LogsPanel";

const AUTO_REFRESH_MS = 5000;

/**
 * ISS-10004 — the DESKTOP adapter for `DiagnosticsSurfaceV2`: the probe over IPC,
 * its polling loop, the two PostHog gates naming which local-collector sections
 * this device offers, and the log reader. The surface gets the RESULT, never the
 * bridge.
 *
 * It duplicates no system check — `SystemCheckBootstrap` remains the only thing
 * that probes the device, and this reads the store the collector already wrote,
 * exactly as the superseded body did. FEA-976 owns unifying the two.
 */
export function DiagnosticsSurfaceHost({
  isActive = true,
}: Readonly<{ isActive?: boolean }>) {
  const [payload, setPayload] = useState<DiagnosticsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [sectionId, setSectionId] = useState<DiagnosticsSectionId>(
    DEFAULT_DIAGNOSTICS_SECTION_ID
  );
  const loadingRef = useRef(false);
  const loadSeqRef = useRef(0);
  // Held for the host's lifetime rather than per effect run: three effects and
  // the surface's Refresh share `load`, and a per-run flag would let a section
  // change cancel the visibility effect's in-flight read.
  const cancelled = useCancelledRef();
  /**
   * The request shape the most recent SETTLED load used. Recorded on the FAILURE
   * path too — a rejected load still answers "was the coverage read asked for",
   * and leaving it unrecorded froze both the reconcile below and the Coverage
   * skeleton on a panel with auto-refresh paused.
   */
  const [lastLoad, setLastLoad] = useState<{
    seq: number;
    withCoverage: boolean;
  } | null>(null);

  // ISS-5266 / ISS-6758: two DESKTOP-only section gates, unchanged by this
  // ticket. NOT Labs settings, whatever their canonical module is named
  // (marisolashgrove review): since ISS-8753 the renderer's `useFeatureFlagEnabled`
  // resolves the account's PostHog assignment and consults no settings store, so
  // calling them settings sends the next reader down a path that never reads
  // them. Read here, in the module that decides what this device can serve, and
  // passed on as the list of sections it may offer — never as a boolean the
  // surface would re-derive.
  const withheldEnabled = useFeatureFlagEnabled(
    DESKTOP_OPENCODE_WITHHELD_DIAGNOSTICS_FEATURE_FLAG_KEY
  );
  const coverageEnabled = useFeatureFlagEnabled(
    DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY
  );
  const availableSections: DiagnosticsSectionId[] = [];
  if (withheldEnabled) {
    availableSections.push(DiagnosticsSectionId.Withheld);
  }
  if (coverageEnabled) {
    availableSections.push(DiagnosticsSectionId.Coverage);
  }

  // ISS-6758: the coverage read is a full scan plus a temp B-tree over a
  // per-session table and this host POLLS, so it is requested only while the
  // reader is actually on that section. Keying it on the gate alone
  // would charge an opted-in user for it every 5s while they sit on Repos.
  const wantCoverage =
    coverageEnabled && sectionId === DiagnosticsSectionId.Coverage;

  const load = useCallback(async () => {
    if (loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    // A fresh `seq` on every settle, so the reconcile effect below re-evaluates
    // after each load rather than only when the request shape flips value.
    const settleLoad = () => {
      loadSeqRef.current += 1;
      setLastLoad({ seq: loadSeqRef.current, withCoverage: wantCoverage });
    };
    try {
      const result = await window.desktopApi.db.getDiagnostics({
        includeActivityCoverage: wantCoverage,
      });
      if (!cancelled.current) {
        setPayload(result);
        settleLoad();
      }
    } catch (loadError) {
      if (!cancelled.current) {
        setError(cleanIpcError(loadError, "Failed to load diagnostics"));
        settleLoad();
      }
    } finally {
      if (!cancelled.current) {
        setLoading(false);
      }
      // The re-entrancy latch, not a state commit: released whatever happened,
      // so a cancelled read can never wedge every later load behind the guard.
      loadingRef.current = false;
    }
  }, [cancelled, wantCoverage]);

  // One load whenever the page becomes visible, independent of auto-refresh, so
  // a paused page still shows fresh data on (re)activation.
  useEffect(() => {
    if (!isActive) {
      return;
    }
    load().catch(() => {});
  }, [isActive, load]);

  // Selecting Coverage while a load is in flight hits the guard above, so that
  // re-fire is dropped and the payload settles WITHOUT coverage — which the
  // section reports as "could not read", a false measurement-failure claim that
  // would persist until the next poll (or forever, with auto-refresh paused).
  // Reconciling against what the settled load actually asked for closes that
  // window; `seq` makes this fire after every load, not only on a shape flip.
  useEffect(() => {
    if (
      isActive &&
      lastLoad !== null &&
      lastLoad.withCoverage !== wantCoverage
    ) {
      load().catch(() => {});
    }
  }, [isActive, lastLoad, wantCoverage, load]);

  // Poll only while visible and auto-refresh is on. A recursive setTimeout
  // (scheduled after each load settles) rather than setInterval, so a slow load
  // can never overlap the next request or fire it out of order.
  useEffect(() => {
    if (!(isActive && autoRefresh)) {
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      timer = setTimeout(async () => {
        await load();
        if (!stopped) {
          tick();
        }
      }, AUTO_REFRESH_MS);
    };

    tick();

    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [isActive, autoRefresh, load]);

  const handleToggleAutoRefresh = useCallback(() => {
    setAutoRefresh((current) => !current);
  }, []);
  const handleRefresh = useCallback(() => {
    load().catch(() => {});
  }, [load]);

  /**
   * What the last SETTLED probe asked for — "a load that ASKED has settled",
   * not "the data arrived", because a load that asked and FAILED is settled too
   * and the failure notice already says what went wrong.
   *
   * Coverage is the only entry because it is the only OPTIONAL read: Withheld
   * rides on every call to `getDiagnosticsData`, so it was never gated and this
   * list no longer names it (marisolashgrove review). Seeding it here was a
   * restatement of `DIAGNOSTICS_OPTIONAL_READ_SECTION_IDS` that happened to
   * cancel out that list's mistake.
   */
  const settledSections: DiagnosticsSectionId[] = [];
  if (lastLoad?.withCoverage === true) {
    settledSections.push(DiagnosticsSectionId.Coverage);
  }

  const source: DiagnosticsSource = {
    autoRefresh: { enabled: autoRefresh, toggle: handleToggleAutoRefresh },
    availableSections,
    errorMessage: error,
    onSectionChange: setSectionId,
    payload,
    refresh: { busy: loading, run: handleRefresh },
    settledSections,
    status: diagnosticsStatus({ error, loading, payload }),
    // Desktop HAS the probe: this is the local read itself, so a failure here is
    // always transient and `errorMessage` is the right channel for it.
    unservableReason: null,
  };

  // `PageShell` with no title, description or actions contributes its page
  // container and nothing else — it renders no header section without them. The
  // heading, the description and the action row are the surface's now, so this
  // is the layout box the route has always had, around a body that owns itself.
  return (
    <PageShell>
      <DiagnosticsSurfaceV2
        coverageAxisLabels={ACTIVITY_COVERAGE_AXIS_LABELS}
        description={DIAGNOSTICS_SURFACE_DESCRIPTION}
        logs={<LogsPanel />}
        source={source}
        title={pageTitleForNav(NavId.Diagnostics)}
      />
    </PageShell>
  );
}

/**
 * `Unavailable` wins over `Loading` whenever a message is standing, because the
 * poll re-enters `loading` every five seconds and a status that flickered back
 * to `Loading` would blink the failure notice the reader is trying to read.
 */
function diagnosticsStatus({
  error,
  loading,
  payload,
}: {
  error: string | null;
  loading: boolean;
  payload: DiagnosticsPayload | null;
}): DiagnosticsTransportStatus {
  if (error !== null) {
    return DiagnosticsTransportStatus.Unavailable;
  }
  if (loading && payload === null) {
    return DiagnosticsTransportStatus.Loading;
  }
  return DiagnosticsTransportStatus.Ready;
}
