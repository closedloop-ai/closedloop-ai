"use client";

import { ClerkProvider } from "@clerk/nextjs";
import type { Appearance } from "@clerk/ui";
import { dark } from "@clerk/ui/themes";
import type { ComponentProps } from "react";
import { keys } from "./keys";

type AuthProviderProperties = ComponentProps<typeof ClerkProvider> & {
  nonce?: string;
  privacyUrl?: string;
  termsUrl?: string;
  helpUrl?: string;
  logoUrl?: string;
  resolvedTheme?: string;
};

export const AuthProvider = ({
  nonce,
  privacyUrl,
  termsUrl,
  helpUrl,
  logoUrl,
  resolvedTheme,
  ...properties
}: AuthProviderProperties) => {
  const isDark = resolvedTheme === "dark";
  const theme = isDark ? dark : undefined;

  const variables: Appearance["variables"] = {
    fontFamily: "var(--font-sans)",
    fontFamilyButtons: "var(--font-sans)",
    fontWeight: {
      bold: "var(--font-weight-bold)",
      normal: "var(--font-weight-normal)",
      medium: "var(--font-weight-medium)",
    },
  };

  const elements: Appearance["elements"] = {
    dividerLine: "bg-border",
    socialButtonsIconButton: "bg-card",
    navbarButton: "text-foreground",
    organizationSwitcherTrigger__open: "bg-background",
    organizationPreviewMainIdentifier: "text-foreground",
    organizationSwitcherTriggerIcon: "text-muted-foreground",
    organizationPreview__organizationSwitcherTrigger: "gap-2",
    organizationPreviewAvatarContainer: "shrink-0",
    // Embedded profile component styling
    rootBox: "w-full",
    cardBox: "shadow-none border-0",
    profileSectionPrimaryButton:
      "bg-primary text-primary-foreground hover:bg-primary/90",
    formButtonPrimary:
      "bg-primary text-primary-foreground hover:bg-primary/90 h-11",
    formButtonPrimary__icon: "hidden",
    badge: "bg-muted text-muted-foreground",
  };

  const options: Appearance["options"] = {
    logoImageUrl: logoUrl ?? keys().NEXT_PUBLIC_LOGO_URL,
    privacyPageUrl: privacyUrl,
    termsPageUrl: termsUrl,
    helpPageUrl: helpUrl,
  };

  return (
    <ClerkProvider
      {...properties}
      appearance={{ options, theme, elements, variables }}
      dynamic
      localization={{
        signIn: {
          start: {
            title: "Welcome to ClosedLoop",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
          },
        },
        userButton: {
          action__manageAccount: "Settings",
        },
      }}
      nonce={nonce}
    />
  );
};
