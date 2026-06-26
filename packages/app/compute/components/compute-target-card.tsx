"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Switch } from "@repo/design-system/components/ui/switch";
import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

type ComputeTargetCardProps = {
  name: string;
  isOnline: boolean;
  securityBadge?: ReactNode;
  subtitle: ReactNode;
  actions?: ReactNode;
  shareChecked: boolean;
  shareDisabled?: boolean;
  onShareCheckedChange?: (checked: boolean) => void;
  shareTitle?: string;
  shareDescription?: string;
  systemCheck?: ReactNode;
  className?: string;
};

export function ComputeTargetCard({
  name,
  isOnline,
  securityBadge,
  subtitle,
  actions,
  shareChecked,
  shareDisabled = false,
  onShareCheckedChange,
  shareTitle = "Share with team",
  shareDescription = "Allow anyone in your org to run jobs on this machine",
  systemCheck,
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

      <div className="mt-2 flex items-center justify-between border-t pt-2">
        <div>
          <p className="text-sm">{shareTitle}</p>
          <p className="text-muted-foreground text-xs">{shareDescription}</p>
        </div>
        <Switch
          checked={shareChecked}
          disabled={shareDisabled}
          onCheckedChange={onShareCheckedChange}
        />
      </div>

      {systemCheck}
    </div>
  );
}
