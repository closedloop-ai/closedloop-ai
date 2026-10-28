"use client";

/**
 * @file The dashboard's empty surface — the product's shape before data arrives
 * (ISS-10567).
 *
 * PROMOTED from `packages/app/shell/v2/components/web-master-preview/components/dashboard-empty-surface.tsx`,
 * which is the approved Web Master v2 design and stays the normative source for
 * this surface. Its card order, rhythm and per-widget empty copy are carried
 * across; its mock plumbing is not, and neither is its date-range toggle — the
 * operator narrowed this to a skeleton on 2026-09-17, and on the hosts that
 * mount it the range control already lives in the page header, so a second one
 * here would be a control with nothing behind it and a second owner of range.
 *
 * It replaces a 42-line blank slate. A reader with genuinely zero sessions is
 * the audience onboarding exists for, and showing them the shape they are about
 * to fill is what makes "the app is usable while your data streams in" true.
 *
 * WHERE THE PROTOTYPE'S NAMES DID NOT COME WITH IT. The prototype invented its
 * own labels, and a skeleton whose cards rename themselves the moment data
 * lands is not the shape of the thing that fills it. So every name here is read
 * from the SAME owner the populated card reads (`StatsKpiRow` /
 * `OverviewKpiCard`): the tile catalog, on every surface. The impact row
 * is `AiImpactCard` itself — mounted with no sections — which also gets that
 * card's own `—` absence glyph instead of a second spelling of "no value".
 *
 * AND WHERE A NAME IS NOT ENOUGH. Three of the five headline tiles are GitHub
 * truth, and two of those a LOCAL read can never satisfy however healthy the
 * connection (`CLOUD_ONLY_TILE_IDS`). Captioning those "No merged PRs yet"
 * reports a lookup that never ran, so this surface takes the host's availability
 * resolver and renders the same gated ask or unavailable sentence the populated
 * row does (whitlockk). See {@link EmptyMetricCard}.
 *
 * The Recent Sessions sentence comes from the blank slate rather than the
 * prototype, because ISS-6972 is a capability and not decoration: a zero read
 * from the CLOUD may not be called an empty Mac.
 *
 * Draws no `data-tour` anchor, deliberately: ISS-9992 pins that an empty
 * dashboard is anchorless so the guided tour cannot open over nothing.
 */

import { INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY } from "@repo/api/src/types/insights-loc-terminology-flag";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
// ISS-11346: the local empty state names the same scanned sources as the
// onboarding consent line, so both read the onboarding-owned list.
import { formatAnalyzedSessionSources } from "@repo/app/onboarding/lib/analyzed-session-sources";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { CategoryBarChart } from "@repo/design-system/components/ui/category-bar-chart";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { MetricCard } from "@repo/design-system/components/ui/primitives/metric-card";
import { TimeSeriesAreaChart } from "@repo/design-system/components/ui/time-series-area-chart";
import { ActivityIcon, Clock3Icon } from "lucide-react";
import { type ReactNode, useCallback } from "react";
import type { InsightsTileAvailability } from "../../lib/tile-availability";
import type { TileDescriptor } from "../../lib/tile-catalog";
import {
  getTile,
  INSIGHTS_PR_BY_REPO_CHART_TILE_ID,
  resolveTileVocabulary,
} from "../../lib/tile-catalog";
import {
  renderTileAvailabilityDetail,
  renderTileAvailabilityOverride,
} from "../insights-tile";
import { AiImpactCard } from "./ai-impact-card";
import {
  DASHBOARD_METRIC_CARD_CLASS_NAME,
  DashboardCard,
} from "./dashboard-card";

const DASHBOARD_EMPTY_LOCAL_TITLE = "No agent sessions yet";

const DASHBOARD_EMPTY_CLOUD_TITLE = "No sessions in this workspace yet";

const LOCAL_EMPTY_DESCRIPTION = `Start using ${formatAnalyzedSessionSources("disjunction")} on this Mac and your sessions will appear here automatically — computed locally, nothing uploaded.`;

const CLOUD_EMPTY_DESCRIPTION =
  "Sessions appear here once a connected device has synced them. Anything still uploading from this Mac isn't counted yet.";

/**
 * The five headline tiles, in the order the populated stats row draws them
 * (`DASHBOARD_ROWS`' `stats` entry). Only the empty caption is authored here —
 * the label is the catalog's, so the tile cannot rename itself on first data.
 */
const EMPTY_METRICS = [
  { tileId: "kpi:sessions", detail: "No sessions synced yet" },
  { tileId: "kpi:cost", detail: "No priced usage yet" },
  { tileId: "kpi:merged", detail: "No merged PRs yet" },
  { tileId: "kpi:pr-size", detail: "No merged lines yet" },
  { tileId: "kpi:kloc", detail: "No merged lines yet" },
] as const;

const MODEL_SERIES = [
  { key: "claude", label: "Claude" },
  { key: "codex", label: "Codex" },
];

const PR_SERIES = [{ key: "merged", label: "Merged PRs" }];

const NO_POINTS: never[] = [];

const NO_CATEGORIES: never[] = [];

/**
 * Card heights matched to the populated rows (`dashboard-rows.tsx`), so the
 * page does not grow under the reader when the first data lands.
 */
/**
 * The models row draws its heading inside the chart rather than on the card, so
 * there is no catalog tile to read this from; it is byte-identical to that
 * card's `expandLabel` (`dashboard-rows.tsx`), which is the name the reader
 * sees once the chart has data.
 */
const MODEL_COST_CARD_TITLE = "Model cost over time";

const MODEL_CARD_HEIGHT = "h-[340px]";

const TILE_CARD_HEIGHT = "h-[320px]";

export function DashboardEmptySurface({
  readsCloud,
  getTileAvailability,
  githubConnect,
}: Readonly<{
  /** The page read the workspace, not this device's own database (ISS-6972). */
  readsCloud: boolean;
  /** The host's availability resolver, so a gated tile is not called a zero. */
  getTileAvailability?: (tile: TileDescriptor) => InsightsTileAvailability;
  githubConnect?: GitHubConnectTarget;
}>) {
  const tileTitle = useTileTitle();
  const chartAvailability = (tileId: string): ReactNode =>
    renderTileAvailabilityOverride({
      availability: tileAvailability({ getTileAvailability, tileId }),
      githubConnect,
      withSupportingCopy: true,
    });
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 items-stretch gap-3 lg:grid-cols-3 xl:grid-cols-5">
        {EMPTY_METRICS.map((metric) => (
          <EmptyMetricCard
            detail={metric.detail}
            getTileAvailability={getTileAvailability}
            githubConnect={githubConnect}
            key={metric.tileId}
            tileId={metric.tileId}
          />
        ))}
      </div>

      <AiImpactCard
        getTileAvailability={getTileAvailability}
        githubConnect={githubConnect}
        sections={{}}
      />

      <DashboardCard
        description="Each agent run and human input in the selected range"
        title="Event Activity"
      >
        <EmptyState
          className="min-h-52 py-8"
          description="Activity will appear after your first agent session is discovered."
          icon={ActivityIcon}
          title="No activity yet"
        />
      </DashboardCard>

      <DashboardCard
        description={
          readsCloud
            ? "Every agent run synced to this workspace"
            : "Every agent run found on this device"
        }
        title="Recent Sessions"
      >
        <EmptyState
          className="min-h-52 py-8"
          description={
            readsCloud ? CLOUD_EMPTY_DESCRIPTION : LOCAL_EMPTY_DESCRIPTION
          }
          icon={Clock3Icon}
          title={
            readsCloud
              ? DASHBOARD_EMPTY_CLOUD_TITLE
              : DASHBOARD_EMPTY_LOCAL_TITLE
          }
        />
      </DashboardCard>

      <DashboardCard
        fixedHeightClassName={MODEL_CARD_HEIGHT}
        title={MODEL_COST_CARD_TITLE}
      >
        <TimeSeriesAreaChart
          emptyMessage="No model cost yet"
          points={NO_POINTS}
          series={MODEL_SERIES}
        />
      </DashboardCard>

      <DashboardCard
        description="Pull requests merged over time"
        fixedHeightClassName={TILE_CARD_HEIGHT}
        title={tileTitle("chart:prTrend")}
      >
        {chartAvailability("chart:prTrend") ?? (
          <TimeSeriesAreaChart
            emptyMessage="No merged PRs yet"
            points={NO_POINTS}
            series={PR_SERIES}
          />
        )}
      </DashboardCard>

      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <DashboardCard
          description="Total cost by model"
          fixedHeightClassName={TILE_CARD_HEIGHT}
          title={tileTitle("chart:modelBreakdown")}
        >
          {chartAvailability("chart:modelBreakdown") ?? (
            <CategoryBarChart
              data={NO_CATEGORIES}
              emptyMessage="No model cost yet"
              horizontal
            />
          )}
        </DashboardCard>
        <DashboardCard
          description="Merged pull requests by repository"
          fixedHeightClassName={TILE_CARD_HEIGHT}
          title={tileTitle(INSIGHTS_PR_BY_REPO_CHART_TILE_ID)}
        >
          {chartAvailability(INSIGHTS_PR_BY_REPO_CHART_TILE_ID) ?? (
            <CategoryBarChart
              data={NO_CATEGORIES}
              emptyMessage="No merged PRs yet"
              horizontal
            />
          )}
        </DashboardCard>
      </div>
    </div>
  );
}

function tileAvailability({
  getTileAvailability,
  tileId,
}: {
  getTileAvailability?: (tile: TileDescriptor) => InsightsTileAvailability;
  tileId: string;
}): InsightsTileAvailability | undefined {
  const tile = getTile(tileId);
  return tile ? getTileAvailability?.(tile) : undefined;
}

/**
 * One headline tile of the skeleton, folded exactly as the POPULATED row folds
 * it (`StatsKpiRow`), because the two are the same card either side of first
 * data and a skeleton that resolves these differently is not the shape of the
 * thing that fills it.
 *
 * Gated or unavailable wins (whitlockk): three of these five — `kpi:merged`,
 * `kpi:kloc`, `kpi:pr-size` — are GitHub truth, and a local read can never
 * satisfy the latter two (`CLOUD_ONLY_TILE_IDS`). Captioning those "No merged
 * PRs yet" states a completed lookup that never ran, so the ask or
 * `TILE_UNAVAILABLE_MESSAGE` takes the caption slot instead. The label is the
 * CATALOG's title either way, as it is on the populated card.
 */
function EmptyMetricCard({
  detail,
  getTileAvailability,
  githubConnect,
  tileId,
}: {
  detail: string;
  getTileAvailability?: (tile: TileDescriptor) => InsightsTileAvailability;
  githubConnect?: GitHubConnectTarget;
  tileId: string;
}) {
  const tileTitle = useTileTitle();
  const availabilityDetail = renderTileAvailabilityDetail({
    availability: tileAvailability({ getTileAvailability, tileId }),
    githubConnect,
    // Same dashboard cards as `dashboard-rows.tsx`, in the empty surface.
    withSupportingCopy: true,
  });
  if (availabilityDetail) {
    return (
      <MetricCard
        className={DASHBOARD_METRIC_CARD_CLASS_NAME}
        detail={availabilityDetail}
        label={tileTitle(tileId)}
        value={null}
      />
    );
  }
  return (
    <MetricCard
      className={DASHBOARD_METRIC_CARD_CLASS_NAME}
      detail={detail}
      label={tileTitle(tileId)}
      value={null}
    />
  );
}

/**
 * The tile's name as the reader sees it. Vocabulary-resolved, because the
 * POPULATED row resolves it the same way (`dashboard-rows.tsx`) and the raw
 * catalog read made this card rename itself the moment data landed — the one
 * thing the header above says cannot happen (tamsinb, ISS-12638).
 *
 * The id stands in when the catalog does not carry the tile: a visible id is a
 * bug report the reader can quote, where a hand-written fallback name would be
 * a second spelling drifting silently.
 */
function useTileTitle(): (tileId: string) => string {
  const locTerminologyEnabled = useFeatureFlagEnabledOptional(
    INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY
  );
  return useCallback(
    (tileId: string): string => {
      const tile = getTile(tileId);
      if (!tile) {
        return tileId;
      }
      return resolveTileVocabulary(
        tile,
        (key) =>
          key === INSIGHTS_LOC_TERMINOLOGY_FLAG_KEY && locTerminologyEnabled
      ).title;
    },
    [locTerminologyEnabled]
  );
}
