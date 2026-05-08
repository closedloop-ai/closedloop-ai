import type { ReactNode } from "react";
import { SiteBanner } from "@/app/[locale]/components/site-banner";
import { SiteFooter } from "@/app/[locale]/components/site-footer";
import { SiteHeader } from "@/app/[locale]/components/site-header";

type SiteLayoutProps = {
  children: ReactNode;
  params: Promise<{
    locale: string;
  }>;
};

const SiteLayout = async ({ children, params }: SiteLayoutProps) => {
  const { locale } = await params;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader locale={locale} />
      <SiteBanner />
      <main className="flex-1">{children}</main>
      <SiteFooter locale={locale} />
    </div>
  );
};

export default SiteLayout;
