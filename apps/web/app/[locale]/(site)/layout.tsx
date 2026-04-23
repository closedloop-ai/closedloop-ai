import { HomeLayout } from "fumadocs-ui/layouts/home";
import type { ReactNode } from "react";
import { getSiteLinks, localize, siteTitle } from "@/lib/site";

type SiteLayoutProps = {
  children: ReactNode;
  params: Promise<{
    locale: string;
  }>;
};

const SiteLayout = async ({ children, params }: SiteLayoutProps) => {
  const { locale } = await params;

  return (
    <HomeLayout
      links={getSiteLinks(locale)}
      nav={{
        title: siteTitle,
        url: localize(locale, "/"),
      }}
      searchToggle={{ enabled: false }}
      themeSwitch={{ enabled: true }}
    >
      {children}
    </HomeLayout>
  );
};

export default SiteLayout;
