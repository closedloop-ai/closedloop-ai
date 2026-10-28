"use client";

import { useResponsiveNarrowGridviewEnabled } from "@repo/app/shared/feature-flags/use-responsive-narrow-gridview";
import type { ReactNode } from "react";

/** Preserves captured-main width until the responsive Gridview rollout opens. */
export function ProjectGridContainment({ children }: { children: ReactNode }) {
  const responsiveGridviewEnabled = useResponsiveNarrowGridviewEnabled();
  return (
    <div
      className={responsiveGridviewEnabled ? "mt-0 min-w-0" : "mt-0 min-w-fit"}
    >
      {children}
    </div>
  );
}
