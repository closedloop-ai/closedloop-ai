"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import {
  type Column,
  DataTable,
  type FilterOption,
  type SortOption,
} from "@repo/design-system/components/ui/data-table";
import { useRouter } from "next/navigation";
import { PreviewLink } from "@/components/preview-link";
import { PullRequestLink } from "@/components/pull-request-link";
import { ArtifactStatusBadge } from "@/components/status-badge";
import { TableErrorState, TableLoadingState } from "@/components/table-states";
import { useArtifactsBySubtype } from "@/hooks/queries/use-artifacts";
import { formatRelativeTime } from "@/lib/date-utils";
import { getUserDisplayName } from "@/lib/user-utils";
import { PlanRowActions } from "./plan-row-actions";

const columns: Column<ArtifactWithWorkstream>[] = [
  {
    key: "title",
    header: "Plan Name",
    render: (plan) => (
      <div className="flex items-center gap-2">
        <span className="font-medium">{plan.title}</span>
        <PullRequestLink pullRequest={plan.pullRequest} />
      </div>
    ),
  },
  {
    key: "version",
    header: "Version",
    render: (plan) => (
      <span className="font-mono text-sm">v{plan.version}</span>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (plan) => <ArtifactStatusBadge status={plan.status} />,
  },
  {
    key: "approver",
    header: "Approver",
    render: (plan) => (
      <span className="text-muted-foreground">
        {plan.approver ? getUserDisplayName(plan.approver) : "-"}
      </span>
    ),
  },
  {
    key: "previewDeployment",
    header: "Preview",
    render: (plan) => <PreviewLink url={plan.previewDeployment?.url} />,
  },
  {
    key: "owner",
    header: "Creator",
    render: (plan) => (
      <span className="text-muted-foreground">
        {plan.owner ? getUserDisplayName(plan.owner) : "-"}
      </span>
    ),
  },
  {
    key: "updatedAt",
    header: "Updated",
    render: (plan) => (
      <span className="text-muted-foreground">
        {formatRelativeTime(plan.updatedAt)}
      </span>
    ),
  },
];

const sortOptions: SortOption[] = [
  { label: "Last Updated", value: "updatedAt:desc" },
  { label: "Oldest First", value: "updatedAt:asc" },
  { label: "Name A-Z", value: "title:asc" },
  { label: "Name Z-A", value: "title:desc" },
  { label: "Version (High to Low)", value: "version:desc" },
  { label: "Version (Low to High)", value: "version:asc" },
];

const filterOptions: FilterOption[] = [
  { label: "Draft", value: "DRAFT" },
  { label: "Review", value: "REVIEW" },
  { label: "Approved", value: "APPROVED" },
  { label: "Archived", value: "ARCHIVED" },
];

export function PlanTable() {
  const router = useRouter();
  const {
    data: plans = [],
    isLoading,
    error,
  } = useArtifactsBySubtype("IMPLEMENTATION_PLAN");

  const handleRowClick = (plan: ArtifactWithWorkstream) => {
    router.push(`/implementation-plans/${plan.documentSlug}`);
  };

  if (isLoading) {
    return <TableLoadingState />;
  }

  if (error) {
    return <TableErrorState error={error} />;
  }

  return (
    <DataTable
      columns={columns}
      data={plans}
      emptyMessage="No implementation plans found. Create your first plan to get started."
      filterKey="status"
      filterOptions={filterOptions}
      onRowClick={handleRowClick}
      renderRowActions={(plan) => <PlanRowActions plan={plan} />}
      searchKey="title"
      searchPlaceholder="Search implementation plans..."
      sortOptions={sortOptions}
    />
  );
}
