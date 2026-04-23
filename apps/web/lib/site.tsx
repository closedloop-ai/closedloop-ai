import { createMetadata } from "@repo/seo/metadata";
import { BookOpenText, FileText, Github, Network, Users } from "lucide-react";
import type { Metadata } from "next";

export const siteTitle = "ClosedLoop.ai Docs";
export const siteDescription =
  "Documentation, workflows, and category-defining content for team-based agentic development.";

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
    { text: "Blog", url: localize(locale, "/blog") },
    { text: "Resources", url: localize(locale, "/resources") },
    { text: "Community", url: localize(locale, "/community") },
    { text: "Pricing", url: localize(locale, "/pricing") },
    {
      type: "icon" as const,
      label: "GitHub",
      text: "GitHub",
      url: "https://github.com/closedloop-ai/symphony-alpha",
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

export const marketingHighlights = [
  {
    icon: BookOpenText,
    title: "Docs as the content graph",
    description:
      "Category pages, workflows, and glossary entries all live in one system that agents can edit safely.",
  },
  {
    icon: Network,
    title: "Built for AEO",
    description:
      "Structured docs, stable URLs, and mechanism-first content make the site useful to both humans and AI systems.",
  },
  {
    icon: FileText,
    title: "Agent-ready authoring",
    description:
      "Docs are organized predictably so agents can add pages, refactor sections, and open clean content PRs.",
  },
  {
    icon: Users,
    title: "Closer to the product",
    description:
      "The docs experience mirrors how ClosedLoop.ai turns PRDs into plans, loops, and shipped work.",
  },
] as const;
