import type { ReactNode } from "react";

/**
 * Shared header for the overview dashboard's chart cards (Event Activity, Model
 * Usage, Autonomy, …). Matches the "Recent Sessions" card header exactly: a
 * `text-xl` title and `text-sm` support copy separated by an 8px gap (the
 * design-system CardHeader `gap-2`), with no divider. `actions` renders on the
 * same row when space allows and wraps below on narrow widths.
 */
export function SectionHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 pb-3">
      <div className="flex min-w-0 flex-1 basis-56 flex-col gap-2">
        <h3 className="font-semibold text-[var(--foreground)] text-xl leading-none tracking-tight">
          {title}
        </h3>
        {description ? (
          <p className="text-[var(--muted-foreground)] text-sm">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
