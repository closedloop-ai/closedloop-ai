import { GitHubMark } from "@repo/design-system/components/ui/brand-icons";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { footerColumns, githubRepoUrl, headerNavLinks } from "../mock";
import { MobileNav } from "./mobile-nav";
import { SiteBanner } from "./site-banner";

type MarketingShellProps = {
  readonly children: ReactNode;
};

// A stand-in for `apps/web/app/[locale]/(site)/layout.tsx` so the screen can be
// judged in the chrome it will actually ship inside. It is context, not the
// design under review.
//
// It does NOT inherit: production has to compose this chrome explicitly. A
// stale link is rewritten into `[locale]` by proxy.ts, `(site)` has no
// catch-all route, and apps/web has no `not-found.tsx` at any level, so an
// unmatched path today renders Next's built-in not-found inside
// `[locale]/layout.tsx` — above SiteLayout, with no header, banner or footer.
// Whoever builds this either mounts the boundary inside `(site)` or repeats
// SiteHeader/SiteBanner/SiteFooter around the screen; picking which is the
// first decision the production PR owes.
//
// The footer's three nav columns are drawn as plain text rather than links, so
// the frame shows what the real footer offers (including the Company column
// the recovery set deliberately declines) without the sandbox holding a second
// copy of those destinations for them to drift from.
export const MarketingShell = ({ children }: MarketingShellProps) => (
  <div className="flex min-h-screen flex-col">
    <header className="sticky top-0 z-40 h-[72px] w-full border-border/60 border-b bg-background">
      <div className="relative mx-auto flex h-full w-full max-w-[1300px] items-center justify-between px-6 md:px-10">
        <Link
          aria-label="Closedloop.ai home"
          className="flex h-[1.6rem] shrink-0 items-center"
          href="/"
        >
          <BrandWordmark priority />
        </Link>

        <nav
          aria-label="Primary"
          className="absolute left-1/2 hidden -translate-x-1/2 lg:block"
        >
          <ul className="flex items-center gap-8">
            {headerNavLinks.map((link) => (
              <li key={link.href}>
                {link.hardNavigate ? (
                  <a className={navLinkClassName} href={link.href}>
                    {link.label}
                  </a>
                ) : (
                  <Link className={navLinkClassName} href={link.href}>
                    {link.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <a
            aria-label="Closedloop on GitHub"
            className="hidden items-center justify-center rounded-md p-2 text-foreground/70 transition-colors hover:bg-muted hover:text-foreground lg:flex"
            href={githubRepoUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            <GitHubMark className="size-5" />
          </a>
          <MobileNav />
        </div>
      </div>
    </header>

    <SiteBanner />

    <main className="flex-1">{children}</main>

    <footer className="border-border/60 border-t">
      <div className="mx-auto w-full max-w-[1300px] px-6 py-16 md:px-10">
        <div className="grid gap-12 lg:grid-cols-[1.5fr_3fr]">
          <div className="flex flex-col gap-4">
            <Link
              aria-label="Closedloop.ai home"
              className="inline-flex h-8"
              href="/"
            >
              <BrandWordmark />
            </Link>
            <p className="max-w-xs text-muted-foreground text-sm">
              From intent to implementation, faster. Team-based agentic
              development for production software.
            </p>
            <a
              aria-label="Closedloop on GitHub"
              className="inline-flex w-fit items-center gap-2 rounded-md text-muted-foreground text-sm transition-colors hover:text-primary"
              href={githubRepoUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <GitHubMark className="size-4" />
              github.com/closedloop-ai
            </a>
          </div>
          <div className="grid gap-8 sm:grid-cols-3">
            {footerColumns.map((column) => (
              <div className="flex flex-col gap-3" key={column.title}>
                <h3 className="font-semibold text-foreground text-sm">
                  {column.title}
                </h3>
                <ul className="flex flex-col gap-2">
                  {column.labels.map((label) => (
                    <li className="text-muted-foreground text-sm" key={label}>
                      {label}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <p className="mt-12 border-border/60 border-t pt-6 text-muted-foreground text-xs">
          © {new Date().getFullYear()} Closedloop.ai. All rights reserved.
        </p>
      </div>
    </footer>
  </div>
);

const navLinkClassName =
  "font-medium text-foreground/80 text-lg transition-colors hover:text-primary";

// The wordmark ships as a paired light/dark asset rather than the inline SVG
// `apps/web` carries, so the sandbox does not hold a second copy of a 1324-unit
// path set that would drift from the real one. `priority` is opt-in: each
// render emits BOTH assets (one is display:none per theme), so preloading every
// instance would put four high-priority requests in front of the h1 this screen
// exists to surface. Only the header instance is above the fold.
const BrandWordmark = ({
  priority = false,
}: {
  readonly priority?: boolean;
}) => (
  <>
    <Image
      alt="Closedloop.ai"
      className="h-full w-auto dark:hidden"
      height={200}
      priority={priority}
      src="/web-master/closedloop-logo-on-light.svg"
      unoptimized
      width={1324}
    />
    <Image
      alt="Closedloop.ai"
      className="hidden h-full w-auto dark:block"
      height={200}
      priority={priority}
      src="/web-master/closedloop-logo-on-dark.svg"
      unoptimized
      width={1324}
    />
  </>
);
