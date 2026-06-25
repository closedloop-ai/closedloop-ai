"use client";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { ActivityIcon, UsersIcon } from "lucide-react";

export type LoopUsageCommandRow = {
  command: string;
  loops: string;
  input: string;
  output: string;
  cost: string;
};

export type LoopUsageUserRow = {
  id: string;
  name: string;
  avatarUrl?: string | null;
  loops: string;
  input: string;
  output: string;
  cost: string;
};

export function LoopUsageCommandTable({
  rows,
}: Readonly<{ rows: LoopUsageCommandRow[] }>) {
  if (rows.length === 0) {
    return (
      <EmptyState
        className="py-8"
        description="Select a different date range to see loop command activity."
        icon={ActivityIcon}
        title="No loop data"
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Command</TableHead>
          <TableHead className="text-right">Loops</TableHead>
          <TableHead className="text-right">Input Tokens</TableHead>
          <TableHead className="text-right">Output Tokens</TableHead>
          <TableHead className="text-right">Est. Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.command}>
            <TableCell className="font-medium">{row.command}</TableCell>
            <TableCell className="text-right">{row.loops}</TableCell>
            <TableCell className="text-right">{row.input}</TableCell>
            <TableCell className="text-right">{row.output}</TableCell>
            <TableCell className="text-right">{row.cost}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function LoopUsageUserTable({
  rows,
}: Readonly<{ rows: LoopUsageUserRow[] }>) {
  if (rows.length === 0) {
    return (
      <EmptyState
        className="py-8"
        description="Select a different date range to see user activity."
        icon={UsersIcon}
        title="No user data"
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead className="text-right">Loops</TableHead>
          <TableHead className="text-right">Input Tokens</TableHead>
          <TableHead className="text-right">Output Tokens</TableHead>
          <TableHead className="text-right">Est. Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <div className="flex items-center gap-2">
                <Avatar className="h-6 w-6">
                  <AvatarImage alt="" src={row.avatarUrl ?? undefined} />
                  <AvatarFallback>{row.name.charAt(0)}</AvatarFallback>
                </Avatar>
                <span className="font-medium">{row.name}</span>
              </div>
            </TableCell>
            <TableCell className="text-right">{row.loops}</TableCell>
            <TableCell className="text-right">{row.input}</TableCell>
            <TableCell className="text-right">{row.output}</TableCell>
            <TableCell className="text-right">{row.cost}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
