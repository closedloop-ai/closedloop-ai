"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import {
  type Column,
  DataTable,
  type FilterOption,
  type SortOption,
} from "@repo/design-system/components/ui/data-table";
import { useRouter } from "next/navigation";
import { ArtifactStatusBadge } from "@/components/status-badge";
import { formatDate } from "@/lib/date-utils";
import { PlanRowActions } from "./plan-row-actions";
import { VersionSelector } from "./version-selector";

type PlanTableProps = {
  plans: ArtifactWithWorkstream[];
};

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

export function PlanTable({ plans }: PlanTableProps) {
  const router = useRouter();

  const handleRowClick = (plan: ArtifactWithWorkstream) => {
    router.push(`/implementation-plans/${plan.id}`);
  };

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
