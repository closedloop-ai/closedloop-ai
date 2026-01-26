"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { Loader2Icon } from "lucide-react";
import Link from "next/link";
import { useWorkstreams } from "@/hooks/queries/use-workstreams";
import {
  WorkstreamStateBadge,
  WorkstreamTypeBadge,
} from "@/components/status-badge";
import { formatRelativeTime } from "@/lib/date-utils";

export function WorkstreamsList() {
  const { data: workstreams = [], isLoading, error } = useWorkstreams();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/20 bg-destructive/10 p-4 text-destructive">
        {error.message}
      </div>
    );
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
