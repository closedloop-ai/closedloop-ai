"use client";

import type { ReactNode } from "react";
import { useId } from "react";

export type SettingsPanelSectionProps = {
  title: string;
  description: string;
  children: ReactNode;
};

/**
 * The heading block every Settings v2 panel body opens with — the shape the
 * approved Web Master v2 prototype gives each panel (`SettingsSection`).
 *
 * Lives here rather than inside one panel because seven panel packages
 * (ISS-8363..8369) each render one, and a per-panel copy is how the heading
 * level and the labelled region drift apart between them.
 *
 * `h2` is deliberate and load-bearing: the modal supplies the `h1` through its
 * own `DialogTitle` (ISS-8977), so a panel opening at `h1` would give the
 * dialog two.
 */
export function SettingsPanelSection({
  title,
  description,
  children,
}: Readonly<SettingsPanelSectionProps>) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId}>
      <div className="mb-4">
        <h2 className="font-semibold text-lg tracking-tight" id={headingId}>
          {title}
        </h2>
        <p className="mt-1 text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}
