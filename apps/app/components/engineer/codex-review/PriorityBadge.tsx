import { cn } from "@repo/design-system/lib/utils";

const PRIORITY_COLORS: Record<string, string> = {
  P0: "bg-red-500/15 text-red-600 border-red-500/30",
  P1: "bg-red-500/10 text-red-500 border-red-500/20",
  P2: "bg-amber-500/10 text-amber-600 border-amber-500/20",
  P3: "bg-blue-500/10 text-blue-500 border-blue-500/20",
};

export function PriorityBadge({ priority }: Readonly<{ priority: string }>) {
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0.5 font-mono font-semibold text-[10px]",
        PRIORITY_COLORS[priority] || "bg-muted text-muted-foreground"
      )}
    >
      {priority}
    </span>
  );
}
