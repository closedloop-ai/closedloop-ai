import { createMetadata } from "@repo/seo/metadata";
import type { Metadata } from "next";
import { GitHubLogo } from "@/components/github-logo";
import { publicPathname } from "./public-pathname";

export const siteTitle = "Closedloop.ai";
export const siteDescription =
  "Team-based agentic development for production software.";

export const locales = ["en", "de", "es", "fr", "pt", "zh"] as const;

export function localize(locale: string, href: string): string {
  if (href === "/") {
    return publicPathname(`/${locale}`);
  }

  return publicPathname(`/${locale}${href}`);
}

export function getSiteLinks(locale: string) {
  return [
    { text: "Documentation", url: localize(locale, "/docs") },
    {
      type: "icon" as const,
      label: "GitHub",
      text: "GitHub",
      url: "https://github.com/closedloop-ai",
      external: true,
      icon: <GitHubLogo className="size-4" />,
    },
  ];
}

// Route served by `app/opengraph-image.png`; Next absolutizes it against
// `metadataBase`. Every marketing page shares the one card. Without it nothing
// emits `og:image`, so the `summary_large_image` card we already advertise has
// no image to show and iMessage/LinkedIn/Slack fall back to a bare link.
const siteOpenGraphImage = "/opengraph-image.png";

// `path` is the UNPREFIXED route, so the six locales share one `og:url`. They
// are one document: this app makes no translation lookups, so `/de/pricing`
// serves the same English page as `/pricing`. Do not "fix" this by prefixing —
// `/en/*` always 307s away, and while `/de/pricing` does answer 200 to a
// German-preferring client, that render is the duplicate being consolidated.
//
// Required but nullable, so a new page has to decide rather than default:
// `null` is a render with no URL identity — a 404, or a route this host
// redirects off-site — and emits no `og:url`.
//
// Only `path` is nullable, because only `path` can be WRONG: there is one card
// and every page that renders wants it, while a URL that redirects off-site or
// does not resolve is worse than none. Neither argument reaches a 404 response
// either way — Next resolves only the LAYOUT module once a page calls
// `notFound()` (`resolve-metadata.js`, the `errorConvention` branch of
// `collectMetadata`), and `app/[locale]/layout.tsx` exports only
// `metadataBase`, so a 404 here carries no `og:url` AND no `og:image`.
export function createPageMetadata(
  title: string,
  description: string,
  path: string | null
): Metadata {
  return createMetadata({
    title,
    description,
    image: siteOpenGraphImage,
    ...(path === null ? {} : { path }),
  });
}
