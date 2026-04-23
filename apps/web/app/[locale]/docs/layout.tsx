import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { getDocsSource } from "@/lib/docs";
import { getSiteLinks, localize, siteTitle } from "@/lib/site";

type DocsLayoutProps = {
  children: ReactNode;
  params: Promise<{
    locale: string;
  }>;
};

const DocsSectionLayout = async ({ children, params }: DocsLayoutProps) => {
  const { locale } = await params;
  const source = getDocsSource(locale);

  return (
    <DocsLayout
      links={getSiteLinks(locale)}
      nav={{
        title: siteTitle,
        url: localize(locale, "/"),
      }}
      searchToggle={{ enabled: false }}
      sidebar={{ enabled: true }}
      tree={source.getPageTree()}
    >
      {children}
    </DocsLayout>
  );
};

export default DocsSectionLayout;
