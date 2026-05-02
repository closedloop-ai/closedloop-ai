"use client";

import { useTheme } from "@repo/design-system/providers/theme";

/**
 * Thin adapter over the design-system theme provider for closedloop-dev components that
 * import `useThemeContext` from `@/components/engineer/ThemeProvider`.
 */
export function useThemeContext() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const current = resolvedTheme ?? theme ?? "light";
  return {
    theme: current,
    setTheme,
    toggleTheme: () => setTheme(current === "dark" ? "light" : "dark"),
    mounted: true,
  };
}
