"use client";

import { ThemeProvider as BaseThemeProvider } from "next-themes";
import type { FC, ReactNode, ScriptHTMLAttributes } from "react";

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

type NextThemeProviderProperties = ThemeProviderProperties & {
  scriptProps?: ScriptHTMLAttributes<HTMLScriptElement>;
};

// next-themes@0.4.6 ThemeProviderProps inherits children via React.PropsWithChildren,
// which breaks under certain @types/react resolutions (e.g., Vercel CI resolving a
// different patch version). Casting avoids dependence on that broken type chain.
const NextThemeProvider =
  BaseThemeProvider as unknown as FC<NextThemeProviderProperties>;

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
    scriptProps={clientScriptProps}
  >
    {children}
  </NextThemeProvider>
);

// next-themes renders its no-flash script inside ThemeProvider, and React warns
// "Encountered a script tag while rendering React component" whenever it creates
// that script on the client (pacocoursey/next-themes#385, #397). React inserts a
// client-created script through innerHTML, so it never runs; typing it as a data
// block there changes nothing but the warning. The server HTML keeps the
// executable script that applies the theme before first paint.
const clientScriptProps: NextThemeProviderProperties["scriptProps"] =
  typeof window === "undefined" ? undefined : { type: "application/json" };
