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
import { PRDRowActions } from "./prd-row-actions";

type PRDTableProps = {
  prds: ArtifactWithWorkstream[];
};

const columns: Column<ArtifactWithWorkstream>[] = [
  {
    key: "title",
    header: "Name / Title",
    render: (prd) => <span className="font-medium">{prd.title}</span>,
  },
  {
    key: "fileName",
    header: "File Name",
    render: (prd) => (
      <span className="font-mono text-muted-foreground text-sm">
        {prd.fileName ?? "-"}
      </span>
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
    render: (prd) => <ArtifactStatusBadge status={prd.status} />,
  },
  {
    key: "approver",
    header: "Approver",
    render: (prd) => (
      <span className="text-muted-foreground">{prd.approver ?? "-"}</span>
    ),
  },
  {
    key: "updatedAt",
    header: "Updated",
    render: (prd) => (
      <span className="text-muted-foreground">{formatDate(prd.updatedAt)}</span>
    ),
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
  { label: "Draft", value: "DRAFT" },
  { label: "Review", value: "REVIEW" },
  { label: "Approved", value: "APPROVED" },
  { label: "Archived", value: "ARCHIVED" },
];

export function PRDTable({ prds }: PRDTableProps) {
  const router = useRouter();

  const handleRowClick = (prd: ArtifactWithWorkstream) => {
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
      searchPlaceholder="Search PRDs..."
      sortOptions={sortOptions}
    />
  );
}
