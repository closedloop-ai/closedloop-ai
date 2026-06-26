"use client";

import {
  HarnessBadge,
  SessionStatusBadge,
} from "@repo/app/agents/components/session-status-badges";
import type { SessionRow } from "@repo/app/agents/lib/session-types";
import { statusBorderClass } from "@repo/app/agents/lib/status-border-class";
import { formatRelativeTimeOrFallback } from "@repo/app/shared/lib/date-utils";
import { Chip } from "@repo/design-system/components/ui/chip";
import {
  formatCurrency,
  truncateMiddle,
} from "@repo/design-system/components/ui/utils";
import { cn } from "@repo/design-system/lib/utils";
import { Bot, Clock3, Coins, Cpu, FolderOpen, PlayCircle } from "lucide-react";

type SessionCardProps = {
  session: SessionRow;
  active?: boolean;
  className?: string;
  onClick?: () => void;
};

export function SessionCard({
  session,
  active = false,
  className,
  onClick,
}: SessionCardProps) {
  const Comp = onClick ? "button" : "div";
  const isWaiting =
    session.status === "waiting" || !!session.awaitingInputSince;
  const isActive = session.status === "active";

  return (
    <Comp
      className={cn(
        "block w-full rounded-xl border bg-card p-3 text-left shadow-sm transition-colors",
        statusBorderClass(isWaiting, isActive),
        active && "bg-primary/8 ring-1 ring-primary/20",
        !onClick && "hover:border-border",
        className
      )}
      onClick={onClick}
      type={onClick ? "button" : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
            <FolderOpen className="size-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <p className="truncate font-medium text-sm">{session.name}</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {session.id}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <HarnessBadge harness={session.harness} />
          <SessionStatusBadge status={session.status} />
        </div>
      </div>

      <p className="mt-3 truncate font-mono text-[11px] text-muted-foreground">
        {truncateMiddle(session.repo, 56)}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Bot className="size-3" />
          {session.agents} agents
        </span>
        <span className="inline-flex items-center gap-1">
          <Cpu className="size-3" />
          {session.model}
        </span>
        {session.cost > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Coins className="size-3" />
            {formatCurrency(session.cost)}
          </span>
        ) : null}
        {session.durationLabel ? (
          <span className="inline-flex items-center gap-1">
            <Clock3 className="size-3" />
            {session.durationLabel}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {formatRelativeTimeOrFallback(session.lastActivity)}
        </span>
        {session.isRunDriven ? (
          <Chip size="sm" variant="accent">
            <PlayCircle className="size-3" />
            Run-backed
          </Chip>
        ) : null}
      </div>
    </Comp>
  );
}
