"use client";

import { AuthProvider } from "@repo/auth/provider";
import type { ComponentProps } from "react";
import { useTheme } from "./theme";

type ThemedAuthProviderProperties = ComponentProps<typeof AuthProvider>;

export function ThemedAuthProvider(properties: ThemedAuthProviderProperties) {
  const { resolvedTheme } = useTheme();
  return <AuthProvider {...properties} resolvedTheme={resolvedTheme} />;
}
