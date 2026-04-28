import "./styles.css";
import { GoogleTagManager } from "@next/third-parties/google";
import { AnalyticsProvider } from "@repo/analytics/provider";
import { DesignSystemProvider } from "@repo/design-system";
import { fonts } from "@repo/design-system/lib/fonts";
import { cn } from "@repo/design-system/lib/utils";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import type { ReactNode } from "react";
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

const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const metadataBase = productionUrl
  ? new URL(
      `${productionUrl.startsWith("https") ? "https" : "http"}://${productionUrl}`
    )
  : new URL("https://closedloop.ai");

export const metadata: Metadata = {
  metadataBase,
};

const RootLayout = async ({ children, params }: RootLayoutProperties) => {
  const { locale } = await params;

  return (
    <html
      className={cn(fonts, "scroll-smooth", "light")}
      lang={locale}
      suppressHydrationWarning
    >
      <GoogleTagManager gtmId="GTM-MV8VKHSF" />
      <body className="min-h-screen bg-background text-foreground">
        <AnalyticsProvider>
          <DesignSystemProvider forcedTheme="light">
            <RootProvider>{children}</RootProvider>
          </DesignSystemProvider>
        </AnalyticsProvider>
      </body>
    </html>
  );
};

export default RootLayout;
