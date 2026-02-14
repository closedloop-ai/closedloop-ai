"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import {
  type Column,
  DataTable,
  type FilterOption,
  type SortOption,
} from "@repo/design-system/components/ui/data-table";
import { Loader2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { ArtifactStatusBadge } from "@/components/status-badge";
import { useArtifacts } from "@/hooks/queries/use-artifacts";
import { formatDate } from "@/lib/date-utils";
import { getUserDisplayName } from "@/lib/user-utils";
import { PlanRowActions } from "./plan-row-actions";

const columns: Column<ArtifactWithWorkstream>[] = [
  {
    key: "title",
    header: "Plan Name",
    render: (plan) => (
      <div className="flex items-center gap-2">
        <span className="font-medium">{plan.title}</span>
      </div>
    ),
  },
  {
    key: "latestVersion",
    header: "Version",
    render: (plan) => (
      <span className="font-mono text-sm">v{plan.latestVersion}</span>
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
    key: "updatedAt",
    header: "Updated",
    render: (plan) => (
      <span className="text-muted-foreground">
        {formatDate(plan.updatedAt)}
      </span>
    ),
  },
];

const sortOptions: SortOption[] = [
  { label: "Last Updated", value: "updatedAt:desc" },
  { label: "Oldest First", value: "updatedAt:asc" },
  { label: "Name A-Z", value: "title:asc" },
  { label: "Name Z-A", value: "title:desc" },
  { label: "Version (High to Low)", value: "latestVersion:desc" },
  { label: "Version (Low to High)", value: "latestVersion:asc" },
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
  } = useArtifacts({ type: "IMPLEMENTATION_PLAN" });

  const handleRowClick = (plan: ArtifactWithWorkstream) => {
    router.push(`/implementation-plans/${plan.slug}`);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
        {error.message ?? "Failed to load implementation plans"}
      </div>
    );
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
