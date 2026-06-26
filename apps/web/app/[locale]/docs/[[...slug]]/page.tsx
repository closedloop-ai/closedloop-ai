import { Cards } from "fumadocs-ui/components/card";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents, { createRelativeLink } from "fumadocs-ui/mdx";
import { notFound } from "next/navigation";
import { getDocsSource } from "@/lib/docs";
import { createPageMetadata } from "@/lib/site";

type DocsPageProps = {
  params: Promise<{
    locale: string;
    slug?: string[];
  }>;
};

export async function generateStaticParams() {
  return ["en", "de", "es", "fr", "pt", "zh"].flatMap((locale) =>
    getDocsSource(locale)
      .generateParams()
      .map((item) => ({
        locale,
        slug: item.slug,
      }))
  );
}

export async function generateMetadata({ params }: DocsPageProps) {
  const { locale, slug } = await params;
  const source = getDocsSource(locale);
  const page = source.getPage(slug);

  if (!page) {
    return createPageMetadata("Documentation", "Closedloop.ai documentation");
  }

  return createPageMetadata(
    page.data.title,
    page.data.description ?? "Closedloop.ai documentation"
  );
}

const DynamicDocsPage = async ({ params }: DocsPageProps) => {
  const { locale, slug } = await params;
  const source = getDocsSource(locale);
  const page = source.getPage(slug);

  if (!page) {
    notFound();
  }

  const MDXContent = page.data.body;
  const LinkComponent = createRelativeLink(source, page);

  return (
    <DocsPage
      breadcrumb={{ enabled: true }}
      footer={{ enabled: true }}
      tableOfContent={{ enabled: true }}
      toc={page.data.toc}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDXContent
          components={{
            ...defaultMdxComponents,
            a: LinkComponent,
            CardGroup: Cards,
          }}
        />
      </DocsBody>
    </DocsPage>
  );
};

export default DynamicDocsPage;
