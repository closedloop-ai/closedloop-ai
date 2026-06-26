import { cn } from "@repo/design-system/lib/utils";
import type { ReactNode } from "react";

// Summary cards lay out in a single non-wrapping row that overflows
// horizontally and scrolls with the table (the host page shares one scroll
// container), per the Claude Design prototype. Each card is a fixed width so it
// never shrinks. Shared by the Sessions and Branches summary-card rows.
export const SUMMARY_CARD_CLASS = "w-[260px] shrink-0";

export function SummaryCardRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("flex gap-4", className)}>{children}</div>;
}
