"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { Alert, AlertDescription } from "@repo/design-system/components/ui/alert";
import { Loader2Icon } from "lucide-react";
import Link from "next/link";
import {
  WorkstreamStateBadge,
  WorkstreamTypeBadge,
} from "@/components/status-badge";
import { useInProgressWorkstreams } from "@/hooks/queries/use-in-progress-workstreams";
import { formatRelativeTime } from "@/lib/date-utils";

export function InProgressWorkstreamsTable() {
  const { data: workstreams, isLoading, error } = useInProgressWorkstreams();

  if (isLoading) {
    return (
      <div className="flex justify-center p-8">
        <Loader2Icon className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Failed to load in-progress workstreams</AlertDescription>
      </Alert>
    );
  }

  if (!workstreams || workstreams.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center">
        <p className="text-muted-foreground">No in-progress workstreams</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Project</TableHead>
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
                {workstream.description && (
                  <div className="text-muted-foreground text-sm">
                    {workstream.description}
                  </div>
                )}
              </TableCell>
              <TableCell>{workstream.project.name}</TableCell>
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
