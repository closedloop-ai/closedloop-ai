import type { ThemeProviderProps } from "next-themes";
import { ThemeProvider as NextThemeProvider } from "next-themes";
import type { ReactNode } from "react";

export const ThemeProvider = ({
  children,
  ...properties
}: ThemeProviderProps & { children: ReactNode }) => (
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
