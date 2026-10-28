import {
  AssigneeCell,
  DueDateCell,
  PriorityCell,
} from "@repo/app/documents/components/table/cells/edit-cells";
import {
  ParentCell,
  ProjectCell,
  TypeCell,
  UpdatedCell,
} from "@repo/app/documents/components/table/cells/static-cells";
import { TagsCell } from "@repo/app/documents/components/table/cells/tags-cell";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import type { DocumentColumn } from "@repo/app/shared/hooks/use-column-visibility";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import type { ComponentType } from "react";

/**
 * Which component paints one data column's cell, for every body that renders an
 * artifact row.
 *
 * Exhaustive over `DocumentColumn` on purpose: a new column fails `tsc` here
 * rather than rendering a blank cell wherever the map is read. Lifted out of
 * `document-row.tsx` (ISS-9335) once a second body — the shared-grid one —
 * needed the same mapping; two copies would have let one body's Priority cell
 * drift from the other's.
 */
export const CELL_RENDERERS: Record<
  DocumentColumn,
  ComponentType<{ item: DocumentRowItem }>
> = {
  [Col.Type]: TypeCell,
  [Col.Parent]: ParentCell,
  [Col.DueDate]: DueDateCell,
  [Col.Assignee]: AssigneeCell,
  [Col.Priority]: PriorityCell,
  [Col.Tags]: TagsCell,
  [Col.Updated]: UpdatedCell,
  [Col.Project]: ProjectCell,
};
