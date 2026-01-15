"use client";

import type { ImplementationPlanWithPrd } from "@repo/api/src/types/implementation-plan";
import {
  type Column,
  DataTable,
  type FilterOption,
  type SortOption,
} from "@repo/design-system/components/ui/data-table";
import { useRouter } from "next/navigation";
import { ImplementationPlanStatusBadge } from "@/components/status-badge";
import { formatDate } from "@/lib/date-utils";
import { ImplementationPlanRowActions } from "./implementation-plan-row-actions";

type ImplementationPlanTableProps = {
  plans: ImplementationPlanWithPrd[];
};

const columns: Column<ImplementationPlanWithPrd>[] = [
  {
    key: "title",
    header: "Plan Name / Source PRD",
    render: (plan) => (
      <div className="flex flex-col">
        <span className="font-medium">{plan.title}</span>
        <span className="text-muted-foreground text-sm">
          {plan.sourcePrd.title}
        </span>
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
    key: "createdBy",
    header: "Created By",
  },
  {
    key: "createdAt",
    header: "Created",
    render: (plan) => formatDate(plan.createdAt),
  },
  {
    key: "status",
    header: "Status",
    render: (plan) => <ImplementationPlanStatusBadge status={plan.status} />,
  },
];

const sortOptions: SortOption[] = [
  { label: "Recently Created", value: "createdAt:desc" },
  { label: "Oldest First", value: "createdAt:asc" },
  { label: "Name A-Z", value: "title:asc" },
  { label: "Name Z-A", value: "title:desc" },
  { label: "Version (High to Low)", value: "version:desc" },
  { label: "Version (Low to High)", value: "version:asc" },
];

const filterOptions: FilterOption[] = [
  { label: "Draft", value: "Draft" },
  { label: "Ready", value: "Ready" },
  { label: "In Progress", value: "In Progress" },
  { label: "Generating", value: "Generating" },
  { label: "Failed", value: "Failed" },
  { label: "Archived", value: "Archived" },
];

export function ImplementationPlanTable({
  plans,
}: ImplementationPlanTableProps) {
  const router = useRouter();

  const handleRowClick = (plan: ImplementationPlanWithPrd) => {
    router.push(`/implementation-plans/${plan.id}`);
  };

  return (
    <DataTable
      columns={columns}
      data={plans}
      emptyMessage="No implementation plans found. Generate your first plan from a PRD to get started."
      filterKey="status"
      filterOptions={filterOptions}
      onRowClick={handleRowClick}
      renderRowActions={(plan) => <ImplementationPlanRowActions plan={plan} />}
      searchKey="title"
      searchPlaceholder="Search implementation plans"
      sortOptions={sortOptions}
    />
  );
}
