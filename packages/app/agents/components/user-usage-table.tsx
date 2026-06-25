"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { Link } from "@repo/navigation/link";
import { UserIcon } from "lucide-react";

export type UserUsageRow = {
  id: string;
  label: string;
  sessions: string;
  input: string;
  output: string;
  cost: string;
  href?: string;
  active?: boolean;
};

type UserUsageTableProps = {
  rows: UserUsageRow[];
  onToggleUser?: (userId: string) => void;
};

export function UserUsageTable({
  rows,
  onToggleUser,
}: Readonly<UserUsageTableProps>) {
  if (rows.length === 0) {
    return (
      <EmptyState
        className="py-8"
        description="Adjust the selected filters to see user activity."
        icon={UserIcon}
        title="No user activity"
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead className="text-right">Sessions</TableHead>
          <TableHead className="text-right">Input</TableHead>
          <TableHead className="text-right">Output</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <Button
                className="h-auto px-0 font-medium"
                onClick={() => onToggleUser?.(row.id)}
                variant="ghost"
              >
                {row.label}
                {row.active ? (
                  <Badge className="ml-2" variant="secondary">
                    Filtered
                  </Badge>
                ) : null}
              </Button>
              {row.href ? (
                <Link
                  className="ml-2 text-muted-foreground text-xs underline underline-offset-2"
                  href={row.href}
                >
                  View sessions
                </Link>
              ) : null}
            </TableCell>
            <TableCell className="text-right">{row.sessions}</TableCell>
            <TableCell className="text-right">{row.input}</TableCell>
            <TableCell className="text-right">{row.output}</TableCell>
            <TableCell className="text-right">{row.cost}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
