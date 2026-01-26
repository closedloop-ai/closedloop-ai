"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Loader2Icon } from "lucide-react";
import { useSearchWorkstreams } from "@/hooks/queries/use-workstreams";
import { WorkstreamStateBadge } from "@/components/status-badge";

export function SearchResults() {
  const searchParams = useSearchParams();
  const query = searchParams.get("q") ?? "";

  const { data: workstreams = [], isLoading } = useSearchWorkstreams(query);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="mb-4">
        <p className="text-muted-foreground">
          {workstreams.length} result{workstreams.length !== 1 ? "s" : ""} for
          &quot;{query}&quot;
        </p>
      </div>
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
      {workstreams.length === 0 && (
        <div className="py-8 text-center text-muted-foreground">
          No workstreams found matching your search.
        </div>
      )}
    </>
  );
}
