"use client";

import type { LoopWithUser } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import { CloudIcon, Loader2Icon, MonitorIcon } from "lucide-react";
import { useLoopsByProject } from "@/hooks/queries/use-loops";
import { ACTIVE_LOOP_STATUSES } from "@/lib/loop-constants";
import { getUserDisplayName } from "@/lib/user-utils";

const COMMAND_VERBS: Record<LoopCommand, string> = {
  [LoopCommand.Plan]: "creating plan",
  [LoopCommand.Execute]: "executing",
  [LoopCommand.Chat]: "chatting",
  [LoopCommand.Explore]: "exploring",
  [LoopCommand.RequestChanges]: "requesting changes",
  [LoopCommand.Decompose]: "decomposing",
  [LoopCommand.EvaluatePrd]: "evaluating PRD",
  [LoopCommand.GeneratePrd]: "generating PRD",
};

function formatLoopStatus(loop: LoopWithUser): string {
  const name = getUserDisplayName(loop.user);
  const verb = COMMAND_VERBS[loop.command] ?? loop.command.toLowerCase();
  const target = loop.computeTarget ? "locally" : "in cloud";
  return `${name} ${verb} ${target}`;
}

type ActiveLoopsStatusProps = {
  projectId: string;
};

export function ActiveLoopsStatus({ projectId }: ActiveLoopsStatusProps) {
  const { data: loops = [], isLoading } = useLoopsByProject(projectId, {
    refetchInterval: 10_000,
  });

  const activeLoops = loops.filter((l) => ACTIVE_LOOP_STATUSES.has(l.status));

  if (isLoading || activeLoops.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-3 border-border border-b bg-muted/50 px-6 py-2">
      <Loader2Icon className="h-4 w-4 animate-spin text-blue-500" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {activeLoops.map((loop) => (
          <span
            className="inline-flex items-center gap-1.5 text-muted-foreground text-sm"
            key={loop.id}
          >
            {loop.computeTarget ? (
              <MonitorIcon className="h-3.5 w-3.5" />
            ) : (
              <CloudIcon className="h-3.5 w-3.5" />
            )}
            {formatLoopStatus(loop)}...
          </span>
        ))}
      </div>
    </div>
  );
}
