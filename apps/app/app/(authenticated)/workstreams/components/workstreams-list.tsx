"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import Link from "next/link";
import { useMemo } from "react";
import { ColumnVisibilityPopover } from "@/components/custom-fields/column-visibility-popover";
import { CustomFieldCell } from "@/components/custom-fields/custom-field-cell";
import {
  WorkstreamStateBadge,
  WorkstreamTypeBadge,
} from "@/components/status-badge";
import { TableErrorState, TableLoadingState } from "@/components/table-states";
import { useWorkstreams } from "@/hooks/queries/use-workstreams";
import { useCustomFieldColumnVisibility } from "@/hooks/use-custom-field-column-visibility";
import { deriveCustomFieldColumns } from "@/lib/custom-field-utils";
import { formatRelativeTime } from "@/lib/date-utils";
import { sortByDateDesc } from "@/lib/table-utils";
import { getUserDisplayName } from "@/lib/user-utils";

export function WorkstreamsList() {
  const { data: workstreams = [], isLoading, error } = useWorkstreams();

  const customFieldColumns = useMemo(
    () => deriveCustomFieldColumns(workstreams),
    [workstreams]
  );

  const {
    handleToggleColumn,
    visibleColumnsRecord,
    visibleCustomFieldColumns,
  } = useCustomFieldColumnVisibility(customFieldColumns);

  if (isLoading) {
    return <TableLoadingState />;
  }

  if (error) {
    return <TableErrorState error={error} />;
  }

  if (workstreams.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
        <h3 className="mb-2 font-semibold text-lg">No workstreams yet</h3>
        <p className="mb-4 text-muted-foreground text-sm">
          Create your first workstream to get started
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {customFieldColumns.length > 0 && (
        <div className="flex justify-end">
          <ColumnVisibilityPopover
            fields={customFieldColumns.map((f) => ({
              customFieldId: f.customFieldId,
              name: f.name,
            }))}
            onToggle={handleToggleColumn}
            visibleColumns={visibleColumnsRecord}
          />
        </div>
      )}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Creator</TableHead>
              <TableHead>Updated</TableHead>
              {visibleCustomFieldColumns.map((field) => (
                <TableHead key={field.customFieldId}>{field.name}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortByDateDesc(workstreams, "updatedAt").map((workstream) => (
              <TableRow key={workstream.id}>
                <TableCell>
                  <Link
                    className="font-medium hover:underline"
                    href={`/workstreams/${workstream.id}`}
                  >
                    {workstream.title}
                  </Link>
                  {workstream.description ? (
                    <p className="line-clamp-1 text-muted-foreground text-sm">
                      {workstream.description}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>
                  <WorkstreamTypeBadge type={workstream.type} />
                </TableCell>
                <TableCell>
                  <WorkstreamStateBadge state={workstream.state} />
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {workstream.createdBy
                    ? getUserDisplayName(workstream.createdBy)
                    : "-"}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatRelativeTime(new Date(workstream.updatedAt))}
                </TableCell>
                {visibleCustomFieldColumns.map((colDef) => {
                  const fieldValue = workstream.customFields?.find(
                    (f) => f.customFieldId === colDef.customFieldId
                  );
                  return (
                    <TableCell key={colDef.customFieldId}>
                      {fieldValue ? (
                        <CustomFieldCell value={fieldValue} />
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
