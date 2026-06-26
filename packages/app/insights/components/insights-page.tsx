"use client";

import {
  INSIGHTS_PERIOD_OPTIONS,
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
import { CopyIcon, PlusIcon, Share2Icon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useInsightsDataSource } from "../data/insights-data-source";
import { useDashboardPins } from "../hooks/use-dashboard-pins";
import {
  useAgentsInsights,
  useDeliveryInsights,
  useUtilizationInsights,
} from "../hooks/use-insights";
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
};

const SHARE_FEEDBACK_TIMEOUT_MS = 1800;

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
  const { availableScopes, availableSections } = useInsightsDataSource();
  const pins = useDashboardPins(storageNamespace);
  const [period, setPeriod] = useState<InsightsPeriod>("90");
  const [scope, setScope] = useState<InsightsScope>(
    availableScopes.includes(InsightsScope.Me)
      ? InsightsScope.Me
      : availableScopes[0]
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

  const deliveryQuery = useDeliveryInsights(
    period,
    scope,
    isEnabled(InsightsSection.Delivery)
  );
  const utilizationQuery = useUtilizationInsights(
    period,
    scope,
    isEnabled(InsightsSection.Utilization)
  );
  const agentsQuery = useAgentsInsights(
    period,
    scope,
    isEnabled(InsightsSection.Agents)
  );
  const deliveryComparisonQuery = useDeliveryInsights(
    period,
    comparisonScope,
    shouldLoadComparison && isEnabled(InsightsSection.Delivery)
  );
  const utilizationComparisonQuery = useUtilizationInsights(
    period,
    comparisonScope,
    shouldLoadComparison && isEnabled(InsightsSection.Utilization)
  );
  const agentsComparisonQuery = useAgentsInsights(
    period,
    comparisonScope,
    shouldLoadComparison && isEnabled(InsightsSection.Agents)
  );

  const sections: InsightsSectionData = {
    [InsightsSection.Delivery]: deliveryQuery.data,
    [InsightsSection.Utilization]: utilizationQuery.data,
    [InsightsSection.Agents]: agentsQuery.data,
  };
  const comparisonSections: InsightsSectionData = {
    [InsightsSection.Delivery]: deliveryComparisonQuery.data,
    [InsightsSection.Utilization]: utilizationComparisonQuery.data,
    [InsightsSection.Agents]: agentsComparisonQuery.data,
  };

  const handleShare = useCallback(async () => {
    if (typeof globalThis.location === "undefined") {
      return;
    }
    const url = new URL(globalThis.location.href);
    url.searchParams.set("period", period);
    url.searchParams.set("scope", scope);
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
  }, [period, scope]);

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
            <Select
              onValueChange={(value) => setScope(value as InsightsScope)}
              value={scope}
            >
              <SelectTrigger className="h-8 w-36" size="sm">
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
          <Select
            onValueChange={(value) => setPeriod(value as InsightsPeriod)}
            value={period}
          >
            <SelectTrigger className="h-8 w-28" size="sm">
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
        <DashboardGrid
          availableSections={availableSections}
          comparisonLabel={SCOPE_LABELS[comparisonScope]}
          comparisonSections={shouldLoadComparison ? comparisonSections : {}}
          onAddTiles={handleOpenAddMetric}
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
        getTileSettings={pins.getTileSettings}
        isPinned={pins.isPinned}
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
