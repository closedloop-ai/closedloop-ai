/**
 * ISS-10004 — the superseded Diagnostics composition, kept whole behind the
 * default-OFF gate in `diagnostics-view.tsx`.
 *
 * This is the body that shipped before `DiagnosticsSurfaceV2`, moved out of
 * `diagnostics-view.tsx` so that file can be the ONE flag read and nothing else.
 * Its behaviour is unchanged; what changed is where its section bodies live —
 * they are the same components the surface renders, now imported from
 * `@repo/app` instead of being desktop-private, so the two branches cannot drift
 * into showing different tables. PRD-730 wave 5 (ISS-9415) owns deleting it.
 */

import {
  Alert,
  AlertDescription,
} from "@closedloop-ai/design-system/components/ui/alert";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { Skeleton } from "@closedloop-ai/design-system/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@closedloop-ai/design-system/components/ui/tabs";
import { BackfillSection } from "@repo/app/diagnostics/components/backfill-section";
import { CoverageSection } from "@repo/app/diagnostics/components/coverage-section";
import { DIAGNOSTICS_SURFACE_DESCRIPTION } from "@repo/app/diagnostics/components/diagnostics-surface-v2";
import { LinksSection } from "@repo/app/diagnostics/components/links-section";
import { ReposSection } from "@repo/app/diagnostics/components/repos-section";
import { WithheldSection } from "@repo/app/diagnostics/components/withheld-section";
import {
  DEFAULT_DIAGNOSTICS_SECTION_ID,
  DiagnosticsSectionId,
} from "@repo/app/diagnostics/lib/diagnostics-sections";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACTIVITY_COVERAGE_AXIS_LABELS,
  type DiagnosticsData,
} from "../../../shared/diagnostics-contract";
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
// The tab VALUES and the default are the surface's, consumed rather than
// restated: a rename there must not leave this branch serving different anchors
// or opening on a different tab, and only a shared constant can guarantee that.
const DEFAULT_TAB: string = DEFAULT_DIAGNOSTICS_SECTION_ID;
const COVERAGE_TAB: string = DiagnosticsSectionId.Coverage;

function DiagnosticsSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-[200px] w-full" />
      <Skeleton className="h-[150px] w-full" />
    </div>
  );
}

function renderTabContent(
  loading: boolean,
  data: DiagnosticsData | null,
  tab: string,
  /** Whether a load that ASKED for the coverage read has settled (either way). */
  coverageSettled: boolean
): React.ReactNode {
  if (loading && !data) {
    return <DiagnosticsSkeleton />;
  }
  if (!data) {
    return null;
  }
  // ISS-6758: selecting this tab is what asks for the read, so the payload in
  // hand was fetched without it for one cycle. `CoverageSection` reads an absent
  // payload as "could not read", which would be a false measurement-failure
  // claim here — this is a load in progress, not a failure.
  if (tab === COVERAGE_TAB && !coverageSettled) {
    return <DiagnosticsSkeleton />;
  }
  switch (tab) {
    case DiagnosticsSectionId.Repos:
      return <ReposSection repos={data.repos} />;
    case DiagnosticsSectionId.Backfill:
      return <BackfillSection backfill={data.backfill} />;
    case DiagnosticsSectionId.Links:
      return (
        <LinksSection linkStats={data.linkStats} linkTotals={data.linkTotals} />
      );
    case DiagnosticsSectionId.Withheld:
      return (
        <WithheldSection
          scans={data.opencodeWithheldScans}
          withheld={data.opencodeWithheld}
        />
      );
    case COVERAGE_TAB:
      return (
        <CoverageSection
          axisLabels={ACTIVITY_COVERAGE_AXIS_LABELS}
          coverage={data.activityCoverage}
        />
      );
    default:
      return null;
  }
}

export function DiagnosticsLegacyBody({
  isActive = true,
}: Readonly<{ isActive?: boolean }>) {
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const loadingRef = useRef(false);
  const loadSeqRef = useRef(0);
  // Three effects and the Refresh button share `load`, so the guard is held for
  // the panel's lifetime rather than per effect run — a per-run flag would let
  // a tab switch cancel the visibility effect's in-flight read.
  const cancelled = useCancelledRef();
  /**
   * The request shape the most recent SETTLED load used. Recorded on the FAILURE
   * path too: a rejected load still answers "was the coverage read asked for",
   * and leaving it unrecorded froze both the reconcile below and the Coverage
   * tab's skeleton on a panel with auto-refresh paused.
   */
  const [lastLoad, setLastLoad] = useState<{
    seq: number;
    withCoverage: boolean;
  } | null>(null);
  // ISS-5266 (ISS-4779 closed-by-default): the Withheld tab is off by default,
  // behind a PostHog assignment rather than a settings toggle (ISS-8753). Only
  // the DISPLAY is gated — the underlying record is written and read regardless,
  // so opening the gate never has to wait for a re-import.
  const withheldEnabled = useFeatureFlagEnabled(
    DESKTOP_OPENCODE_WITHHELD_DIAGNOSTICS_FEATURE_FLAG_KEY
  );
  // ISS-6758 (ISS-4779 closed-by-default): the Coverage tab, gated the same way.
  // Only the DISPLAY is gated — the rollup is written on every import and the
  // read runs with the panel, so opening the gate never has to wait for a
  // re-import.
  const coverageEnabled = useFeatureFlagEnabled(
    DESKTOP_ACTIVITY_COVERAGE_DIAGNOSTICS_FEATURE_FLAG_KEY
  );
  // ISS-6758: the coverage read is a full scan plus a temp B-tree over a
  // per-session table and this panel POLLS, so it is requested only while its
  // own tab is the selected one. Keying it on the flag alone would charge an
  // opted-in user for it every 5s while they sit on Repos, and keying it on the
  // flag also raced the desktop adapter's asynchronous resolve. `Tabs` is
  // controlled for this — an uncontrolled one gives the request no way to know.
  const [tab, setTab] = useState(DEFAULT_TAB);
  const wantCoverage = coverageEnabled && tab === COVERAGE_TAB;

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
        setData(result);
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
      // `loadingRef` is the re-entrancy latch, not a state commit: released
      // whatever happened, so a cancelled read can never leave it stuck true
      // and wedge every later load behind the guard at the top.
      loadingRef.current = false;
    }
  }, [cancelled, wantCoverage]);

  // One load whenever the panel becomes visible, independent of auto-refresh,
  // so a paused panel still shows fresh data on (re)activation.
  useEffect(() => {
    if (!isActive) {
      return;
    }
    load().catch(() => {});
  }, [isActive, load]);

  // Switching to the Coverage tab while a load is in flight hits the guard
  // above, so that re-fire is dropped and the payload settles WITHOUT coverage —
  // which the tab reports as "could not read", a false measurement-failure
  // claim that would persist until the next poll (or forever, with auto-refresh
  // paused). Reconciling against what the settled load actually asked for is
  // what closes that window; `seq` makes this fire after every load, not only
  // when the shape flips.
  useEffect(() => {
    if (
      isActive &&
      lastLoad !== null &&
      lastLoad.withCoverage !== wantCoverage
    ) {
      load().catch(() => {});
    }
  }, [isActive, lastLoad, wantCoverage, load]);

  // Poll only while the panel is visible and auto-refresh is on. A recursive
  // setTimeout (scheduled after each load settles) replaces setInterval so a
  // slow load can never overlap the next request or fire it out of order.
  useEffect(() => {
    if (!(isActive && autoRefresh)) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = () => {
      timer = setTimeout(async () => {
        await load();
        if (!cancelled) {
          tick();
        }
      }, AUTO_REFRESH_MS);
    };

    tick();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [isActive, autoRefresh, load]);

  // "A load that ASKED for coverage has settled", not "coverage arrived". A load
  // that asked and failed is settled too — the page-level error alert above says
  // what went wrong, and holding a skeleton instead would be a false "still
  // loading" claim that only a manual Refresh could clear.
  const coverageSettled = lastLoad?.withCoverage === true;

  const handleRefresh = useCallback(() => {
    load().catch(() => {});
  }, [load]);

  return (
    <PageShell
      actions={
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setAutoRefresh((v) => !v)}
            size="sm"
            variant="outline"
          >
            {autoRefresh ? "Pause" : "Resume"}
          </Button>
          <Button
            disabled={loading}
            onClick={handleRefresh}
            size="sm"
            variant="outline"
          >
            Refresh
          </Button>
        </div>
      }
      description={DIAGNOSTICS_SURFACE_DESCRIPTION}
      title={pageTitleForNav(NavId.Diagnostics)}
    >
      {error && (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs onValueChange={setTab} value={tab}>
        <TabsList>
          <TabsTrigger value={DiagnosticsSectionId.Repos}>Repos</TabsTrigger>
          <TabsTrigger value={DiagnosticsSectionId.Backfill}>
            Backfill
          </TabsTrigger>
          <TabsTrigger value={DiagnosticsSectionId.Links}>Links</TabsTrigger>
          {withheldEnabled && (
            <TabsTrigger value={DiagnosticsSectionId.Withheld}>
              Withheld
            </TabsTrigger>
          )}
          {coverageEnabled && (
            <TabsTrigger value={COVERAGE_TAB}>Coverage</TabsTrigger>
          )}
          <TabsTrigger value={DiagnosticsSectionId.Logs}>
            Gateway Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value={DiagnosticsSectionId.Repos}>
          {renderTabContent(
            loading,
            data,
            DiagnosticsSectionId.Repos,
            coverageSettled
          )}
        </TabsContent>

        <TabsContent value={DiagnosticsSectionId.Backfill}>
          {renderTabContent(
            loading,
            data,
            DiagnosticsSectionId.Backfill,
            coverageSettled
          )}
        </TabsContent>

        <TabsContent value={DiagnosticsSectionId.Links}>
          {renderTabContent(
            loading,
            data,
            DiagnosticsSectionId.Links,
            coverageSettled
          )}
        </TabsContent>

        {withheldEnabled && (
          <TabsContent value={DiagnosticsSectionId.Withheld}>
            {renderTabContent(
              loading,
              data,
              DiagnosticsSectionId.Withheld,
              coverageSettled
            )}
          </TabsContent>
        )}

        {coverageEnabled && (
          <TabsContent value={COVERAGE_TAB}>
            {renderTabContent(loading, data, COVERAGE_TAB, coverageSettled)}
          </TabsContent>
        )}

        <TabsContent value={DiagnosticsSectionId.Logs}>
          <LogsPanel />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
