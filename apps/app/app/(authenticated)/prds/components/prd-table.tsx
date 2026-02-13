"use client";

import type { ArtifactWithWorkstream } from "@repo/api/src/types/artifact";
import {
  type Column,
  DataTable,
  type FilterOption,
  type SortOption,
} from "@repo/design-system/components/ui/data-table";
import { useRouter } from "next/navigation";
import { PullRequestLink } from "@/components/pull-request-link";
import { ArtifactStatusBadge } from "@/components/status-badge";
import { TableErrorState, TableLoadingState } from "@/components/table-states";
import { useArtifactsBySubtype } from "@/hooks/queries/use-artifacts";
import { formatRelativeTime } from "@/lib/date-utils";
import { getUserDisplayName } from "@/lib/user-utils";
import { PRDRowActions } from "./prd-row-actions";

const columns: Column<ArtifactWithWorkstream>[] = [
  {
    key: "title",
    header: "Name / Title",
    render: (prd) => (
      <div className="flex items-center gap-2">
        <span className="font-medium">{prd.title}</span>
        <PullRequestLink pullRequest={prd.pullRequest} />
      </div>
    ),
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
      <span className="text-muted-foreground">
        {prd.approver ? getUserDisplayName(prd.approver) : "-"}
      </span>
    ),
  },
  {
    key: "owner",
    header: "Creator",
    render: (prd) => (
      <span className="text-muted-foreground">
        {prd.owner ? getUserDisplayName(prd.owner) : "-"}
      </span>
    ),
  },
  {
    key: "updatedAt",
    header: "Updated",
    render: (prd) => (
      <span className="text-muted-foreground">
        {formatRelativeTime(prd.updatedAt)}
      </span>
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

export function PRDTable() {
  const router = useRouter();
  const { data: prds = [], isLoading, error } = useArtifactsBySubtype("PRD");

  const handleRowClick = (prd: ArtifactWithWorkstream) => {
    router.push(`/prds/${prd.documentSlug}`);
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
