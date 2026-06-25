"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { Activity } from "lucide-react";

export type ModelUsageRow = {
  model: string;
  sessions: string;
  input: string;
  output: string;
  cache: string;
  cost: string;
};

type ModelUsageTableProps = {
  rows: ModelUsageRow[];
};

export function ModelUsageTable({ rows }: Readonly<ModelUsageTableProps>) {
  if (rows.length === 0) {
    return (
      <EmptyState
        className="py-8"
        description="Adjust the selected filters to see model usage."
        icon={Activity}
        title="No model usage"
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Model</TableHead>
          <TableHead className="text-right">Sessions</TableHead>
          <TableHead className="text-right">Input</TableHead>
          <TableHead className="text-right">Output</TableHead>
          <TableHead className="text-right">Cache</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.model}>
            <TableCell className="font-medium">{row.model}</TableCell>
            <TableCell className="text-right">{row.sessions}</TableCell>
            <TableCell className="text-right">{row.input}</TableCell>
            <TableCell className="text-right">{row.output}</TableCell>
            <TableCell className="text-right">{row.cache}</TableCell>
            <TableCell className="text-right">{row.cost}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
