import { cn } from "@repo/design-system/lib/utils";

type SidebarCountBadgeProps = Readonly<{
  count: number;
  className?: string;
}>;

export function SidebarCountBadge({
  count,
  className,
}: SidebarCountBadgeProps) {
  return (
    <span
      className={cn(
        "ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-primary font-medium text-[10px] text-primary-foreground",
        className
      )}
    >
      {count}
    </span>
  );
}
