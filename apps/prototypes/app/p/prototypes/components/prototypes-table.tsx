"use client";

import {
  buildGridTableCardFields,
  GridTable,
  GridTableCard,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import type { SortDirection } from "@repo/design-system/components/ui/sortable-column-header";
import { useMediaQuery } from "@repo/design-system/hooks/use-media-query";
import { FileCode2Icon } from "lucide-react";
import type { ReactNode } from "react";
import type { PrototypeRow } from "../mock";
import {
  CollaboratorsCell,
  OpenCommentsCell,
  OwnerCell,
  PrototypeStatusChip,
  TagsCell,
  UpdatedCell,
} from "./prototype-cells";

const LEAD_WIDTH = "minmax(260px, 1fr)";

const COLUMN_SPECS: readonly (GridTableColumn & { width: string })[] = [
  { id: "owner", label: "Owner", width: "150px", sortable: true },
  {
    id: "collaborators",
    label: "Collaborators",
    width: "140px",
  },
  { id: "status", label: "Status", width: "145px", sortable: true },
  { id: "version", label: "Version", width: "88px", sortable: true },
  {
    id: "comments",
    label: "Open comments",
    width: "130px",
    sortable: true,
  },
  {
    id: "updated",
    label: "Last activity",
    width: "120px",
    sortable: true,
  },
  { id: "tags", label: "Tags", width: "210px", sortable: true },
];

const CARD_HEADER_COLUMN_IDS = new Set(["status"]);

export function PrototypesTable({
  items,
  onOpenDetail,
  sortBy,
  sortDir,
  onSort,
}: {
  items: PrototypeRow[];
  onOpenDetail: (item: PrototypeRow) => void;
  sortBy: string;
  sortDir: SortDirection;
  onSort: (column: string, direction: SortDirection) => void;
}) {
  const specs = [...COLUMN_SPECS];
  const columns = specs.map(({ width, ...column }) => column);
  const gridTemplateColumns = [
    LEAD_WIDTH,
    ...specs.map((spec) => spec.width),
  ].join(" ");
  const useCompactCards = useMediaQuery("(max-width: 1535px)");

  return (
    <GridTable
      cardRender={(item, cardColumns) => (
        <PrototypeCard
          columns={cardColumns}
          item={item}
          onOpenDetail={onOpenDetail}
        />
      )}
      columns={columns}
      getRowId={(item) => item.id}
      gridTemplateColumns={gridTemplateColumns}
      items={items}
      leadingLabel="Prototype name"
      leadingSortKey="name"
      mode={useCompactCards ? "compact" : "auto"}
      onSort={onSort}
      renderCell={(columnId, item) => renderPrototypeCell(columnId, item)}
      renderLead={(item) => {
        const content = (
          <>
            <FileCode2Icon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="truncate font-medium text-sm">{item.name}</span>
          </>
        );
        return item.id === "branches-v2" ? (
          <button
            className="flex min-w-0 items-center gap-1.5 text-left hover:underline"
            onClick={() => onOpenDetail(item)}
            type="button"
          >
            {content}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">{content}</span>
        );
      }}
      sortBy={sortBy}
      sortDir={sortDir}
    />
  );
}

function PrototypeCard({
  item,
  columns,
  onOpenDetail,
}: {
  item: PrototypeRow;
  columns: readonly GridTableColumn[];
  onOpenDetail: (item: PrototypeRow) => void;
}) {
  const renderCell = (columnId: string, row: PrototypeRow) =>
    renderPrototypeCell(columnId, row);
  const fields = buildGridTableCardFields(
    columns,
    CARD_HEADER_COLUMN_IDS,
    renderCell,
    item
  );

  return (
    <GridTableCard
      fields={fields}
      header={
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            {item.id === "branches-v2" ? (
              <button
                className="flex min-w-0 items-center gap-1.5 text-left"
                onClick={() => onOpenDetail(item)}
                type="button"
              >
                <FileCode2Icon
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="truncate font-medium text-sm">
                  {item.name}
                </span>
              </button>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                <FileCode2Icon
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="truncate font-medium text-sm">
                  {item.name}
                </span>
              </span>
            )}
            {renderCell("status", item)}
          </div>
        </div>
      }
    />
  );
}

function renderPrototypeCell(columnId: string, item: PrototypeRow): ReactNode {
  switch (columnId) {
    case "owner":
      return <OwnerCell person={item.owner} />;
    case "collaborators":
      return <CollaboratorsCell people={item.collaborators} />;
    case "status":
      return <PrototypeStatusChip status={item.status} />;
    case "version":
      return <span className="text-sm tabular-nums">v{item.version}</span>;
    case "comments":
      return <OpenCommentsCell count={item.openComments} />;
    case "updated":
      return <UpdatedCell item={item} />;
    case "tags":
      return <TagsCell tags={item.tags} />;
    default:
      return null;
  }
}
