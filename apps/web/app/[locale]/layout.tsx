import { resolveBrowserAnalyticsContext } from "@repo/analytics/browser-context";
import { Surface } from "@repo/api/src/types/surface-analytics";
import "./styles.css";
import { GoogleTagManager } from "@next/third-parties/google";
import { AnalyticsProvider } from "@repo/analytics/provider";
import { DesignSystemProvider } from "@repo/design-system";
import { fonts } from "@repo/design-system/lib/fonts";
import { cn } from "@repo/design-system/lib/utils";
import { siteUrl } from "@repo/seo/site-url";
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { MarketingSessionReplay } from "@/components/marketing-session-replay";
import { MarketingSurfaceAnalyticsProvider } from "@/components/marketing-surface-analytics-adapter";
import { WebRootProvider } from "@/components/web-root-provider";
import { env } from "@/env";
import { locales } from "@/lib/site";

type RootLayoutProperties = {
  readonly children: ReactNode;
  readonly params: Promise<{
    locale: string;
  }>;
};

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export const metadata: Metadata = {
  metadataBase: siteUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL),
};

const RootLayout = async ({ children, params }: RootLayoutProperties) => {
  const { locale } = await params;

  const nonce = env.CSP_ENABLED
    ? ((await headers()).get("x-nonce") ?? undefined)
    : undefined;

  return (
    <html
      className={cn(fonts, "scroll-smooth", "light")}
      lang={locale}
      suppressHydrationWarning
    >
      <GoogleTagManager gtmId="GTM-MV8VKHSF" nonce={nonce} />
      <body className="min-h-screen bg-background text-foreground">
        <AnalyticsProvider
          context={resolveBrowserAnalyticsContext({
            surface: Surface.Marketing,
            publicDeploymentEnvironment: process.env.NEXT_PUBLIC_VERCEL_ENV,
            deploymentEnvironment: process.env.VERCEL_ENV,
            appEnvironment: process.env.NEXT_PUBLIC_APP_ENVIRONMENT,
            siteUrl: analyticsSiteUrl(),
          })}
          nonce={nonce}
          trackPageViews
        >
          <MarketingSessionReplay />
          <MarketingSurfaceAnalyticsProvider>
            <DesignSystemProvider forcedTheme="light" nonce={nonce}>
              <WebRootProvider>{children}</WebRootProvider>
            </DesignSystemProvider>
          </MarketingSurfaceAnalyticsProvider>
        </AnalyticsProvider>
      </body>
    </html>
  );
};

export default RootLayout;

/**
 * The host the analytics environment is classified on (ISS-12554). On Vercel
 * that is the project's production domain, the same source as `metadataBase`:
 * web-prod sets no NEXT_PUBLIC_APP_ENVIRONMENT and its NEXT_PUBLIC_WEB_URL is
 * not a production marketing host. Off Vercel a copied production domain must
 * not label local events `prod`, so NEXT_PUBLIC_WEB_URL decides there.
 */
function analyticsSiteUrl(): string | undefined {
  const productionDomain = process.env.VERCEL_ENV
    ? siteUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL)?.href
    : undefined;
  return productionDomain ?? process.env.NEXT_PUBLIC_WEB_URL;
}
