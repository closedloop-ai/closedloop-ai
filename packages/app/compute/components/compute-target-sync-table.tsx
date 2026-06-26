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
            <TableCell>{row.lastSeenLabel}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
