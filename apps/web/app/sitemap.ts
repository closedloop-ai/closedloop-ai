import type { MetadataRoute } from "next";
import { blogPosts } from "@/lib/blog";
import { locales, localize } from "@/lib/site";

function getBaseUrl() {
  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;

  if (productionUrl) {
    const protocol = productionUrl.startsWith("https") ? "https" : "http";
    return new URL(`${protocol}://${productionUrl}`);
  }

  return new URL("http://localhost:3001");
}

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getBaseUrl();
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
