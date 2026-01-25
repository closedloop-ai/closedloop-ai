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
import { useArtifactsByType } from "@/hooks/queries/use-artifacts";
import { ArtifactStatusBadge } from "@/components/status-badge";
import { formatDate } from "@/lib/date-utils";
import { PlanRowActions } from "./plan-row-actions";
import { VersionSelector } from "./version-selector";

const columns: Column<ArtifactWithWorkstream>[] = [
  {
    key: "title",
    header: "Plan Name",
    render: (plan) => <span className="font-medium">{plan.title}</span>,
  },
  {
    key: "version",
    header: "Version",
    render: (plan) => (
      <VersionSelector
        artifactId={plan.id}
        compact={true}
        currentVersion={plan.version}
      />
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
      <span className="text-muted-foreground">{plan.approver ?? "-"}</span>
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
  const { data: result, isLoading } = useArtifactsByType("IMPLEMENTATION_PLAN");
  const plans = result?.success ? result.data : [];

  const handleRowClick = (plan: ArtifactWithWorkstream) => {
    router.push(`/implementation-plans/${plan.id}`);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!result?.success) {
    return (
      <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
        {result?.error ?? "Failed to load implementation plans"}
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
