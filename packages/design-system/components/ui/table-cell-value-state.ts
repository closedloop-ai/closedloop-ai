import type { ElementType } from "react";
import { CircleAlertIcon, LockIcon } from "lucide-react";

export const TableCellValueState = {
  Default: "default",
  Error: "error",
  Forbidden: "forbidden",
  Loading: "loading",
  Partial: "partial",
  Unavailable: "unavailable",
} as const;

export type TableCellValueState =
  (typeof TableCellValueState)[keyof typeof TableCellValueState];

/** Approved visible label for an unavailable table-cell value. */
export const TABLE_CELL_UNAVAILABLE_LABEL = "Unavailable";

export type TableCellValueStateMetadata = {
  accessibleLabel: string;
  className: string;
  icon?: ElementType;
  visibleLabel: string;
};

export const TABLE_CELL_VALUE_STATE_METADATA: Readonly<
  Record<
    Exclude<
      TableCellValueState,
      typeof TableCellValueState.Default | typeof TableCellValueState.Loading
    >,
    TableCellValueStateMetadata
  >
> = {
  [TableCellValueState.Error]: {
    accessibleLabel: "Unable to load cell value",
    className: "text-destructive",
    icon: CircleAlertIcon,
    visibleLabel: "Error",
  },
  [TableCellValueState.Forbidden]: {
    accessibleLabel: "Cell value restricted",
    className: "text-muted-foreground",
    icon: LockIcon,
    visibleLabel: "Restricted",
  },
  [TableCellValueState.Partial]: {
    accessibleLabel: "Partial cell value",
    className: "text-warning-foreground",
    icon: CircleAlertIcon,
    visibleLabel: "Partial",
  },
  [TableCellValueState.Unavailable]: {
    accessibleLabel: "Cell value unavailable",
    className: "text-muted-foreground",
    visibleLabel: TABLE_CELL_UNAVAILABLE_LABEL,
  },
};
