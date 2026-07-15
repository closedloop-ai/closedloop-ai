"use client";

import { Badge } from "@closedloop-ai/design-system/components/ui/badge";
import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { Tone } from "../types";

const toneClasses: Record<Tone, string> = {
  default: "border-input-border bg-input text-foreground",
  success: "border-success/25 bg-success/12 text-success",
  warning: "border-warning/30 bg-warning/14 text-warning-foreground",
  danger: "border-destructive/25 bg-destructive/12 text-destructive",
  info: "border-info/25 bg-info/12 text-info",
  accent: "border-primary/20 bg-primary/10 text-primary",
  muted: "border-border bg-muted/70 text-muted-foreground",
};

type ToneBadgeProps = {
  label: string;
  tone?: Tone;
  pulse?: boolean;
  className?: string;
};

export function ToneBadge({
  label,
  tone = "default",
  pulse = false,
  className,
}: ToneBadgeProps) {
  return (
    <Badge
      className={cn(
        "h-6 gap-1.5 rounded-full px-2.5 font-semibold text-[11px] tracking-[0.01em]",
        toneClasses[tone],
        className
      )}
      variant="outline"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full bg-current",
          pulse && "animate-[pulse_1.6s_ease-in-out_infinite]"
        )}
      />
      {label}
    </Badge>
  );
}
