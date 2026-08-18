"use client";

import type { ComplianceItem } from "@repo/api/src/types/analytics";
import { useAgentComponentCompliance } from "@repo/app/agents/hooks/use-agent-component-compliance";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  buildGridTableCardFields,
  GridTable,
  GridTableCard,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { ShieldCheck } from "lucide-react";

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
  if (fraction > 0.5) {
    return "text-destructive";
  }
  if (fraction > 0.2) {
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

function CompliancePanel() {
  const { data, isLoading, isError, error } = useAgentComponentCompliance();

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <Alert variant="error">
        <AlertTitle>Failed to load compliance data</AlertTitle>
        <AlertDescription>
          {error instanceof Error
            ? error.message
            : "An unexpected error occurred"}
        </AlertDescription>
      </Alert>
    );
  }

  const items = data?.items ?? [];

  if (items.length === 0) {
    return (
      <EmptyState
        description="Every required distribution is installed and in use across your compute targets."
        icon={ShieldCheck}
        title="No compliance gaps"
      />
    );
  }

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
      {data?.truncated ? (
        <p className="text-muted-foreground text-xs">
          Showing the first {items.length} of {data.total} distributions with
          gaps. Resolve these to see the rest.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Org-wide component-distribution Compliance Gaps, rendered as an admin-only
 * Settings tab.
 *
 * Fetches GET /agent-components/compliance via `useAgentComponentCompliance`
 * and lists required (auto_install) distributions where compute targets have
 * not installed or are not utilizing the component. The route is admin-gated
 * server-side (FEA-4029), matching the admin-only tab.
 *
 * Re-homed under Settings (FEA-4029) after PR #3626 removed the Agent
 * Monitoring screen that previously hosted this compliance view. The surface
 * is preserved because compliance is a dependency of the planned
 * transcript-retention functionality.
 */
export function AgentComplianceSettingsTab() {
  return (
    <section aria-label="Distribution compliance" className="space-y-4">
      <div>
        <h2 className="font-semibold text-lg tracking-tight">
          Compliance Gaps
        </h2>
        <p className="text-muted-foreground text-sm">
          Required distributions (auto-install mode) where compute targets have
          not installed or are not using the component. Manage distributions and
          their targets in Admin → Catalog.
        </p>
      </div>
      <CompliancePanel />
    </section>
  );
}
