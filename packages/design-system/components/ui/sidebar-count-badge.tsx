import { cn } from "@closedloop-ai/design-system/lib/utils";

type SidebarCountBadgeProps = Readonly<{
  count: number;
  className?: string;
  /**
   * Accessible name for the badge. Icon-adjacent count badges read as a bare
   * number to assistive tech, which is ambiguous; supply a descriptive label
   * (e.g. "3 recent") so the count is announced with meaning (WCAG 1.1.1).
   * Omit to keep the count as-is (back-compat with the plain numeric badge).
   */
  label?: string;
  /**
   * Cap above which the visible count renders as `<max>+` rather than the raw
   * number, so a large count never overflows the pill or misstates the value.
   * The accessible `label` still announces the true count. Omit to render the
   * exact count.
   */
  max?: number;
}>;

export function SidebarCountBadge({
  count,
  className,
  label,
  max,
}: SidebarCountBadgeProps) {
  const display =
    max !== undefined && count > max ? `${max}+` : String(count);
  return (
    <span
      aria-label={label}
      className={cn(
        // `min-w-5` keeps the single-digit pill a circle; `px-1` lets it grow to
        // hold `9+`/`99+` without clipping instead of a fixed width that lies.
        "ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 font-medium text-[10px] text-primary-foreground",
        className
      )}
      role={label ? "status" : undefined}
    >
      {display}
    </span>
  );
}
