"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  GridTable,
  type GridTableColumn,
} from "@repo/design-system/components/ui/grid-table";
import { CheckIcon, DownloadIcon } from "lucide-react";
import {
  installedComponentNamesFor,
  type Pack,
  type PackContentItem,
} from "../mock";
import { CONTENT_KIND_META } from "./pack-meta";

const COLUMNS: readonly GridTableColumn[] = [
  { id: "type", label: "Type" },
  { id: "description", label: "Description" },
  // No visible header (the check / Install affordance speaks for itself), but the
  // column still owns a grid track every body cell is announced against, so it
  // carries an accessible name instead of shipping a blank `columnheader`
  // (ISS-4672).
  { id: "installed", label: "", ariaLabel: "Installed" },
];

// Lead column + Type + Description + Installed.
const GRID_TEMPLATE = "minmax(240px,1.4fr) 140px minmax(280px,2fr) 132px";

// The pack's components rendered in the Agents-page inventory style: a full-width
// GridTable scoped to this pack (source = pack). The far-right Installed column
// carries a disabled "Installed" affordance for the current user's components
// (on desktop this is where the per-component Install button lives).
export const PackContentsTable = ({ pack }: { pack: Pack }) => {
  const installed = installedComponentNamesFor(pack);

  const renderLead = (item: PackContentItem) => (
    <span className="truncate font-medium text-sm">{item.name}</span>
  );

  const renderCell = (columnId: string, item: PackContentItem) => {
    if (columnId === "type") {
      const meta = CONTENT_KIND_META[item.kind];
      const Icon = meta.icon;
      return (
        <span className="flex items-center gap-1.5 text-sm">
          <Icon className={`size-3.5 shrink-0 ${meta.iconColor}`} />
          {meta.label}
        </span>
      );
    }
    if (columnId === "installed") {
      if (installed.has(item.name)) {
        return (
          <Button
            className="h-7 gap-1 text-xs"
            disabled
            size="sm"
            variant="secondary"
          >
            <CheckIcon className="size-3" />
            Installed
          </Button>
        );
      }
      return (
        <Button
          asChild
          className="h-7 gap-1 text-xs"
          size="sm"
          variant="outline"
        >
          <a href={pack.githubUrl} rel="noreferrer" target="_blank">
            <DownloadIcon className="size-3" />
            Install
          </a>
        </Button>
      );
    }
    return (
      <span className="truncate text-muted-foreground text-sm">
        {item.description}
      </span>
    );
  };

  return (
    <div className="overflow-x-auto">
      <GridTable
        columns={COLUMNS}
        getRowId={(item) => item.name}
        gridTemplateColumns={GRID_TEMPLATE}
        items={[...pack.contents]}
        leadingLabel="Component"
        renderCell={renderCell}
        renderLead={renderLead}
      />
    </div>
  );
};
