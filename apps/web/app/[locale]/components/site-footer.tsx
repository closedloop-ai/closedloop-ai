import { Github } from "lucide-react";
import Link from "next/link";
import { GITHUB_REPO_URL } from "@/app/[locale]/(site)/components/home/constants";
import { ClosedloopLogo } from "@/app/[locale]/components/closedloop-logo";
import { localize } from "@/lib/site";

type SiteFooterProps = {
  locale: string;
};

type FooterColumn = {
  title: string;
  links: { label: string; href: string; external?: boolean }[];
};

const getFooterColumns = (locale: string): FooterColumn[] => [
  {
    title: "Product",
    links: [
      { label: "Pricing", href: localize(locale, "/pricing") },
      { label: "Resources", href: localize(locale, "/resources") },
      {
        label: "Documentation",
        href: "https://marketing.closedloop.ai/docs",
        external: true,
      },
    ],
  },
  {
    title: "Community",
    links: [
      { label: "Community", href: localize(locale, "/community") },
      { label: "Blog", href: localize(locale, "/blog") },
      { label: "GitHub", href: GITHUB_REPO_URL, external: true },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Contact", href: localize(locale, "/contact") },
      { label: "Privacy", href: localize(locale, "/legal/privacy") },
      { label: "Terms", href: localize(locale, "/legal/terms") },
    ],
  },
];

export const SiteFooter = ({ locale }: SiteFooterProps) => {
  const columns = getFooterColumns(locale);
  const year = new Date().getFullYear();

  return (
    <footer className="border-border/60 border-t">
      <div className="mx-auto w-full max-w-[1300px] px-6 py-16 md:px-10">
        <div className="grid gap-12 lg:grid-cols-[1.5fr_3fr]">
          <div className="flex flex-col gap-4">
            <Link
              aria-label="ClosedLoop.ai home"
              className="inline-flex"
              href={localize(locale, "/")}
            >
              <ClosedloopLogo className="h-8 w-auto text-foreground" />
            </Link>
            <p className="max-w-xs text-muted-foreground text-sm">
              From intent to implementation, faster. Team-based agentic
              development for production software.
            </p>
            <Link
              aria-label="ClosedLoop on GitHub"
              className="inline-flex w-fit items-center gap-2 rounded-md text-muted-foreground text-sm transition-colors hover:text-primary"
              href={GITHUB_REPO_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              <Github className="size-4" />
              github.com/closedloop-ai
            </Link>
          </div>
          <div className="grid gap-8 sm:grid-cols-3">
            {columns.map((column) => (
              <div className="flex flex-col gap-3" key={column.title}>
                <h3 className="font-semibold text-foreground text-sm">
                  {column.title}
                </h3>
                <ul className="flex flex-col gap-2">
                  {column.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        className="text-muted-foreground text-sm transition-colors hover:text-primary"
                        href={link.href}
                        rel={link.external ? "noopener noreferrer" : undefined}
                        target={link.external ? "_blank" : undefined}
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-12 border-border/60 border-t pt-6 text-muted-foreground text-xs">
          © {year} ClosedLoop.ai. All rights reserved.
        </div>
      </div>
    </footer>
  );
};
