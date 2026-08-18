import type { ReactNode } from "react";

const SECTION_TITLE_CLASS = "font-semibold text-foreground text-sm";

// Shared section title used by both the Cost breakdown and Lead-time widgets.
export function SectionHead({
  title,
  count,
}: {
  title: ReactNode;
  count?: ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center gap-2.5">
      <span className={SECTION_TITLE_CLASS}>{title}</span>
      {count == null ? null : (
        <span className="text-muted-foreground text-xs">{count}</span>
      )}
    </div>
  );
}
