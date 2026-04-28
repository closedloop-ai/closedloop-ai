import { Github } from "lucide-react";
import Link from "next/link";
import { GITHUB_REPO_URL } from "@/app/[locale]/(site)/components/home/constants";
import { ClosedloopLogo } from "@/app/[locale]/components/closedloop-logo";
import { localize } from "@/lib/site";
import { MobileNav } from "./site-header-mobile";

type SiteHeaderProps = {
  locale: string;
};

type NavLink = {
  label: string;
  href: string;
  external?: boolean;
};

const getNavLinks = (locale: string): NavLink[] => [
  {
    label: "Documentation",
    href: "https://marketing.closedloop.ai/docs",
    external: true,
  },
  { label: "Blog", href: localize(locale, "/blog") },
  { label: "Resources", href: localize(locale, "/resources") },
  { label: "Community", href: localize(locale, "/community") },
];

export const SiteHeader = ({ locale }: SiteHeaderProps) => {
  const navLinks = getNavLinks(locale);

  return (
    <header className="sticky top-0 z-40 h-[72px] w-full border-border/60 border-b bg-background">
      <div className="relative mx-auto flex h-full w-full max-w-[1300px] items-center justify-between px-6 md:px-10">
        <Link
          aria-label="ClosedLoop.ai home"
          className="flex shrink-0 items-center"
          href={localize(locale, "/")}
        >
          <ClosedloopLogo className="h-[1.6rem] w-auto text-foreground" />
        </Link>

        <nav
          aria-label="Primary"
          className="absolute left-1/2 hidden -translate-x-1/2 lg:block"
        >
          <ul className="flex items-center gap-8">
            {navLinks.map((link) => (
              <li key={link.href}>
                <Link
                  className="font-medium text-foreground/80 text-lg transition-colors hover:text-primary"
                  href={link.href}
                  rel={link.external ? "noopener noreferrer" : undefined}
                  target={link.external ? "_blank" : undefined}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <Link
            aria-label="ClosedLoop on GitHub"
            className="hidden items-center justify-center rounded-md p-2 text-foreground/70 transition-colors hover:bg-muted hover:text-foreground lg:flex"
            href={GITHUB_REPO_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            <Github className="size-5" />
          </Link>
          <MobileNav githubUrl={GITHUB_REPO_URL} navLinks={navLinks} />
        </div>
      </div>
    </header>
  );
};
