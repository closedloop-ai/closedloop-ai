import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { EmptyState } from "@closedloop-ai/design-system/components/ui/empty-state";
import type {
  AgentsInsightsResponse,
  InsightsPeriod,
} from "@closedloop-ai/loops-api/insights";
import {
  InsightsScope,
  InsightsSection,
} from "@closedloop-ai/loops-api/insights";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { DashboardRowContent } from "@repo/app/insights/components/overview/dashboard-rows";
import { DASHBOARD_ROWS } from "@repo/app/insights/components/overview/dashboard-tiles";
import type { InsightsSectionData } from "@repo/app/insights/components/tile-content";
import {
  useAgentsInsights,
  useDeliveryInsights,
  useUtilizationInsights,
} from "@repo/app/insights/hooks/use-insights";
import {
  CompassIcon,
  CpuIcon,
  LayersIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { desktopSessionDetailHashHref } from "../../shared-agent-sessions/session-hrefs";
import { DashboardCard, PageShell } from "../layout/page-shell";
import { DashboardLoading } from "./dashboard-loading";
import { Tour, type TourStep, type TourSummaryChip } from "./tour/tour";
import { TourHint } from "./tour/tour-hint";

// The first-launch dashboard is a 90-day overview: every widget — KPI totals,
// trend sparklines, and the activity heatmap — uses a rolling 90-day window so
// the metrics and time-series visuals stay bounded and readable (the all-time
// corpus produces an unreadable ~200-column heatmap and noisy trends). Other
// screens (sessions/branches lists) remain all-time.
const PERIOD: InsightsPeriod = "90";
const SCOPE = InsightsScope.Me;
const RECENT_SESSIONS_LIMIT = 8;

// localStorage flags gate the one-time first-launch experience.
const ONBOARDED_KEY = "cl-desktop-dashboard-onboarded";
const TOUR_SEEN_KEY = "cl-desktop-dashboard-tour-seen";

const REVEAL_DURATION_MS = 3600;
// Poll cadence for the cheap session-count read used to detect when the local
// import has "settled" (the dashboard's loading treatment holds until then).
const BACKFILL_POLL_MS = 2500;

// Per-row reveal thresholds on the 0..100 scan tick.
const REVEAL_AT: Record<string, number> = {
  stats: 2,
  activity: 24,
  sessions: 42,
  models: 58,
  autonomy: 70,
  prs: 82,
  distribution: 92,
};

function readFlag(key: string): boolean {
  return (
    typeof localStorage !== "undefined" && localStorage.getItem(key) === "1"
  );
}

function writeFlag(key: string): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(key, "1");
  }
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (event: MediaQueryListEvent) => setReduced(event.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

/**
 * The desktop first-launch dashboard: a fixed, read-only overview built from
 * the shared Insights tile catalog and fed by the local SQLite-backed data
 * source (via DesktopInsightsProvider). On first launch it plays a one-time
 * "populate" reveal as local sessions are analyzed, then auto-starts a guided
 * tour. Subsequent launches render immediately; the tour stays replayable.
 */
export function FirstLaunchDashboard() {
  const prefersReduced = usePrefersReducedMotion();
  const [firstLaunch] = useState(() => !readFlag(ONBOARDED_KEY));
  const motion = firstLaunch && !prefersReduced;

  const [tick, setTick] = useState(motion ? 0 : 100);
  const [tourActive, setTourActive] = useState(false);
  const [tourHint, setTourHint] = useState(false);
  const completedRef = useRef(false);

  // Backfill settle detection: while the local DB is still importing sessions,
  // the totals keep growing. Poll the cheap session list and treat the data as
  // "appropriately backfilled" once the total stops growing across consecutive
  // polls. The heavy insights queries are NOT polled during import (that would
  // compete with the main-process SQLite writes) — they refetch once on settle.
  const [settled, setSettled] = useState(false);
  const [grew, setGrew] = useState(false);
  const sessionsQuery = useAgentSessions(
    { limit: RECENT_SESSIONS_LIMIT },
    { refetchInterval: settled ? false : BACKFILL_POLL_MS }
  );
  const sessionsTotal = sessionsQuery.data?.total ?? 0;

  const initialTotalRef = useRef<number | null>(null);
  const lastTotalRef = useRef<number | null>(null);
  const stableHitsRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataUpdatedAt is the intended trigger — it advances on every poll even when the total is unchanged, which is how we count consecutive no-growth polls.
  useEffect(() => {
    if (sessionsQuery.isLoading || settled) {
      return;
    }
    if (initialTotalRef.current === null) {
      initialTotalRef.current = sessionsTotal;
    } else if (sessionsTotal > initialTotalRef.current) {
      setGrew(true);
    }
    if (lastTotalRef.current === sessionsTotal) {
      stableHitsRef.current += 1;
    } else {
      stableHitsRef.current = 0;
      lastTotalRef.current = sessionsTotal;
    }
    // Two consecutive equal polls (~5s of no growth) = settled.
    if (stableHitsRef.current >= 2) {
      setSettled(true);
    }
  }, [
    sessionsTotal,
    sessionsQuery.isLoading,
    sessionsQuery.dataUpdatedAt,
    settled,
  ]);

  // With the SQLite/WAL reader pool, the insights aggregations run on reader
  // connections concurrently with the backfill writer (and off the main thread),
  // so there's no longer any reason to defer them until the import settles —
  // load them immediately and let db-change invalidation refresh them as the
  // import grows. (The old `settled || !grew` gate was a SQLite-era mitigation
  // for the single-connection engine blocking the UI during ingest.)
  const insightsEnabled = true;
  const delivery = useDeliveryInsights(PERIOD, SCOPE, insightsEnabled);
  const utilization = useUtilizationInsights(PERIOD, SCOPE, insightsEnabled);
  const agents = useAgentsInsights(PERIOD, SCOPE, insightsEnabled);

  // All three insights sections resolved — the data behind every tile and the
  // tour summary (KPIs, model breakdown) is ready. The first-launch tour waits
  // on this so it never opens over blank cards (e.g. a missing "Models in use").
  const analyticsLoaded =
    delivery.isSuccess && utilization.isSuccess && agents.isSuccess;

  const sections: InsightsSectionData = {
    [InsightsSection.Delivery]: delivery.data,
    [InsightsSection.Utilization]: utilization.data,
    [InsightsSection.Agents]: agents.data,
  };

  const recentItems = sessionsQuery.data?.items ?? [];

  // Drive the populate scan once, on first launch.
  useEffect(() => {
    if (!motion) {
      return;
    }
    const start = Date.now();
    const interval = window.setInterval(() => {
      const next = Math.min(
        100,
        ((Date.now() - start) / REVEAL_DURATION_MS) * 100
      );
      setTick(next);
      if (next >= 100) {
        window.clearInterval(interval);
      }
    }, 40);
    return () => window.clearInterval(interval);
  }, [motion]);

  // On reveal completion: persist the onboarded flag and arm the tour once —
  // but only after the import has settled AND the dashboard is actually on
  // screen (not hidden behind the keep-alive map or a backgrounded window), so
  // the tour never pops over another view or an empty/loading dashboard.
  useEffect(() => {
    // Wait for the reveal, a settled import, AND loaded analytics — the tour
    // summary reads the KPIs/model breakdown, so arming it before the agents
    // insights resolve would show blank cards ("Models in use" with no value).
    if (tick < 100 || !settled || !analyticsLoaded || completedRef.current) {
      return;
    }
    completedRef.current = true;
    if (!firstLaunch) {
      return;
    }
    writeFlag(ONBOARDED_KEY);
    const button = document.querySelector<HTMLElement>("[data-tour-btn]");
    const onScreen =
      document.visibilityState === "visible" && button?.offsetParent != null;
    if (!readFlag(TOUR_SEEN_KEY) && onScreen) {
      const timer = window.setTimeout(() => setTourActive(true), 650);
      return () => window.clearTimeout(timer);
    }
  }, [tick, settled, analyticsLoaded, firstLaunch]);

  // "Analyzing" treatment: initial load, the first-launch reveal, or an
  // in-progress import (grew but not yet settled). A steady, already-complete
  // DB settles within a poll or two and shows no lingering indicator.
  const analyzing =
    sessionsQuery.isLoading || (grew && !settled) || (motion && tick < 100);
  const isShown = (tour: string) => !motion || tick >= (REVEAL_AT[tour] ?? 0);

  // Loading vs empty vs ready. The first-launch / loading treatment persists
  // until the analytics actually load — never show the bare zero/"Unknown"
  // tiles. `loading`: queries still resolving, OR no rows yet while the local
  // import is still running. `empty`: import settled with genuinely no data.
  // Canonical load state straight from the query statuses — no hardcoded counts
  // or `.data` presence checks (brittle under keepPreviousData placeholders).
  const dataQueries = [delivery, utilization, agents, sessionsQuery];
  // Determinate progress: fraction of the dashboard's reads that have resolved.
  const loadProgress = Math.round(
    (dataQueries.filter((query) => query.isSuccess).length /
      dataQueries.length) *
      100
  );
  const hasData = sessionsTotal > 0;
  // FEA-2038: the dashboard is "ready" only once the analytics have loaded AND the
  // local import has SETTLED. Rendering the tiles/heatmap mid-backfill shows wrong,
  // partial data (an empty/garbled heatmap, half-counted KPIs) because the
  // per-session analytics rollups are still being filled in. So hold the loading
  // treatment until the import stops growing — `(grew && !settled)`. An already-
  // complete store (`!grew`) settles within a poll or two and reveals immediately.
  const loading = !analyticsLoaded || (grew && !settled);
  const empty = !(loading || hasData);

  const tourSteps = useMemo(
    () => buildTourSteps(sessionsTotal, agents.data),
    [sessionsTotal, agents.data]
  );

  const closeTour = (reason: "done" | "skip") => {
    setTourActive(false);
    writeFlag(TOUR_SEEN_KEY);
    if (reason === "skip") {
      window.setTimeout(() => setTourHint(true), 80);
    }
  };

  const replayTour = () => {
    setTourHint(false);
    setTourActive(false);
    requestAnimationFrame(() => setTourActive(true));
  };

  return (
    <PageShell
      actions={
        <>
          <ScanStatus analyzing={analyzing} sessionsTotal={sessionsTotal} />
          <span data-tour-btn>
            <Button
              onClick={replayTour}
              size="sm"
              type="button"
              variant="ghost"
            >
              <CompassIcon className="size-4" />
              Tour
            </Button>
          </span>
        </>
      }
      fullWidth
      title="Welcome to Closedloop"
    >
      {analyzing ? (
        <div className="h-0.5 w-full overflow-hidden rounded-full bg-[var(--accent)]">
          {/* Determinate: how many data reads have resolved (and, on first
              launch, the reveal tick) — so the bar tracks real load progress. */}
          <div
            className="h-full bg-[var(--primary)] transition-[width] duration-300 ease-out"
            style={{
              width: `${motion && tick < 100 ? Math.max(tick, loadProgress) : loadProgress}%`,
            }}
          />
        </div>
      ) : null}

      {loading && <DashboardLoading analyticsPct={loadProgress} />}
      {!loading && empty && <DashboardEmpty />}
      {!(loading || empty) && (
        <div className="flex flex-col gap-5">
          {DASHBOARD_ROWS.map((row) => (
            <Reveal
              delay={0}
              key={row.tour}
              motion={motion}
              show={isShown(row.tour)}
            >
              <div data-tour={row.tour}>
                <DashboardRowContent
                  autonomySeries={agents.data?.charts.autonomyTrend}
                  heatmap={utilization.data?.charts.activityHeatmap}
                  modelSeries={agents.data?.charts.modelUsageOverTime}
                  row={row}
                  sections={sections}
                />
              </div>
              {row.tour === "activity" && isShown("sessions") ? (
                <div className="mt-5">
                  <RecentSessions
                    isError={sessionsQuery.isError}
                    isLoading={sessionsQuery.isLoading}
                    items={recentItems}
                    parsing={analyzing}
                  />
                </div>
              ) : null}
            </Reveal>
          ))}
        </div>
      )}

      <Tour active={tourActive} onClose={closeTour} steps={tourSteps} />
      <TourHint onClose={() => setTourHint(false)} show={tourHint} />
    </PageShell>
  );
}

function ScanStatus({
  analyzing,
  sessionsTotal,
}: {
  analyzing: boolean;
  sessionsTotal: number;
}) {
  if (analyzing) {
    return (
      <span className="inline-flex items-center gap-2 font-mono text-[var(--muted-foreground)] text-xs">
        <span
          className="size-1.5 rounded-full bg-[var(--ai,var(--primary))]"
          style={{ animation: "ob-pulse 1.1s ease-in-out infinite" }}
        />
        Analyzing locally · {sessionsTotal.toLocaleString()} sessions
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-[var(--muted-foreground)] text-xs">
      <ShieldCheckIcon className="size-3.5 text-[var(--success-foreground)]" />
      Computed on this device · 0 bytes uploaded
    </span>
  );
}

// Settled with genuinely no local sessions.
function DashboardEmpty() {
  return (
    <EmptyState
      className="min-h-[360px] rounded-xl border border-border/70 bg-card"
      description="Start using Claude Code, Codex, or another agent on this Mac and your sessions will appear here automatically — computed locally, nothing uploaded."
      icon={LayersIcon}
      title="No agent sessions yet"
    />
  );
}

function Reveal({
  show,
  motion,
  delay,
  children,
}: {
  show: boolean;
  motion: boolean;
  delay: number;
  children: ReactNode;
}) {
  if (!show) {
    return null;
  }
  return (
    <div
      data-ob-motion={motion ? "" : undefined}
      style={{
        animation: motion
          ? `ob-rise .5s cubic-bezier(.2,.7,.3,1) ${delay}ms both`
          : "none",
      }}
    >
      {children}
    </div>
  );
}

function RecentSessions({
  items,
  isLoading,
  isError,
  parsing,
}: {
  items: Parameters<typeof SyncedSessionsTable>[0]["items"];
  isLoading: boolean;
  isError: boolean;
  parsing: boolean;
}) {
  return (
    <div data-tour="sessions">
      <DashboardCard
        description={
          parsing
            ? "Parsing local session logs…"
            : "Every agent run found on this device"
        }
        title="Recent Sessions"
      >
        {renderSessions(items, isLoading, isError)}
      </DashboardCard>
    </div>
  );
}

function renderSessions(
  items: Parameters<typeof SyncedSessionsTable>[0]["items"],
  isLoading: boolean,
  isError: boolean
): ReactNode {
  if (isLoading) {
    return (
      <div className="py-8 text-center text-[var(--muted-foreground)] text-sm">
        Reading session logs…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="py-8 text-center text-[var(--destructive)] text-sm">
        Recent sessions are temporarily unavailable.
      </div>
    );
  }
  return (
    <SyncedSessionsTable
      emptyState={
        <div className="py-8 text-center text-[var(--muted-foreground)] text-sm">
          No synced sessions found yet.
        </div>
      }
      getSessionHref={desktopSessionDetailHashHref}
      items={items}
    />
  );
}

function buildTourSteps(
  sessionsTotal: number,
  agents: AgentsInsightsResponse | undefined
): TourStep[] {
  const modelsKpi = agents?.kpis.find((kpi) => kpi.key === "models");
  const modelChips: TourSummaryChip[] = (agents?.charts.modelBreakdown ?? [])
    .slice(0, 4)
    .map((bucket) => ({ label: bucket.label, mono: true }));
  const extraModels = Math.max(
    0,
    (agents?.charts.modelBreakdown.length ?? 0) - modelChips.length
  );
  if (extraModels > 0) {
    modelChips.push({
      label: `+${extraModels} more`,
      mono: false,
      muted: true,
    });
  }

  return [
    {
      intro: true,
      eyebrow: "Ready",
      title: "Build and see how your agents perform",
      body: "Your local agent session logs have been parsed and analyzed. Keep using AI the way you already do — Closedloop runs quietly in the background and shows you how your agents are performing.",
      summary: [
        {
          icon: <LayersIcon size={15} />,
          label: "Sessions parsed",
          value: sessionsTotal.toLocaleString(),
          sub: "found on this device",
        },
        {
          icon: <CpuIcon size={15} />,
          label: "Models in use",
          value: modelsKpi ? String(modelsKpi.value) : undefined,
          chips: modelChips.length > 0 ? modelChips : undefined,
          sub: "across Claude, OpenAI, and more.",
        },
      ],
    },
    {
      sel: "stats",
      eyebrow: "Your numbers",
      title: "The headline metrics",
      body: "Sessions, token spend, PRs shipped, and value per dollar — every figure computed right here on this Mac.",
    },
    {
      sel: "activity",
      eyebrow: "Activity",
      title: "When the work happens",
      body: "Each agent run on this machine, plotted across the selected window.",
    },
    {
      sel: "sessions",
      eyebrow: "Detail",
      title: "Every session, drillable",
      body: "A live log of each run — status, repo, model, and cost. Any row opens the full session replay.",
    },
    {
      sel: "models",
      eyebrow: "Models",
      title: "Which models did the work",
      body: "Usage over time by model, with the token share by provider beside it — so you can see where the spend goes.",
    },
    {
      sel: "prs",
      eyebrow: "Throughput",
      title: "Shipping velocity",
      body: "Pull requests merged over time, with a per-repository breakdown right beside it.",
    },
  ];
}
