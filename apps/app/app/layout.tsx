import { env } from "@/env";
import { appEnvironment, envIconPath } from "@/lib/environment";
import { QueryProvider } from "@/lib/query-client";
import "./styles.css";
import { AnalyticsProvider } from "@repo/analytics/provider";
import { DesignSystemProvider } from "@repo/design-system";
import { fonts } from "@repo/design-system/lib/fonts";
import type { Metadata } from "next";
import { Silkscreen } from "next/font/google";
import { headers } from "next/headers";
import type { ReactNode } from "react";

const silkscreen = Silkscreen({
  variable: "--font-pixel",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "ClosedLoop.ai",
  icons: {
    icon: envIconPath[appEnvironment],
  },
};

type RootLayoutProperties = {
  readonly children: ReactNode;
};

const RootLayout = async ({ children }: RootLayoutProperties) => {
  const nonce = env.CSP_ENABLED
    ? ((await headers()).get("x-nonce") ?? undefined)
    : undefined;

  return (
    <html
      className={`${fonts} ${silkscreen.variable}`}
      lang="en"
      suppressHydrationWarning
    >
      <body className="overflow-hidden" suppressHydrationWarning>
        <QueryProvider>
          <AnalyticsProvider bootstrapFeatureFlags nonce={nonce} trackPageViews>
            <DesignSystemProvider
              helpUrl={env.NEXT_PUBLIC_DOCS_URL}
              nonce={nonce}
              privacyUrl={new URL(
                "/legal/privacy",
                env.NEXT_PUBLIC_WEB_URL
              ).toString()}
              termsUrl={new URL(
                "/legal/terms",
                env.NEXT_PUBLIC_WEB_URL
              ).toString()}
            >
              {children}
            </DesignSystemProvider>
          </AnalyticsProvider>
        </QueryProvider>
      </body>
    </html>
  );
};

export default RootLayout;
