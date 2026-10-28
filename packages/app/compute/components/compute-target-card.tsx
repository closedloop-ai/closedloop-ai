"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

type ComputeTargetCardProps = {
  name: string;
  isOnline: boolean;
  securityBadge?: ReactNode;
  subtitle: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function ComputeTargetCard({
  name,
  isOnline,
  securityBadge,
  subtitle,
  actions,
  className,
}: Readonly<ComputeTargetCardProps>) {
  return (
    <div className={cn("rounded-lg border p-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate font-medium">{name}</p>
            <Badge
              className="capitalize"
              variant={isOnline ? "default" : "secondary"}
            >
              {isOnline ? "online" : "offline"}
            </Badge>
            {securityBadge}
          </div>
          <div className="text-muted-foreground text-xs">{subtitle}</div>
        </div>

        {actions ? (
          <div className="flex items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
