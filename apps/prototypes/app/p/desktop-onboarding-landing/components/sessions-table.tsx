"use client";

import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import type { SessionRow } from "../app-mock";

// One sessions table for both surfaces that list sessions (the Sessions page
// and the dashboard's Recent Sessions card), composed from the catalog
// GridTable so row height, hover, and cell treatment match the product.
const COLUMNS: readonly GridTableColumn[] = [
  { id: "status", label: "Status" },
  { id: "repo", label: "Repo" },
  { id: "model", label: "Model" },
  { id: "cost", label: "Cost" },
  { id: "when", label: "When" },
];

const GRID_TEMPLATE =
  "minmax(220px,1.6fr) 130px minmax(110px,0.8fr) minmax(160px,1fr) 90px 110px";

const renderCell = (columnId: string, session: SessionRow) => {
  switch (columnId) {
    case "status":
      return (
        <ToneBadge
          label={session.statusLabel}
          pulse={session.pulse}
          tone={session.statusTone}
        />
      );
    case "repo":
      return (
        <span className="truncate font-mono text-primary text-xs">
          {session.repo}
        </span>
      );
    case "model":
      return (
        <span className="truncate font-mono text-muted-foreground text-xs">
          {session.model}
        </span>
      );
    case "cost":
      return <span className="font-mono text-xs">{session.cost}</span>;
    case "when":
      return (
        <span className="text-muted-foreground text-sm">{session.when}</span>
      );
    default:
      return null;
  }
};

export const SessionsTable = ({ items }: { items: readonly SessionRow[] }) => (
  <GridTable
    columns={COLUMNS}
    getRowId={(session) => session.id}
    gridTemplateColumns={GRID_TEMPLATE}
    items={[...items]}
    leadingLabel="Session"
    renderCell={renderCell}
    renderLead={(session) => (
      <span className="truncate font-medium text-sm">{session.name}</span>
    )}
  />
);
