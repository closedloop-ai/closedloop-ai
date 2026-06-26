"use client";

import type { ReviewerRow } from "@repo/api/src/types/insights";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { formatDurationMs } from "../../shared/lib/format-duration-ms";
import { formatNumber } from "../lib/format";
import { EmptyTile } from "./empty-tile";

export function ReviewerTable({ rows }: { rows: ReviewerRow[] }) {
  if (rows.length === 0) {
    return <EmptyTile />;
  }
  return (
    <div className="h-full overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Reviewer</TableHead>
            <TableHead className="text-right">Reviewed</TableHead>
            <TableHead className="text-right">Approved</TableHead>
            <TableHead className="text-right">Median wait</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.reviewer}>
              <TableCell className="font-medium">{row.reviewer}</TableCell>
              <TableCell className="text-right">
                {formatNumber(row.reviewed)}
              </TableCell>
              <TableCell className="text-right">
                {formatNumber(row.approved)}
              </TableCell>
              <TableCell className="text-right">
                {formatDurationMs(row.medianWaitMs)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
