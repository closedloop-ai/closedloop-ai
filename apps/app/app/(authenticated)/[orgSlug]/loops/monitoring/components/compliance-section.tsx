"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import type { ComplianceItem } from "@repo/api/src/types/analytics";
import { useAgentComponentCompliance } from "@repo/app/agents/hooks/use-agent-component-compliance";
import { AGENTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";

const GRID_TEMPLATE = "minmax(180px,1fr) 80px 110px 110px 100px";

const COLUMNS: GridTableColumn[] = [
  { id: "kind", label: "Type", sortable: false },
  { id: "not-installed", label: "Not installed", sortable: false },
  { id: "installed-unused", label: "Installed, unused", sortable: false },
  { id: "total-targets", label: "Total targets", sortable: false },
];

function gapSeverityClass(
  notInstalled: number,
  unused: number,
  total: number
): string {
  if (total === 0) {
    return "";
  }
  const gapFraction = (notInstalled + unused) / total;
  if (gapFraction > 0.5) {
    return "text-destructive";
  }
  if (gapFraction > 0.2) {
    return "text-warning";
  }
  return "text-muted-foreground";
}

/**
 * Org-wide component-distribution Compliance Gaps.
 *
 * Fetches GET /agent-components/compliance via `useAgentComponentCompliance`
 * and lists required (auto_install) distributions where compute targets have
 * not installed or are not utilizing the component. Visible to all org members.
 *
 * Folded into Agent Monitoring (FEA-2923): the former /agents/insights route
 * was dropped — its Component Leaderboard duplicated Monitoring's telemetry
 * breakdowns, and this compliance view is the distinct signal worth keeping.
 */
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
      <div className="rounded-lg border border-border bg-muted/50 p-8 text-center">
        <p className="text-muted-foreground">
          No compliance gaps detected. All required distributions are installed
          and utilized across the org.
        </p>
      </div>
    );
  }

  return (
    <GridTable<ComplianceItem>
      columns={COLUMNS}
      getRowId={(item) => item.distributionId}
      gridTemplateColumns={GRID_TEMPLATE}
      items={items}
      leadingLabel="Distribution"
      renderCell={(columnId, item) => {
        switch (columnId) {
          case "kind":
            return (
              <span className="text-muted-foreground text-xs capitalize">
                {item.kind}
              </span>
            );
          case "not-installed":
            return (
              <span
                className={`text-sm tabular-nums ${
                  item.notInstalledCount > 0
                    ? gapSeverityClass(
                        item.notInstalledCount,
                        item.installedButUnusedCount,
                        item.totalTargetCount
                      )
                    : "text-muted-foreground"
                }`}
              >
                {item.notInstalledCount}
              </span>
            );
          case "installed-unused":
            return (
              <span
                className={`text-sm tabular-nums ${
                  item.installedButUnusedCount > 0
                    ? "text-warning"
                    : "text-muted-foreground"
                }`}
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
      }}
      renderLead={(item) => (
        <span className="truncate font-medium text-sm">
          {item.catalogItemName}
        </span>
      )}
    />
  );
}

/**
 * Titled Compliance Gaps section, rendered at the bottom of the Agent
 * Monitoring telemetry column via the shared component's `footerSlot`.
 */
export function ComplianceSection() {
  // The compliance view reads agent-components data, so gate it behind the
  // Agents flag — Agent Monitoring itself is gated on the Sessions flag, which
  // can be enabled independently.
  return (
    <FeatureFlagged flag={AGENTS_FEATURE_FLAG_KEY}>
      <section aria-label="Distribution compliance">
        <h2 className="mb-1 font-medium text-lg">Compliance Gaps</h2>
        <p className="mb-4 text-muted-foreground text-sm">
          Required distributions (auto-install mode) where compute targets have
          not installed or are not utilizing the component.
        </p>
        <CompliancePanel />
      </section>
    </FeatureFlagged>
  );
}
