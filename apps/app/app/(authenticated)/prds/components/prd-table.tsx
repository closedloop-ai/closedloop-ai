"use client";

import type { Prd } from "@repo/api/src/types/prd";
import {
  type Column,
  DataTable,
  type FilterOption,
  type SortOption,
} from "@repo/design-system/components/ui/data-table";
import { useRouter } from "next/navigation";
import { PrdStatusBadge } from "@/components/status-badge";
import { formatDate } from "@/lib/date-utils";
import { PRDRowActions } from "./prd-row-actions";

type PRDTableProps = {
  prds: Prd[];
};

const columns: Column<Prd>[] = [
  {
    key: "title",
    header: "Name / Title",
    render: (prd) => <span className="font-medium">{prd.title}</span>,
  },
  {
    key: "version",
    header: "Version",
    render: (prd) => <span className="font-mono text-sm">v{prd.version}</span>,
  },
  {
    key: "status",
    header: "Status",
    render: (prd) => <PrdStatusBadge status={prd.status} />,
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

export function PRDTable({ prds }: PRDTableProps) {
  const router = useRouter();

  const handleRowClick = (prd: Prd) => {
    router.push(`/prds/${prd.id}`);
  };

  return (
    <DataTable
      columns={columns}
      data={prds}
      emptyMessage="No PRDs found. Create your first PRD to get started."
      filterKey="status"
      filterOptions={filterOptions}
      onRowClick={handleRowClick}
      renderRowActions={(prd) => <PRDRowActions prd={prd} />}
      searchKey="title"
      searchPlaceholder="Search .md files"
      sortOptions={sortOptions}
    />
  );
}
