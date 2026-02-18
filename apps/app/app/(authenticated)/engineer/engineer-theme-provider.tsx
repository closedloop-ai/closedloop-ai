"use client";

import { useEffect } from "react";

/**
 * Adds the `engineer-theme` class to <html> while mounted.
 * This ensures CSS variable overrides apply to the entire page
 * including portaled content (dialogs, popovers, tooltips).
 */
export function EngineerThemeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    document.documentElement.classList.add("engineer-theme");
    return () => {
      document.documentElement.classList.remove("engineer-theme");
    };
  }, []);

  return <>{children}</>;
}
