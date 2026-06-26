import { env } from "@/env";
import { AppSurfaceAnalyticsProvider } from "@/lib/analytics/surface-analytics-adapter";
import { AppCoreAdapterProvider } from "@/lib/app-core-adapters";
import { resolveApiDeploymentPin } from "@/lib/deployment-pin";
import { appEnvironment, envIconPath } from "@/lib/environment";
import { AppNavigationProvider } from "@/lib/navigation/next-adapter";
import { QueryProvider } from "@/lib/query-client";
import "./styles.css";
import { DatadogAppRouter } from "@datadog/browser-rum-nextjs";
import { AnalyticsProvider } from "@repo/analytics/provider";
import { AuthProvider } from "@repo/auth/provider";
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
  title: "Closedloop.ai",
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

  // FEA-1485: resolve the api-prod deployment pin server-side and hand it to
  // the client adapter so app→api fetches forward `x-deployment-id`.
  const apiDeploymentId = await resolveApiDeploymentPin();

  return (
    <html
      className={`${fonts} ${silkscreen.variable}`}
      lang="en"
      suppressHydrationWarning
    >
      <body className="overflow-hidden">
        <DatadogAppRouter />
        <QueryProvider>
          <AnalyticsProvider bootstrapFeatureFlags nonce={nonce} trackPageViews>
            <AppSurfaceAnalyticsProvider>
              <DesignSystemProvider nonce={nonce}>
                <AuthProvider
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
                  <AppCoreAdapterProvider apiDeploymentId={apiDeploymentId}>
                    <AppNavigationProvider>{children}</AppNavigationProvider>
                  </AppCoreAdapterProvider>
                </AuthProvider>
              </DesignSystemProvider>
            </AppSurfaceAnalyticsProvider>
          </AnalyticsProvider>
        </QueryProvider>
      </body>
    </html>
  );
};

export default RootLayout;
