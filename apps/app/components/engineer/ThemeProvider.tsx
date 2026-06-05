"use client";

import { useTheme } from "next-themes";

/**
 * Thin adapter over next-themes for closedloop-dev components that
 * import `useThemeContext` from `@/components/engineer/ThemeProvider`.
 */
export function useThemeContext() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const current = (resolvedTheme ?? theme ?? "light") as "light" | "dark";
  return {
    theme: current,
    setTheme,
    toggleTheme: () => setTheme(current === "dark" ? "light" : "dark"),
    mounted: true,
  };
}
