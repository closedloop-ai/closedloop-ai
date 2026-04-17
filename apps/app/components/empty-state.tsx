import { cn } from "@repo/design-system/lib/utils";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description?: string;
  className?: string;
  action?: ReactNode;
};

/**
 * Shared empty state component for displaying when lists are empty
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  className,
  action,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-12 text-center",
        className
      )}
    >
      <Icon className="mb-4 h-12 w-12 text-primary" />
      <h3 className="font-medium text-lg">{title}</h3>
      {description ? (
        <p className="mt-1 text-muted-foreground text-sm">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
