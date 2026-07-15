"use client";

import {
  INSIGHTS_SECTION_OPTIONS,
  type InsightsSection,
} from "@repo/api/src/types/insights";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Switch } from "@repo/design-system/components/ui/switch";
import { useEffect, useMemo, useState } from "react";
import type { DashboardTileSettings } from "../hooks/use-dashboard-pins";
import { SECTION_META } from "../lib/section-meta";
import type { InsightsTileAvailability } from "../lib/tile-availability";
import {
  getSectionTiles,
  getTile,
  type TileDescriptor,
  TileKind,
  type TileKind as TileKindType,
} from "../lib/tile-catalog";
import { InsightsTile } from "./insights-tile";
import type { InsightsSectionData } from "./tile-content";

const FORMAT_LABELS: Record<TileKindType, string> = {
  [TileKind.Kpi]: "Card",
  [TileKind.TimeSeries]: "Line",
  [TileKind.TimeSeriesBar]: "Bar",
  [TileKind.CategoryBar]: "Bar",
  [TileKind.Donut]: "Pie",
  [TileKind.Heatmap]: "Heatmap",
  [TileKind.ReviewerTable]: "Table",
};

type MetricOption = {
  key: string;
  label: string;
  section: InsightsSection;
};

const NO_GROUP_BY = "__none__";

export function MetricPicker({
  open,
  onOpenChange,
  isPinned,
  onPinTile,
  onReplaceTile,
  onUnpinTile,
  editingTileId,
  getTileSettings,
  availableSections,
  sections,
  comparisonAvailable,
  comparisonSections,
  comparisonLabel,
  getTileAvailability,
  githubConnectHref,
  onConnectGitHub,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPinned: (id: string) => boolean;
  onPinTile: (id: string, settings?: DashboardTileSettings) => void;
  onReplaceTile: (
    fromId: string,
    toId: string,
    settings?: DashboardTileSettings
  ) => void;
  onUnpinTile: (id: string) => void;
  editingTileId?: string | null;
  getTileSettings: (id: string) => DashboardTileSettings;
  availableSections: readonly InsightsSection[];
  sections: InsightsSectionData;
  comparisonAvailable: boolean;
  comparisonSections?: InsightsSectionData;
  comparisonLabel?: string;
  getTileAvailability?: (tile: TileDescriptor) => InsightsTileAvailability;
  githubConnectHref?: string;
  onConnectGitHub?: () => void | Promise<void>;
}) {
  const tiles = useMemo(
    () =>
      INSIGHTS_SECTION_OPTIONS.filter((section) =>
        availableSections.includes(section)
      ).flatMap((section) => getSectionTiles(section)),
    [availableSections]
  );
  const editingTile = editingTileId ? getTile(editingTileId) : undefined;
  const metricOptions = useMemo(() => buildMetricOptions(tiles), [tiles]);

  const [selectedMetricKey, setSelectedMetricKey] = useState(
    () => metricOptions[0]?.key ?? ""
  );
  const metricTiles = useMemo(
    () => tiles.filter((tile) => tile.metricKey === selectedMetricKey),
    [selectedMetricKey, tiles]
  );
  const groupOptions = useMemo(() => uniqueGroups(metricTiles), [metricTiles]);
  const [selectedGroupBy, setSelectedGroupBy] = useState(
    () => groupOptions[0]?.key ?? NO_GROUP_BY
  );
  const availableFormats = useMemo(
    () =>
      uniqueBy(
        metricTiles
          .filter(
            (tile) => (tile.groupBy?.key ?? NO_GROUP_BY) === selectedGroupBy
          )
          .map((tile) => tile.kind)
      ),
    [metricTiles, selectedGroupBy]
  );
  const [selectedFormat, setSelectedFormat] = useState<TileKindType>(
    () => availableFormats[0] ?? TileKind.Kpi
  );
  const [selectedComparisonOverlay, setSelectedComparisonOverlay] =
    useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    const initialTile =
      editingTile && tiles.some((tile) => tile.id === editingTile.id)
        ? editingTile
        : tiles[0];
    if (!initialTile) {
      return;
    }
    setSelectedMetricKey(initialTile.metricKey);
    setSelectedGroupBy(initialTile.groupBy?.key ?? NO_GROUP_BY);
    setSelectedFormat(initialTile.kind);
    setSelectedComparisonOverlay(
      getTileSettings(initialTile.id).comparisonOverlay === true
    );
  }, [editingTile, getTileSettings, open, tiles]);

  useEffect(() => {
    if (
      !(
        selectedMetricKey &&
        metricOptions.some((option) => option.key === selectedMetricKey)
      )
    ) {
      setSelectedMetricKey(metricOptions[0]?.key ?? "");
    }
  }, [metricOptions, selectedMetricKey]);

  useEffect(() => {
    if (!groupOptions.some((option) => option.key === selectedGroupBy)) {
      setSelectedGroupBy(groupOptions[0]?.key ?? NO_GROUP_BY);
    }
  }, [groupOptions, selectedGroupBy]);

  useEffect(() => {
    if (!availableFormats.includes(selectedFormat)) {
      setSelectedFormat(availableFormats[0] ?? TileKind.Kpi);
    }
  }, [availableFormats, selectedFormat]);

  const selectedTile = metricTiles.find(
    (tile) =>
      tile.kind === selectedFormat &&
      (tile.groupBy?.key ?? NO_GROUP_BY) === selectedGroupBy
  );
  const selectedTileId = selectedTile?.id;
  const canUseComparisonOverlay =
    comparisonAvailable && selectedTile?.kind === TileKind.TimeSeries;

  useEffect(() => {
    setSelectedComparisonOverlay(
      selectedTileId
        ? getTileSettings(selectedTileId).comparisonOverlay === true
        : false
    );
  }, [getTileSettings, selectedTileId]);

  useEffect(() => {
    if (!canUseComparisonOverlay && selectedComparisonOverlay) {
      setSelectedComparisonOverlay(false);
    }
  }, [canUseComparisonOverlay, selectedComparisonOverlay]);

  const handleSave = () => {
    if (!selectedTile) {
      return;
    }
    const settings = {
      ...(canUseComparisonOverlay
        ? { comparisonOverlay: selectedComparisonOverlay }
        : {}),
    };
    if (editingTile) {
      onReplaceTile(editingTile.id, selectedTile.id, settings);
    } else {
      onPinTile(selectedTile.id, settings);
    }
    onOpenChange(false);
  };

  const handleRemove = () => {
    const tileId = editingTile?.id ?? selectedTile?.id;
    if (!tileId) {
      return;
    }
    onUnpinTile(tileId);
    onOpenChange(false);
  };

  const selectedMetric = metricOptions.find(
    (option) => option.key === selectedMetricKey
  );
  const showGroupBy =
    groupOptions.length > 1 || groupOptions[0]?.key !== NO_GROUP_BY;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[84vh] overflow-auto sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>
            {editingTile ? "Edit widget" : "Add metric"}
          </DialogTitle>
          <DialogDescription>
            Select a metric, group-by dimension, and visualization.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="insights-metric">Metric</Label>
            <Select
              onValueChange={setSelectedMetricKey}
              value={selectedMetricKey}
            >
              <SelectTrigger id="insights-metric">
                <SelectValue placeholder="Select metric" />
              </SelectTrigger>
              <SelectContent>
                {metricOptions.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {SECTION_META[option.section].title} - {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {showGroupBy ? (
            <div className="grid gap-2">
              <Label htmlFor="insights-group-by">Group by</Label>
              <Select
                onValueChange={setSelectedGroupBy}
                value={selectedGroupBy}
              >
                <SelectTrigger id="insights-group-by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {groupOptions.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="insights-format">Visualization</Label>
            <Select
              onValueChange={(value) =>
                setSelectedFormat(value as TileKindType)
              }
              value={selectedFormat}
            >
              <SelectTrigger id="insights-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableFormats.map((format) => (
                  <SelectItem key={format} value={format}>
                    {FORMAT_LABELS[format]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {canUseComparisonOverlay ? (
            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <Label className="text-sm" htmlFor="insights-comparison-overlay">
                Overlay {comparisonLabel} trendline
              </Label>
              <Switch
                checked={selectedComparisonOverlay}
                id="insights-comparison-overlay"
                onCheckedChange={setSelectedComparisonOverlay}
              />
            </div>
          ) : null}
          <div className="rounded-md border bg-muted/20 p-3 text-muted-foreground text-xs">
            {selectedTile && selectedMetric ? (
              <>
                <span className="font-medium text-foreground">
                  {SECTION_META[selectedMetric.section].title}
                </span>{" "}
                {selectedMetric.label}, rendered as{" "}
                {FORMAT_LABELS[selectedTile.kind].toLowerCase()}
                {selectedTile.groupBy
                  ? ` grouped by ${selectedTile.groupBy.label.toLowerCase()}`
                  : ""}
                .
              </>
            ) : (
              "No metrics are available for this surface."
            )}
          </div>
          {selectedTile ? (
            <div className="grid gap-2">
              <Label>Preview</Label>
              <div
                className={selectedTile.kind === TileKind.Kpi ? "h-36" : "h-64"}
              >
                <div className="group h-full">
                  <InsightsTile
                    availability={getTileAvailability?.(selectedTile)}
                    comparisonLabel={
                      selectedComparisonOverlay ? comparisonLabel : undefined
                    }
                    comparisonSections={
                      selectedComparisonOverlay ? comparisonSections : undefined
                    }
                    githubConnectHref={githubConnectHref}
                    onConnectGitHub={onConnectGitHub}
                    pinned={isPinned(selectedTile.id)}
                    sections={sections}
                    tile={selectedTile}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          {editingTile || (selectedTile && isPinned(selectedTile.id)) ? (
            <Button
              onClick={handleRemove}
              size="sm"
              type="button"
              variant="outline"
            >
              Remove
            </Button>
          ) : null}
          <Button
            disabled={!selectedTile}
            onClick={handleSave}
            size="sm"
            type="button"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function buildMetricOptions(tiles: TileDescriptor[]): MetricOption[] {
  const options = new Map<string, MetricOption>();
  for (const tile of tiles) {
    if (!options.has(tile.metricKey)) {
      options.set(tile.metricKey, {
        key: tile.metricKey,
        label: tile.metricLabel,
        section: tile.section,
      });
    }
  }
  return [...options.values()];
}

function uniqueBy<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueGroups(tiles: TileDescriptor[]): Array<{
  key: string;
  label: string;
}> {
  const groups = new Map<string, { key: string; label: string }>();
  for (const tile of tiles) {
    const key = tile.groupBy?.key ?? NO_GROUP_BY;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: tile.groupBy?.label ?? "None",
      });
    }
  }
  return [...groups.values()];
}
