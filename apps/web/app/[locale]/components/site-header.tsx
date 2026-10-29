import Link from "next/link";
import { GITHUB_REPO_URL } from "@/app/[locale]/(site)/components/home/constants";
import { ClosedloopLogo } from "@/app/[locale]/components/closedloop-logo";
import { GitHubLogo } from "@/components/github-logo";
import { localize } from "@/lib/site";
import { MobileNav } from "./site-header-mobile";

type SiteHeaderProps = {
  locale: string;
};

const NAV_LINK_CLASS =
  "font-medium text-foreground/80 text-lg transition-colors hover:text-primary";

export const SiteHeader = ({ locale }: SiteHeaderProps) => {
  // Docs is a plain anchor (hard navigation) so that fumadocs CSS (a full
  // Tailwind v4 reset) does not get loaded into the marketing page DOM via
  // client-side routing — once loaded, its `.hidden` utility cascades after the
  // marketing site's `.lg\:block` and hides the header nav. Nav links are
  // written out, not mapped from a list, so the build can stamp their labels
  // as product copy for click analytics (ISS-12557).
  const docsHref = localize(locale, "/docs");
  const resourcesHref = localize(locale, "/resources");

  return (
    <header className="sticky top-0 z-40 h-[72px] w-full border-border/60 border-b bg-background">
      <div className="relative mx-auto flex h-full w-full max-w-[1300px] items-center justify-between px-6 md:px-10">
        <Link
          aria-label="Closedloop.ai home"
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
            <li>
              <a className={NAV_LINK_CLASS} href={docsHref}>
                Documentation
              </a>
            </li>
            <li>
              <Link className={NAV_LINK_CLASS} href={resourcesHref}>
                Resources
              </Link>
            </li>
          </ul>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <Link
            aria-label="Closedloop on GitHub"
            className="hidden items-center justify-center rounded-md p-2 text-foreground/70 transition-colors hover:bg-muted hover:text-foreground lg:flex"
            href={GITHUB_REPO_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            <GitHubLogo className="size-5" />
          </Link>
          <MobileNav
            docsHref={docsHref}
            githubUrl={GITHUB_REPO_URL}
            resourcesHref={resourcesHref}
          />
        </div>
      </div>
    </header>
  );
};
