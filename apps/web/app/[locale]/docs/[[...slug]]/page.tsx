import { Cards } from "fumadocs-ui/components/card";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import defaultMdxComponents, { createRelativeLink } from "fumadocs-ui/mdx";
import { notFound } from "next/navigation";
import { APIPage } from "@/components/api-page";
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
    // The page component 404s on this same predicate. Nothing returned here
    // reaches a crawler — Next drops the `generateMetadata` result once
    // `notFound()` is called — so `null` is belt-and-braces: it states the
    // intent at the branch rather than relying on that behavior.
    return createPageMetadata(
      "Documentation",
      "Closedloop.ai documentation",
      null
    );
  }

  // Built from the slug, not `page.url`: non-default sources retain their
  // locale prefix, while metadata consolidates every locale onto `/docs`.
  return createPageMetadata(
    page.data.title,
    page.data.description ?? "Closedloop.ai documentation",
    slug?.length ? `/docs/${slug.join("/")}` : "/docs"
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
            APIPage,
            CardGroup: Cards,
          }}
        />
      </DocsBody>
    </DocsPage>
  );
};

export default DynamicDocsPage;
