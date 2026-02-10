import { ThemeProvider as NextThemeProvider } from "next-themes";
import type { ComponentProps, ReactNode } from "react";

type ThemeProviderProperties = ComponentProps<typeof NextThemeProvider> & {
  children: ReactNode;
};

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
