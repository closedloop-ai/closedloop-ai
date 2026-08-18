import { LANDING_HERO_SUBTITLE } from "@repo/lib/landing-hero-copy";
import { createMetadata } from "@repo/seo/metadata";
import { Github } from "lucide-react";
import type { Metadata } from "next";

export const siteTitle = "Closedloop.ai";
/**
 * ISS-5490: the same sentence the landing hero leads with. These had drifted —
 * the page said one thing and the tab, search result and social card said
 * another, so a visitor met two different products depending on where they
 * looked.
 */
export const siteDescription = LANDING_HERO_SUBTITLE;

export const locales = ["en", "de", "es", "fr", "pt", "zh"] as const;

export function localize(locale: string, href: string): string {
  if (href === "/") {
    return `/${locale}`;
  }

  return `/${locale}${href}`;
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
      icon: <Github className="size-4" />,
    },
  ];
}

export function createPageMetadata(
  title: string,
  description: string
): Metadata {
  return createMetadata({
    title,
    description,
  });
}
