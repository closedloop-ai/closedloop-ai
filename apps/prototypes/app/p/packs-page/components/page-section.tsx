"use client";

import { SectionHeader } from "@repo/design-system/components/ui/section-header";
import type { ReactNode } from "react";

// A labelled page region: a `SectionHeader` (the DS section title primitive)
// with an optional one-line description and a trailing action slot, then the
// section body. Regions group with hierarchy, not with a bordered card around
// each one, so the surface stays calm. The `<section>` carries the section
// title as its accessible name.
type PageSectionProps = {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
};

export const PageSection = ({
  title,
  description,
  action,
  children,
}: PageSectionProps) => (
  <section aria-label={title} className="flex flex-col gap-4">
    <div className="flex flex-col gap-1">
      <SectionHeader title={title}>{action}</SectionHeader>
      {description ? (
        <p className="text-muted-foreground text-sm">{description}</p>
      ) : null}
    </div>
    {children}
  </section>
);
