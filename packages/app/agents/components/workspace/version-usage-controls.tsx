"use client";

import type { ComponentVersion } from "@repo/api/src/types/agent-component";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Toggle } from "@repo/design-system/components/ui/toggle";
import { ColumnsIcon, HistoryIcon } from "lucide-react";
import { coerceHash } from "../../lib/version-label";
import { versionSelectLabel } from "../../lib/version-usage-view";

/**
 * ISS-10467/ISS-10468 — the Version usage panel's selection controls.
 *
 * Split out of `VersionUsagePanel` when the compare added a second selector and
 * a toggle: the panel now owns the read, the caveats and four body states, and
 * "which revisions is the reader looking at" is a separate responsibility with
 * its own props. Nothing here reads the feature flag — the panel is mounted
 * inside the one gate, so a second read site would be the threaded-flag defect
 * (`scripts/lint/rules/no-threaded-feature-flag.ts`).
 *
 * Rendered ONLY when a second revision exists, which is the one honest reason
 * the compare can be unavailable. Its caller decides that; this component does
 * not re-derive it.
 */
export function VersionUsageControls({
  baselineHash,
  compareEnabled,
  onCompareChange,
  onSelectBaseline,
  onSelectVersion,
  options,
  selectedHash,
}: {
  /** The revision the compare reads against, already resolved by the panel. */
  baselineHash: string | null;
  compareEnabled: boolean;
  onCompareChange: (enabled: boolean) => void;
  onSelectBaseline: (hash: string) => void;
  onSelectVersion: (hash: string) => void;
  options: readonly ComponentVersion[];
  selectedHash: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select onValueChange={onSelectVersion} value={selectedHash ?? undefined}>
        <SelectTrigger
          aria-label="Content version to break usage down by"
          className="h-8 w-[200px]"
          size="sm"
        >
          <span className="flex items-center gap-1.5">
            <HistoryIcon className="size-3.5 text-muted-foreground" />
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent align="end">
          {options.map((version) => (
            <SelectItem key={version.hash} value={coerceHash(version.hash)}>
              {versionSelectLabel(version, options)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* ISS-10468. A `Toggle` rather than a link or a second panel: the
      compare is the SAME drill-down showing a second column, so it
      belongs to this section's own controls. Radix publishes
      `aria-pressed` from `pressed`, and the accessible name is the
      visible word plus the icon's own absence of one. */}
      <Toggle
        aria-label="Compare the selected revision with another"
        onPressedChange={onCompareChange}
        pressed={compareEnabled}
        size="sm"
        variant="outline"
      >
        <ColumnsIcon aria-hidden="true" className="size-3.5" />
        Compare
      </Toggle>
      {compareEnabled ? (
        <Select
          onValueChange={onSelectBaseline}
          value={baselineHash ?? undefined}
        >
          <SelectTrigger
            aria-label="Revision to compare against"
            className="h-8 w-[200px]"
            size="sm"
          >
            <span className="flex items-center gap-1.5">
              <span className="text-muted-foreground text-xs">vs</span>
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent align="end">
            {options
              // The selected revision is not on offer as its own baseline:
              // a table comparing a revision with itself answers nothing
              // and would ask the producer for one version twice.
              .filter((version) => coerceHash(version.hash) !== selectedHash)
              .map((version) => (
                <SelectItem key={version.hash} value={coerceHash(version.hash)}>
                  {versionSelectLabel(version, options)}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
