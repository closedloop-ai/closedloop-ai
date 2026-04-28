import { createMetadata } from "@repo/seo/metadata";
import { Github } from "lucide-react";
import type { Metadata } from "next";

export const siteTitle = "ClosedLoop.ai";
export const siteDescription =
  "Team-based agentic development for production software.";

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
