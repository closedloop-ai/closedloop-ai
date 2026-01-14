"use client";

import { useRouter } from "next/navigation";
import { DataTable, type Column, type SortOption, type FilterOption } from "@repo/design-system/components/ui/data-table";
import type { PRD } from "@repo/database/generated/client";
import { PRDStatusBadge } from "./prd-status-badge";
import { PRDRowActions } from "./prd-row-actions";

type PRDTableProps = {
  prds: PRD[];
};

const columns: Column<PRD>[] = [
  {
    key: "title",
    header: "Name / Title",
    render: (prd) => (
      <span className="font-medium">{prd.title}</span>
    ),
  },
  {
    key: "version",
    header: "Version",
    render: (prd) => <span className="font-mono text-sm">v{prd.version}</span>,
  },
  {
    key: "status",
    header: "Status",
    render: (prd) => <PRDStatusBadge status={prd.status} />,
  },
  {
    key: "approver",
    header: "Approver",
  },
  {
    key: "updatedAt",
    header: "Updated",
    render: (prd) => formatDate(prd.updatedAt),
  },
];

const sortOptions: SortOption[] = [
  { label: "Last Updated", value: "updatedAt:desc" },
  { label: "Oldest First", value: "updatedAt:asc" },
  { label: "Title A-Z", value: "title:asc" },
  { label: "Title Z-A", value: "title:desc" },
  { label: "Version (High to Low)", value: "version:desc" },
  { label: "Version (Low to High)", value: "version:asc" },
];

const filterOptions: FilterOption[] = [
  { label: "Draft", value: "Draft" },
  { label: "Review", value: "Review" },
  { label: "Approved", value: "Approved" },
  { label: "Archived", value: "Archived" },
];

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(date));
}

export function PRDTable({ prds }: PRDTableProps) {
  const router = useRouter();

  const handleRowClick = (prd: PRD) => {
    router.push(`/prds/${prd.id}`);
  };

  return (
    <DataTable
      data={prds}
      columns={columns}
      searchPlaceholder="Search .md files"
      searchKey="title"
      sortOptions={sortOptions}
      filterOptions={filterOptions}
      filterKey="status"
      onRowClick={handleRowClick}
      renderRowActions={(prd) => <PRDRowActions prd={prd} />}
      emptyMessage="No PRDs found. Create your first PRD to get started."
    />
  );
}
