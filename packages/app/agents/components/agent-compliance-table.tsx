"use client";

import type { ComplianceItem } from "@repo/api/src/types/analytics";
import {
  buildGridTableCardFields,
  GridTable,
  GridTableCard,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";

/**
 * @file agent-compliance-table.tsx
 * @description How component-distribution compliance RENDERS, extracted from
 * `agent-compliance-settings-tab.tsx` so the legacy Settings tab and the
 * Settings v2 Compliance panel (ISS-8367) present one identical grid.
 *
 * Presentation only — it takes the items it is given. Deciding whether the read
 * loaded, was refused, or failed is the caller's, and the two callers answer
 * that question differently: the legacy tab renders a raw `error.message`,
 * while the v2 panel routes the same outcomes through the panel data-state
 * contract that keeps a 403 apart from a 500.
 */

const GRID_TEMPLATE = "minmax(180px,1fr) 80px 110px 110px 100px";

const COLUMNS: GridTableColumn[] = [
  { id: "kind", label: "Type", sortable: false },
  { id: "not-installed", label: "Not installed", sortable: false },
  { id: "installed-unused", label: "Installed, unused", sortable: false },
  { id: "total-targets", label: "Total targets", sortable: false },
];

// The lead cell (distribution name) is promoted into the card header, so it is
// excluded from the card's key/value body.
const CARD_HEADER_COLUMN_IDS = new Set<string>([]);

// Distribution kind → display label. Raw kinds are lowercase wire values
// (`mcp`, `plugin`, …); CSS `capitalize` mangles the acronym to "Mcp", so the
// casing is owned here (mirrors FIELD_TYPE_LABELS in custom-fields). Unknown
// kinds fall back to the raw value rather than rendering blank.
const COMPONENT_KIND_LABELS: Record<string, string> = {
  plugin: "Plugin",
  skill: "Skill",
  command: "Command",
  agent: "Agent",
  hook: "Hook",
  mcp: "MCP",
};

const HIGH_SEVERITY_FRACTION = 0.5;
const MEDIUM_SEVERITY_FRACTION = 0.2;

function kindLabel(kind: string): string {
  return COMPONENT_KIND_LABELS[kind] ?? kind;
}

/**
 * Per-column severity. Each gap column is colored by ITS OWN share of the
 * distribution's targets, not the combined gap fraction — so the "Not
 * installed" number reflects the not-installed problem and "Installed, unused"
 * reflects the unused problem, and neither column borrows the other's alarm.
 */
function columnSeverityClass(count: number, total: number): string {
  if (count === 0 || total === 0) {
    return "text-muted-foreground";
  }
  const fraction = count / total;
  if (fraction > HIGH_SEVERITY_FRACTION) {
    return "text-destructive";
  }
  if (fraction > MEDIUM_SEVERITY_FRACTION) {
    // `--warning` is a pale fill token that fails WCAG AA on small body text in
    // light mode; `--warning-foreground` is the readable text pair.
    return "text-warning-foreground";
  }
  return "text-muted-foreground";
}

function renderComplianceCell(columnId: string, item: ComplianceItem) {
  switch (columnId) {
    case "kind":
      return (
        <span className="text-muted-foreground text-xs">
          {kindLabel(item.kind)}
        </span>
      );
    case "not-installed":
      return (
        <span
          className={`text-sm tabular-nums ${columnSeverityClass(
            item.notInstalledCount,
            item.totalTargetCount
          )}`}
        >
          {item.notInstalledCount}
        </span>
      );
    case "installed-unused":
      return (
        <span
          className={`text-sm tabular-nums ${columnSeverityClass(
            item.installedButUnusedCount,
            item.totalTargetCount
          )}`}
        >
          {item.installedButUnusedCount}
        </span>
      );
    case "total-targets":
      return (
        <span className="text-muted-foreground text-sm tabular-nums">
          {item.totalTargetCount}
        </span>
      );
    default:
      return null;
  }
}

function ComplianceName({ item }: Readonly<{ item: ComplianceItem }>) {
  // Long distribution names truncate in both the grid row and the card header;
  // a tooltip keeps the full name reachable so an admin can identify which
  // distribution the gap belongs to.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="truncate font-medium text-sm">
          {item.catalogItemName}
        </span>
      </TooltipTrigger>
      <TooltipContent>{item.catalogItemName}</TooltipContent>
    </Tooltip>
  );
}

function ComplianceCard(
  item: ComplianceItem,
  columns: readonly GridTableColumn[]
) {
  const fields = buildGridTableCardFields(
    columns,
    CARD_HEADER_COLUMN_IDS,
    renderComplianceCell,
    item
  );
  return (
    <GridTableCard fields={fields} header={<ComplianceName item={item} />} />
  );
}

export type AgentComplianceTableProps = {
  items: ComplianceItem[];
  /** Whether the server capped the list. Omit when the caller cannot know. */
  truncated?: boolean;
  /** Total distributions with gaps, only meaningful alongside `truncated`. */
  total?: number;
};

export function AgentComplianceTable({
  items,
  truncated,
  total,
}: Readonly<AgentComplianceTableProps>) {
  return (
    <div className="space-y-3">
      <GridTable<ComplianceItem>
        cardRender={ComplianceCard}
        columns={COLUMNS}
        getRowId={(item) => item.distributionId}
        gridTemplateColumns={GRID_TEMPLATE}
        items={items}
        leadingLabel="Distribution"
        renderCell={renderComplianceCell}
        renderLead={(item) => <ComplianceName item={item} />}
      />
      {truncated ? (
        <p className="text-muted-foreground text-xs">
          Showing the first {items.length} of {total} distributions with gaps.
          Resolve these to see the rest.
        </p>
      ) : null}
    </div>
  );
}
