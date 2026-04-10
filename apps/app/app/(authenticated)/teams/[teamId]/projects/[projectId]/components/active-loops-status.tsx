"use client";

import { Loader2Icon, MonitorIcon } from "lucide-react";
import { useLoopsByProject } from "@/hooks/queries/use-loops";
import { useActiveLoops } from "@/hooks/use-active-loops";

type ActiveLoopsStatusProps = {
  projectId: string;
};

export function ActiveLoopsStatus({ projectId }: ActiveLoopsStatusProps) {
  const { data: loops = [], isLoading } = useLoopsByProject(projectId, {
    refetchInterval: 10_000,
  });

  const activeLoops = useActiveLoops(loops);

  if (isLoading || activeLoops.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2 border-border border-b bg-muted/50 px-6 py-2">
      <Loader2Icon className="h-4 w-4 animate-spin text-blue-500" />
      <MonitorIcon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-muted-foreground text-sm">
        {activeLoops.length} {activeLoops.length === 1 ? "loop" : "loops"}{" "}
        running
      </span>
    </div>
  );
}
