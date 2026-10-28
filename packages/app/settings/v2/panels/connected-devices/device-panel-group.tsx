"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode, Ref } from "react";
import { useId } from "react";

/**
 * One of the three producers Connected Devices renders, as a labelled region
 * (PLN-1915 Step 3, D5).
 *
 * `h3` is deliberate: `SettingsPanelSection` supplies the panel's `h2` under the
 * modal's `h1`, so a group opening at `h2` would put two peers at one level and
 * flatten the outline a screen-reader user navigates by.
 */
export function DevicePanelGroup({
  title,
  description,
  children,
  ref,
}: Readonly<{
  title: string;
  description: string;
  children: ReactNode;
  /**
   * The labelled REGION, for a caller that scrolls this group into view. The
   * heading and its description live here and not in `children`, so a caller
   * holding only its own content scrolls to a point below them.
   */
  ref?: Ref<HTMLElement>;
}>) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} ref={ref}>
      <div className="mb-3">
        <h3 className="font-medium text-sm" id={headingId}>
          {title}
        </h3>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function DevicePanelInlineEmptyState({
  icon: Icon,
  title,
  description,
}: Readonly<{ icon: LucideIcon; title: string; description: string }>) {
  return (
    <div
      className="flex items-start gap-3 rounded-lg border border-dashed p-3"
      data-settings-panel-data-state="empty"
    >
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0">
        <p className="font-medium text-sm">{title}</p>
        <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
          {description}
        </p>
      </div>
    </div>
  );
}
