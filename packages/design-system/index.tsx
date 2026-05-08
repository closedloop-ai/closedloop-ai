import { AuthProvider } from "@repo/auth/provider";
import type { ComponentProps, ReactNode } from "react";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { ThemeProvider } from "./providers/theme";

type DesignSystemProviderProperties = ComponentProps<typeof ThemeProvider> & {
  children: ReactNode;
  nonce?: string;
  privacyUrl?: string;
  termsUrl?: string;
  helpUrl?: string;
};

export const DesignSystemProvider = ({
  children,
  privacyUrl,
  termsUrl,
  helpUrl,
  ...properties
}: DesignSystemProviderProperties) => (
  <ThemeProvider {...properties}>
    <AuthProvider
      helpUrl={helpUrl}
      nonce={properties.nonce}
      privacyUrl={privacyUrl}
      termsUrl={termsUrl}
    >
      <TooltipProvider>{children}</TooltipProvider>
      <Toaster />
    </AuthProvider>
  </ThemeProvider>
);
