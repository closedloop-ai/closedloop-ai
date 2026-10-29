import { siteUrl } from "@repo/seo/site-url";
import type { MetadataRoute } from "next";
import { blogPosts } from "@/lib/blog";
import { locales, localize } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = siteUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL);

  // Every entry is an absolute URL, so with no base there is nothing to list.
  if (!baseUrl) {
    return [];
  }

  const now = new Date();
  const entries = new Map<string, MetadataRoute.Sitemap[number]>();

  for (const locale of locales) {
    const staticRoutes = ["/", "/blog", "/community", "/pricing", "/resources"];

    for (const route of staticRoutes) {
      const url = new URL(localize(locale, route), baseUrl).href;
      entries.set(url, { url, lastModified: now });
    }

    for (const post of blogPosts) {
      const url = new URL(localize(locale, `/blog/${post.slug}`), baseUrl).href;
      entries.set(url, { url, lastModified: new Date(post.publishedAt) });
    }
  }

  return [...entries.values()];
}
