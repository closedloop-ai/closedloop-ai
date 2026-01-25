"use client";

import Link from "next/link";
import { Loader2Icon } from "lucide-react";
import { useRecentWorkstreams } from "@/hooks/queries/use-workstreams";
import { WorkstreamStateBadge } from "@/components/status-badge";

export function RecentWorkstreamsGrid() {
  const { data: result, isLoading } = useRecentWorkstreams(6);
  const workstreams = result?.success ? result.data : [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (workstreams.length === 0) {
    return (
      <div className="col-span-3 py-8 text-center text-muted-foreground">
        No workstreams yet. Create one to get started.
      </div>
    );
  }

  return (
    <div className="grid auto-rows-min gap-4 md:grid-cols-3">
      {workstreams.map((ws) => (
        <Link
          className="flex aspect-video flex-col justify-between rounded-xl bg-muted/50 p-4 transition-colors hover:bg-muted/70"
          href={`/workstreams/${ws.id}`}
          key={ws.id}
        >
          <div>
            <h3 className="font-medium">{ws.title}</h3>
            <p className="text-muted-foreground text-sm">{ws.project.name}</p>
          </div>
          <WorkstreamStateBadge state={ws.state} />
        </Link>
      ))}
    </div>
  );
}
