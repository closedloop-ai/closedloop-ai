import { AgentStatusBadge } from "@repo/app/agents/components/session-status-badges";
import type { SessionAgent } from "@repo/app/agents/lib/session-types";
import { statusBorderClass } from "@repo/app/agents/lib/status-border-class";
import {
  formatDateTimeOrFallback,
  formatRelativeTimeOrFallback,
} from "@repo/app/shared/lib/date-utils";
import { Badge } from "@repo/design-system/components/ui/badge";
import { formatCurrency } from "@repo/design-system/components/ui/utils";
import { cn } from "@repo/design-system/lib/utils";
import { Bot, Clock3, Coins, Cpu, GitBranch, Wrench } from "lucide-react";

type AgentCardProps = {
  agent: SessionAgent;
  active?: boolean;
  className?: string;
};

export function AgentCard({
  agent,
  active = false,
  className,
}: AgentCardProps) {
  const isMain = agent.type === "main";
  const isWaiting = agent.status === "waiting";
  const isWorking = agent.status === "working";

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-3 shadow-sm transition-colors",
        statusBorderClass(isWaiting, isWorking),
        active && "border-primary/35 bg-primary/8 ring-1 ring-primary/20",
        !active && "hover:border-border",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
              isMain
                ? "bg-primary/12 text-primary"
                : "bg-violet-500/12 text-violet-400"
            )}
          >
            {isMain ? (
              <Bot className="size-4" />
            ) : (
              <GitBranch className="size-4" />
            )}
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium text-sm">{agent.name}</p>
              {agent.subagentType ? (
                <Badge className="font-mono text-[10px]" variant="outline">
                  {agent.subagentType}
                </Badge>
              ) : null}
            </div>
            {agent.label ? (
              <p className="truncate text-muted-foreground text-xs">
                {agent.label}
              </p>
            ) : null}
          </div>
        </div>
        <AgentStatusBadge status={agent.status} />
      </div>

      {agent.task ? (
        <p className="mt-3 line-clamp-2 text-muted-foreground text-xs leading-relaxed">
          {agent.task}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {agent.currentTool ? (
          <span className="inline-flex items-center gap-1">
            <Wrench className="size-3" />
            <span className="font-mono">{agent.currentTool}</span>
          </span>
        ) : null}
        {agent.model ? (
          <span className="inline-flex items-center gap-1">
            <Cpu className="size-3" />
            {agent.model}
          </span>
        ) : null}
        {typeof agent.cost === "number" && agent.cost > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Coins className="size-3" />
            {formatCurrency(agent.cost)}
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1">
          <Clock3 className="size-3" />
          {formatRelativeTimeOrFallback(
            agent.updatedAt || agent.endedAt || agent.startedAt
          )}
        </span>
      </div>

      <div className="mt-2 text-[11px] text-muted-foreground">
        Started {formatDateTimeOrFallback(agent.startedAt)}
      </div>
    </div>
  );
}
