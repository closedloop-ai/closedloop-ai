"use client";

import { Card, CardContent, CardHeader } from "./card";
import { GridEmptyValue, isEmptyCellValue } from "./grid-table-card";
import type { GridTableV2Column } from "./grid-table-v2";
import { resolveColumnControlName } from "@closedloop-ai/design-system/lib/grid-table-aria";
import type { ReactNode } from "react";

export type GridTableV2CardField = {
  key: string;
  label: string;
  value: ReactNode;
};

export function GridTableV2Card({
  header,
  fields,
  preserveEmptyFields = false,
}: {
  header: ReactNode;
  fields: readonly GridTableV2CardField[];
  /**
   * Keeps every supplied field visible and renders the shared empty-value
   * treatment for a nullish value. Omit to preserve the established compact
   * card policy that drops empty fields.
   */
  preserveEmptyFields?: boolean;
}) {
  const visibleFields = preserveEmptyFields
    ? fields.map(withVisibleEmptyValue)
    : fields.filter((field) => !isEmptyCellValue(field.value));
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">{header}</CardHeader>
      {visibleFields.length > 0 ? (
        <CardContent className="px-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            {visibleFields.map((field) => (
              <div className="flex min-w-0 flex-col gap-0.5" key={field.key}>
                <dt className="text-muted-foreground text-xs">{field.label}</dt>
                <dd className="flex min-w-0 items-center text-sm">
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      ) : null}
    </Card>
  );
}

/** Preserve each selected grid column's accessible name in its card field. */
export function buildGridTableV2CardFields<T>(
  columns: readonly GridTableV2Column[],
  excludeIds: ReadonlySet<string>,
  renderCell: (columnId: string, item: T) => ReactNode,
  item: T
): GridTableV2CardField[] {
  return columns
    .filter((column) => !excludeIds.has(column.id))
    .map((column) => ({
      key: column.id,
      label: resolveColumnControlName(
        column.label,
        column.id,
        column.ariaLabel
      ),
      value: renderCell(column.id, item),
    }));
}

/** Preserve an existing configured sentinel and normalize a nullish value. */
function withVisibleEmptyValue(
  field: GridTableV2CardField
): GridTableV2CardField {
  return field.value === null || field.value === undefined
    ? { ...field, value: <GridEmptyValue /> }
    : field;
}
