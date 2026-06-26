"use client";

import { Chip } from "@repo/design-system/components/ui/chip";
import { KanbanCardFrame } from "@repo/design-system/components/ui/layout/kanban-board";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

export type KanbanArtifactCardProps = {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  kindLabel?: ReactNode;
  priorityLabel?: ReactNode;
  statusLabel?: ReactNode;
  assigneeLabel?: ReactNode;
  updatedLabel?: ReactNode;
  active?: boolean;
  variant?: "default" | "lane" | "drag-preview";
  className?: string;
  onClick?: () => void;
};

export function KanbanArtifactCard({
  title,
  subtitle,
  icon,
  kindLabel,
  priorityLabel,
  statusLabel,
  assigneeLabel,
  updatedLabel,
  active = false,
  variant = "default",
  className,
  onClick,
}: Readonly<KanbanArtifactCardProps>) {
  const content = (
    <KanbanCardFrame
      active={active}
      className={cn(
        "rounded-xl p-3 shadow-sm hover:border-border",
        CARD_VARIANT_CLASS_NAMES[variant],
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {icon ? (
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/12 text-amber-400">
              {icon}
            </div>
          ) : null}
          <div className="min-w-0 space-y-1">
            <p className="truncate font-medium text-sm">{title}</p>
            {subtitle ? (
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                {subtitle}
              </p>
            ) : null}
          </div>
        </div>
        {kindLabel ? (
          <Chip size="sm" variant="outline">
            {kindLabel}
          </Chip>
        ) : null}
      </div>
      {priorityLabel || statusLabel ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {priorityLabel ? (
            <Chip size="sm" variant="accent">
              {priorityLabel}
            </Chip>
          ) : null}
          {statusLabel ? (
            <Chip size="sm" variant="outline">
              {statusLabel}
            </Chip>
          ) : null}
        </div>
      ) : null}
      {assigneeLabel || updatedLabel ? (
        <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="truncate">{assigneeLabel}</span>
          <span className="shrink-0">{updatedLabel}</span>
        </div>
      ) : null}
    </KanbanCardFrame>
  );

  if (!onClick) {
    return content;
  }

  return (
    <button className="block w-full text-left" onClick={onClick} type="button">
      {content}
    </button>
  );
}

const CARD_VARIANT_CLASS_NAMES: Record<
  NonNullable<KanbanArtifactCardProps["variant"]>,
  string
> = {
  default: "",
  lane: "rounded-md shadow-none hover:bg-accent/50",
  "drag-preview": "cursor-grabbing rounded-md shadow-lg",
};
