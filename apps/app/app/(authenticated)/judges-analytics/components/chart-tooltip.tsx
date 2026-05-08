import type { ReactNode } from "react";

type TooltipShellProps = {
  title: string;
  children: ReactNode;
};

type TooltipRowProps = {
  label: string;
  value: string;
};

export function TooltipShell({ title, children }: TooltipShellProps) {
  return (
    <div className="rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
      <p className="mb-2 font-medium">{title}</p>
      <div className="grid gap-1.5">{children}</div>
    </div>
  );
}

export function TooltipRow({ label, value }: TooltipRowProps) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium font-mono">{value}</span>
    </div>
  );
}
