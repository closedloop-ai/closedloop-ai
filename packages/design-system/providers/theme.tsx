"use client";

import { ThemeProvider as BaseThemeProvider } from "next-themes";
import type { FC, ReactNode } from "react";

type ThemeProviderProperties = {
  children: ReactNode;
  themes?: string[];
  forcedTheme?: string;
  nonce?: string;
  enableSystem?: boolean;
  disableTransitionOnChange?: boolean;
  enableColorScheme?: boolean;
  storageKey?: string;
  defaultTheme?: string;
  attribute?: string | string[];
  value?: Record<string, string>;
};

// next-themes@0.4.6 ThemeProviderProps inherits children via React.PropsWithChildren,
// which breaks under certain @types/react resolutions (e.g., Vercel CI resolving a
// different patch version). Casting avoids dependence on that broken type chain.
const NextThemeProvider =
  BaseThemeProvider as unknown as FC<ThemeProviderProperties>;

export const ThemeProvider = ({
  children,
  ...properties
}: ThemeProviderProperties) => (
  <NextThemeProvider
    attribute="class"
    defaultTheme="system"
    disableTransitionOnChange
    enableSystem
    {...properties}
  >
    {children}
  </NextThemeProvider>
);
