import type { MetadataRoute } from "next";

function getBaseUrl() {
  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;

  if (productionUrl) {
    const protocol = productionUrl.startsWith("https") ? "https" : "http";
    return new URL(`${protocol}://${productionUrl}`);
  }

  return new URL("http://localhost:3001");
}

export default function robots(): MetadataRoute.Robots {
  const baseUrl = getBaseUrl();

  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: new URL("/sitemap.xml", baseUrl).href,
  };
}
