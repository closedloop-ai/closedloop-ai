"use client";

import { useAgentComponentCompliance } from "@repo/app/agents/hooks/use-agent-component-compliance";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { ShieldCheck } from "lucide-react";
import { AgentComplianceTable } from "./agent-compliance-table";

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
    <AgentComplianceTable
      items={items}
      total={data?.total}
      truncated={data?.truncated}
    />
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
 *
 * The grid itself lives in `agent-compliance-table.tsx`, shared with the
 * Settings v2 Compliance panel (ISS-8367); this component owns only the tab's
 * heading and its read-outcome branches.
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
