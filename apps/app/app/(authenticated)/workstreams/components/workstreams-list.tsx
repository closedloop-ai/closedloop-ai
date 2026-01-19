"use client";

import type { Workstream } from "@repo/api/src/types/workstream";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import Link from "next/link";
import {
  WorkstreamStateBadge,
  WorkstreamTypeBadge,
} from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/date-utils";

type WorkstreamsListProps = {
  workstreams: Workstream[];
};

export function WorkstreamsList({ workstreams }: WorkstreamsListProps) {
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
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {workstreams.map((workstream) => (
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
                {formatRelativeTime(new Date(workstream.updatedAt))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
