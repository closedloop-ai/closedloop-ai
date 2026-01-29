import { env } from "@/env";
import { QueryProvider } from "@/lib/query-client";
import "./styles.css";
import { AnalyticsProvider } from "@repo/analytics/provider";
import { DesignSystemProvider } from "@repo/design-system";
import { fonts } from "@repo/design-system/lib/fonts";
import { Toolbar } from "@repo/feature-flags/components/toolbar";
import type { Metadata } from "next";
import type { ReactNode } from "react";

function getFaviconPath(): string {
  const vercelUrl =
    process.env.VERCEL_BRANCH_URL ||
    process.env.VERCEL_PROJECT_PRODUCTION_URL ||
    "";

  if (!process.env.VERCEL) {
    return "/loop_icon_local.png";
  }
  if (vercelUrl.includes("-stage")) {
    return "/loop_icon_staging.png";
  }
  return "/loop_icon.png";
}

export const metadata: Metadata = {
  title: "ClosedLoop.ai",
  icons: {
    icon: getFaviconPath(),
  },
};

type RootLayoutProperties = {
  readonly children: ReactNode;
};

const RootLayout = ({ children }: RootLayoutProperties) => (
  <html className={fonts} lang="en" suppressHydrationWarning>
    <body className="overflow-hidden">
      <QueryProvider>
        <AnalyticsProvider>
          <DesignSystemProvider
            helpUrl={env.NEXT_PUBLIC_DOCS_URL}
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
      <Toolbar />
    </body>
  </html>
);

export default RootLayout;
