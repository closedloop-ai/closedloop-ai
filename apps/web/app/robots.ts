import { siteUrl } from "@repo/seo/site-url";
import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const rules = {
    userAgent: "*",
    allow: "/",
  };
  const baseUrl = siteUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL);

  // `Sitemap:` takes an absolute URL, so with no base there is none to name.
  if (!baseUrl) {
    return { rules };
  }

  return {
    rules,
    sitemap: new URL("/sitemap.xml", baseUrl).href,
  };
}
