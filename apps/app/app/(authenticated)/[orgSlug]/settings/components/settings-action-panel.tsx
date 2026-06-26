"use client";

import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

type SettingsActionPanelProps = {
  title: string;
  description: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function SettingsActionPanel({
  title,
  description,
  icon,
  action,
  className,
}: Readonly<SettingsActionPanelProps>) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3",
        className
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {icon ? <span className="text-muted-foreground">{icon}</span> : null}
          <p className="font-medium text-sm">{title}</p>
        </div>
        <div className="text-muted-foreground text-xs">{description}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
