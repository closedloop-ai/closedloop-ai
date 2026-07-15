"use client";

import { BranchKpiState } from "@repo/api/src/types/branch";
import {
  INSIGHTS_PERIOD_OPTIONS,
  type InsightsGitHubProvenance,
  type InsightsPeriod,
  InsightsScope,
  InsightsSection,
} from "@repo/api/src/types/insights";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { CopyIcon, PlusIcon, Share2Icon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ConnectGitHubIndicator } from "../../branches/components/connect-github-indicator";
import { useFeatureFlagEnabled } from "../../shared/feature-flags/use-feature-flag-enabled";
import type { InsightsTeamOption } from "../data/insights-data-source";
import { useInsightsDataSource } from "../data/insights-data-source";
import {
  type SharedDashboard,
  useDashboardPins,
} from "../hooks/use-dashboard-pins";
import {
  useAgentsInsights,
  useDeliveryInsights,
  useUtilizationInsights,
} from "../hooks/use-insights";
import {
  decodeSharedDashboard,
  encodeSharedDashboard,
  SHARE_DASHBOARD_PARAM,
} from "../lib/share-dashboard";
import { resolveMissingSourceTileAvailability } from "../lib/tile-availability";
import type { TileDescriptor } from "../lib/tile-catalog";
import { getTile } from "../lib/tile-catalog";
import { DashboardGrid } from "./dashboard-grid";
import { MetricPicker } from "./metric-picker";
import type { InsightsSectionData } from "./tile-content";

const PERIOD_LABELS: Record<InsightsPeriod, string> = {
  "7": "7 days",
  "30": "30 days",
  "90": "90 days",
  all: "All time",
};

const SCOPE_LABELS: Record<InsightsScope, string> = {
  [InsightsScope.Me]: "Me",
  [InsightsScope.Org]: "Organization",
  [InsightsScope.Team]: "Team",
};

const SHARE_FEEDBACK_TIMEOUT_MS = 1800;
const EMPTY_TEAM_OPTIONS: readonly InsightsTeamOption[] = [];

/**
 * PostHog flag gating the customized-dashboard share link (FEA-2746). Reuses
 * the shared `emergent` prototype flag: while it is off, Share keeps its prior
 * behavior (period/scope/team only) and any inbound `?dash=` param is ignored.
 * Named locally per the per-surface flag-key convention.
 */
export const SHARE_DASHBOARD_FEATURE_FLAG_KEY = "emergent";

function getShareButtonLabel(feedback: "idle" | "copied" | "error"): string {
  if (feedback === "copied") {
    return "Copied";
  }
  if (feedback === "error") {
    return "Copy failed";
  }
  return "Share";
}

/**
 * Shared Insights page rendered identically on web and desktop. Data arrives
 * through the injected InsightsDataSource port; scope switching is exposed only
 * when the shell advertises more than one scope.
 */
export function InsightsPage({
  storageNamespace,
}: {
  storageNamespace: string;
}) {
  const source = useInsightsDataSource();
  const { availableScopes, availableSections, availableTeams } = source;
  const teamOptions = availableTeams ?? EMPTY_TEAM_OPTIONS;
  const shareDashboardEnabled = useFeatureFlagEnabled(
    SHARE_DASHBOARD_FEATURE_FLAG_KEY
  );
  // Derive the shared snapshot reactively from the URL's `?dash=` token via the
  // navigation port (works on web and desktop) rather than reading
  // `location.search` once in an effect. Keying the decode on the raw token
  // string keeps the object identity stable across unrelated re-renders, and —
  // critically — clears the snapshot back to null when the param disappears on
  // same-route navigation (e.g. the Insights nav link back to `/insights`),
  // instead of leaving a stale override active until a full reload. Malformed or
  // absent tokens decode to null, falling back to the recipient's stored (or
  // default) dashboard.
  const searchParams = useSearchParamsValue();
  const shareDashboardToken = shareDashboardEnabled
    ? searchParams.get(SHARE_DASHBOARD_PARAM)
    : null;
  const sharedDashboard = useMemo<SharedDashboard | null>(
    () => decodeSharedDashboard(shareDashboardToken),
    [shareDashboardToken]
  );
  const pins = useDashboardPins(storageNamespace, sharedDashboard);
  const [period, setPeriod] = useState<InsightsPeriod>("90");
  const [scope, setScope] = useState<InsightsScope>(
    availableScopes.includes(InsightsScope.Me)
      ? InsightsScope.Me
      : availableScopes[0]
  );
  const [selectedTeamId, setSelectedTeamId] = useState<string | undefined>(
    teamOptions[0]?.id
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editingTileId, setEditingTileId] = useState<string | null>(null);
  const [shareFeedback, setShareFeedback] = useState<
    "idle" | "copied" | "error"
  >("idle");
  const shareFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollTopRef = useRef(0);

  const needed = useMemo(() => neededSections(pins.tiles), [pins.tiles]);
  const canCompareScopes =
    availableScopes.includes(InsightsScope.Me) &&
    availableScopes.includes(InsightsScope.Org);
  const comparisonScope =
    scope === InsightsScope.Org ? InsightsScope.Me : InsightsScope.Org;
  const shouldLoadComparison =
    canCompareScopes &&
    (pickerOpen ||
      pins.tiles.some((id) => pins.settings[id]?.comparisonOverlay === true));
  const isEnabled = (section: InsightsSection) =>
    availableSections.includes(section) && (needed.has(section) || pickerOpen);
  const selectedTeamQueryId =
    scope === InsightsScope.Team ? selectedTeamId : undefined;

  const deliveryQuery = useDeliveryInsights(
    period,
    scope,
    selectedTeamQueryId,
    isEnabled(InsightsSection.Delivery)
  );
  const utilizationQuery = useUtilizationInsights(
    period,
    scope,
    selectedTeamQueryId,
    isEnabled(InsightsSection.Utilization)
  );
  const agentsQuery = useAgentsInsights(
    period,
    scope,
    selectedTeamQueryId,
    isEnabled(InsightsSection.Agents)
  );
  const deliveryComparisonQuery = useDeliveryInsights(
    period,
    comparisonScope,
    undefined,
    shouldLoadComparison && isEnabled(InsightsSection.Delivery)
  );
  const utilizationComparisonQuery = useUtilizationInsights(
    period,
    comparisonScope,
    undefined,
    shouldLoadComparison && isEnabled(InsightsSection.Utilization)
  );
  const agentsComparisonQuery = useAgentsInsights(
    period,
    comparisonScope,
    undefined,
    shouldLoadComparison && isEnabled(InsightsSection.Agents)
  );

  const sections: InsightsSectionData = useMemo(
    () => ({
      [InsightsSection.Delivery]: deliveryQuery.data,
      [InsightsSection.Utilization]: utilizationQuery.data,
      [InsightsSection.Agents]: agentsQuery.data,
    }),
    [agentsQuery.data, deliveryQuery.data, utilizationQuery.data]
  );
  const comparisonSections: InsightsSectionData = useMemo(
    () => ({
      [InsightsSection.Delivery]: deliveryComparisonQuery.data,
      [InsightsSection.Utilization]: utilizationComparisonQuery.data,
      [InsightsSection.Agents]: agentsComparisonQuery.data,
    }),
    [
      agentsComparisonQuery.data,
      deliveryComparisonQuery.data,
      utilizationComparisonQuery.data,
    ]
  );
  const sourceGetTileAvailability = source.getTileAvailability;
  const getTileAvailability = useMemo(
    () => (tile: TileDescriptor) => {
      const payloadAvailability = sections[tile.section]?.tileAvailability;
      const payloadGitHubProvenance = getSectionGitHubProvenance(
        sections[tile.section]
      );
      if (!sourceGetTileAvailability) {
        return resolveMissingSourceTileAvailability({
          tileId: tile.id,
          section: tile.section,
        });
      }
      return sourceGetTileAvailability({
        tileId: tile.id,
        section: tile.section,
        scope,
        payloadAvailability,
        payloadGitHubProvenance,
      });
    },
    [scope, sourceGetTileAvailability, sections]
  );
  const showDeliveryConnectBanner = useMemo(
    () =>
      pins.tiles.some((id) => {
        const tile = getTile(id);
        if (!(tile && tile.section === InsightsSection.Delivery)) {
          return false;
        }
        if (!availableSections.includes(tile.section)) {
          return false;
        }
        return getTileAvailability(tile).state === BranchKpiState.Gated;
      }),
    [availableSections, getTileAvailability, pins.tiles]
  );

  const handleShare = useCallback(async () => {
    if (typeof globalThis.location === "undefined") {
      return;
    }
    const url = new URL(globalThis.location.href);
    url.searchParams.set("period", period);
    url.searchParams.set("scope", scope);
    if (scope === InsightsScope.Team && selectedTeamId) {
      url.searchParams.set("teamId", selectedTeamId);
    } else {
      url.searchParams.delete("teamId");
    }
    if (shareDashboardEnabled) {
      url.searchParams.set(
        SHARE_DASHBOARD_PARAM,
        encodeSharedDashboard({
          tiles: pins.tiles,
          layout: pins.layout,
          settings: pins.settings,
        })
      );
    } else {
      url.searchParams.delete(SHARE_DASHBOARD_PARAM);
    }
    const shareUrl = url.toString();
    const flashFeedback = (state: "copied" | "error") => {
      setShareFeedback(state);
      if (shareFeedbackTimeoutRef.current) {
        clearTimeout(shareFeedbackTimeoutRef.current);
      }
      shareFeedbackTimeoutRef.current = setTimeout(
        () => setShareFeedback("idle"),
        SHARE_FEEDBACK_TIMEOUT_MS
      );
    };

    try {
      if (
        typeof navigator !== "undefined" &&
        "share" in navigator &&
        typeof navigator.share === "function"
      ) {
        await navigator.share({ title: "Closedloop Insights", url: shareUrl });
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(shareUrl);
        flashFeedback("copied");
      }
    } catch (error) {
      // User dismissed the native share sheet — not an error to surface.
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      flashFeedback("error");
    }
  }, [
    period,
    scope,
    selectedTeamId,
    shareDashboardEnabled,
    pins.tiles,
    pins.layout,
    pins.settings,
  ]);

  const handleScopeChange = useCallback(
    (value: string) => {
      const nextScope = value as InsightsScope;
      setScope(nextScope);
      if (nextScope === InsightsScope.Team && !selectedTeamId) {
        setSelectedTeamId(teamOptions[0]?.id);
      }
    },
    [selectedTeamId, teamOptions]
  );

  const handleOpenAddMetric = useCallback(() => {
    setEditingTileId(null);
    setPickerOpen(true);
  }, []);

  const handleOpenEditMetric = useCallback((tileId: string) => {
    setEditingTileId(tileId);
    setPickerOpen(true);
  }, []);

  const handlePickerOpenChange = useCallback((open: boolean) => {
    setPickerOpen(open);
    if (!open) {
      setEditingTileId(null);
    }
  }, []);

  useEffect(
    () => () => {
      if (shareFeedbackTimeoutRef.current) {
        clearTimeout(shareFeedbackTimeoutRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!availableScopes.includes(scope)) {
      setScope(
        availableScopes.includes(InsightsScope.Me)
          ? InsightsScope.Me
          : availableScopes[0]
      );
      return;
    }
    if (scope !== InsightsScope.Team) {
      return;
    }
    if (
      !(
        selectedTeamId && teamOptions.some((team) => team.id === selectedTeamId)
      )
    ) {
      setSelectedTeamId(teamOptions[0]?.id);
    }
  }, [availableScopes, scope, selectedTeamId, teamOptions]);

  useLayoutEffect(() => {
    const node = scrollContainerRef.current;
    if (node && scrollTopRef.current > 0 && node.scrollTop === 0) {
      node.scrollTop = scrollTopRef.current;
    }
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="font-medium text-sm">Insights</div>
          <div className="truncate text-muted-foreground text-xs">
            Editable operational dashboard
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {availableScopes.length > 1 ? (
            <Select onValueChange={handleScopeChange} value={scope}>
              <SelectTrigger aria-label="Scope" className="h-8 w-36" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableScopes.map((option) => (
                  <SelectItem key={option} value={option}>
                    {SCOPE_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {scope === InsightsScope.Team && teamOptions.length > 0 ? (
            <Select
              onValueChange={setSelectedTeamId}
              value={selectedTeamId ?? teamOptions[0]?.id}
            >
              <SelectTrigger aria-label="Team" className="h-8 w-40" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {teamOptions.map((team) => (
                  <SelectItem key={team.id} value={team.id}>
                    {team.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Select
            onValueChange={(value) => setPeriod(value as InsightsPeriod)}
            value={period}
          >
            <SelectTrigger
              aria-label="Time period"
              className="h-8 w-28"
              size="sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INSIGHTS_PERIOD_OPTIONS.map((option) => (
                <SelectItem key={option} value={option}>
                  {PERIOD_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={handleOpenAddMetric} size="sm" variant="outline">
            <PlusIcon className="size-4" />
            Metric
          </Button>
          <Button onClick={handleShare} size="sm" variant="outline">
            {shareFeedback === "copied" ? (
              <CopyIcon className="size-4" />
            ) : (
              <Share2Icon className="size-4" />
            )}
            {getShareButtonLabel(shareFeedback)}
          </Button>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-auto p-4"
        onScroll={(event) => {
          scrollTopRef.current = event.currentTarget.scrollTop;
        }}
        ref={scrollContainerRef}
      >
        {showDeliveryConnectBanner ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-md border bg-card px-4 py-3">
            <div className="min-w-0">
              <div className="font-medium text-sm">
                Delivery GitHub metrics need a connection
              </div>
              <div className="text-muted-foreground text-xs">
                Connect GitHub to populate delivery metrics from cloud data.
              </div>
            </div>
            <ConnectGitHubIndicator
              compact
              connectHref={source.githubConnectHref}
              onConnect={source.onConnectGitHub}
            />
          </div>
        ) : null}
        <DashboardGrid
          availableSections={availableSections}
          comparisonLabel={SCOPE_LABELS[comparisonScope]}
          comparisonSections={shouldLoadComparison ? comparisonSections : {}}
          getTileAvailability={getTileAvailability}
          githubConnectHref={source.githubConnectHref}
          onAddTiles={handleOpenAddMetric}
          onConnectGitHub={source.onConnectGitHub}
          onEditTile={handleOpenEditMetric}
          pins={pins}
          sections={sections}
        />
      </div>

      <MetricPicker
        availableSections={availableSections}
        comparisonAvailable={canCompareScopes}
        comparisonLabel={SCOPE_LABELS[comparisonScope]}
        comparisonSections={shouldLoadComparison ? comparisonSections : {}}
        editingTileId={editingTileId}
        getTileAvailability={getTileAvailability}
        getTileSettings={pins.getTileSettings}
        githubConnectHref={source.githubConnectHref}
        isPinned={pins.isPinned}
        onConnectGitHub={source.onConnectGitHub}
        onOpenChange={handlePickerOpenChange}
        onPinTile={pins.pinTile}
        onReplaceTile={pins.replaceTile}
        onUnpinTile={pins.unpinTile}
        open={pickerOpen}
        sections={sections}
      />
    </div>
  );
}

function neededSections(pinnedTileIds: string[]): Set<InsightsSection> {
  const sections = new Set<InsightsSection>();
  for (const id of pinnedTileIds) {
    const tile = getTile(id);
    if (tile) {
      sections.add(tile.section);
    }
  }
  return sections;
}

function getSectionGitHubProvenance(
  section: InsightsSectionData[InsightsSection] | undefined
): InsightsGitHubProvenance | undefined {
  if (!(section && "githubProvenance" in section)) {
    return undefined;
  }
  return section.githubProvenance;
}
