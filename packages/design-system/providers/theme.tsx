import { ThemeProvider as BaseThemeProvider } from "next-themes";
import type { FC, ReactNode } from "react";

type ThemeProviderProperties = {
  children: ReactNode;
  themes?: string[];
  forcedTheme?: string;
  enableSystem?: boolean;
  disableTransitionOnChange?: boolean;
  enableColorScheme?: boolean;
  storageKey?: string;
  defaultTheme?: string;
  attribute?: string | string[];
  value?: Record<string, string>;
  nonce?: string;
};

// next-themes@0.4.6 ThemeProviderProps inherits children via React.PropsWithChildren,
// which breaks under certain @types/react resolutions (e.g., Vercel CI resolving a
// different patch version). Casting avoids dependence on that broken type chain.
const NextThemeProvider =
  BaseThemeProvider as unknown as FC<ThemeProviderProperties>;

const defaultThemes = ["light", "dark", "hybrid", "system"];

/** Maps theme id → class on <html>. Ensures classList.remove uses these three (next-themes uses
 *  Object.values(value) for removal when `value` is set; without it, a stale list can leave
 *  `hybrid` on the element when switching to light). `system` resolves to light/dark before apply. */
const defaultThemeClassNames: Record<string, string> = {
  dark: "dark",
  hybrid: "hybrid",
  light: "light",
};

export const ThemeProvider = ({
  children,
  themes = defaultThemes,
  value = defaultThemeClassNames,
  ...properties
}: ThemeProviderProperties) => (
  <NextThemeProvider
    attribute="class"
    defaultTheme="system"
    disableTransitionOnChange
    enableSystem
    themes={themes}
    value={value}
    {...properties}
  >
    {children}
  </NextThemeProvider>
);
