"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { HardDriveDownloadIcon } from "lucide-react";

export type ComputeTargetSyncRow = {
  id: string;
  machineName: string;
  ownerLabel: string;
  online: boolean;
  lastSyncLabel: string;
  /**
   * ISS-4828 (review, PR #4256): when this target's session rows last LANDED,
   * as distinct from `lastSyncLabel` — the last batch the cloud ACCEPTED.
   *
   * The two answer different questions — "is this machine connected and syncing"
   * versus "is it actually sending anything" — and correcting `lastSyncLabel` to
   * mean the accepted batch would otherwise have taken the landed-data signal
   * off the screen entirely.
   *
   * ISS-5280 (review): REQUIRED. It was optional while a flag could withhold it,
   * which left the column's visibility keyed off `rows.some(...)` — one row
   * supplying a label turned the column on for every row, and the rows without
   * one rendered a third word ("Unknown") for a state this column already spells
   * "Never". Requiring it makes that half-populated column unrepresentable
   * rather than merely uncovered.
   */
  lastDataLabel: string;
  lastSeenLabel: string;
};

type ComputeTargetSyncTableProps = {
  rows: ComputeTargetSyncRow[];
};

export function ComputeTargetSyncTable({
  rows,
}: Readonly<ComputeTargetSyncTableProps>) {
  if (rows.length === 0) {
    return (
      <EmptyState
        className="py-8"
        description="Connect a compute target to start reporting sync data here."
        icon={HardDriveDownloadIcon}
        title="No compute targets yet"
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Compute Target</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Last Sync</TableHead>
          {/* ISS-5280 (review): three relative-time columns sit side by side and
              all render the same shape of value, so the header is the only thing
              telling them apart. "Last New Data" names the question this one
              answers — when did this target last have something to send — which
              "Last Data" left a reader to infer from its neighbour. */}
          <TableHead>Last New Data</TableHead>
          <TableHead>Last Seen</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="font-medium">{row.machineName}</TableCell>
            <TableCell>{row.ownerLabel}</TableCell>
            <TableCell>
              <Badge variant="secondary">
                {row.online ? "online" : "offline"}
              </Badge>
            </TableCell>
            <TableCell>{row.lastSyncLabel}</TableCell>
            <TableCell>{row.lastDataLabel}</TableCell>
            <TableCell>{row.lastSeenLabel}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
