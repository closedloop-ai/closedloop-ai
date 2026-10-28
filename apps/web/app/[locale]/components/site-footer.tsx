import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { GITHUB_REPO_URL } from "@/app/[locale]/(site)/components/home/constants";
import { ClosedloopLogo } from "@/app/[locale]/components/closedloop-logo";
import { GitHubLogo } from "@/components/github-logo";
import { localize } from "@/lib/site";

type SiteFooterProps = {
  locale: string;
};

export const SiteFooter = ({ locale }: SiteFooterProps) => {
  const year = new Date().getFullYear();

  return (
    <footer className="border-border/60 border-t">
      <div className="mx-auto w-full max-w-[1300px] px-6 py-16 md:px-10">
        <div className="grid gap-12 lg:grid-cols-[1.5fr_3fr]">
          <div className="flex flex-col gap-4">
            <Link
              aria-label="Closedloop.ai home"
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
              aria-label="Closedloop on GitHub"
              className="inline-flex w-fit items-center gap-2 rounded-md text-muted-foreground text-sm transition-colors hover:text-primary"
              href={GITHUB_REPO_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              <GitHubLogo className="size-4" />
              github.com/closedloop-ai
            </Link>
          </div>
          <div className="grid gap-8 sm:grid-cols-3">
            <FooterColumn title="Product">
              <FooterLink href={localize(locale, "/pricing")}>
                Pricing
              </FooterLink>
              <FooterLink href={localize(locale, "/resources")}>
                Resources
              </FooterLink>
              <FooterLink external href="https://marketing.closedloop.ai/docs">
                Documentation
              </FooterLink>
            </FooterColumn>
            <FooterColumn title="Community">
              <FooterLink external href={GITHUB_REPO_URL}>
                GitHub
              </FooterLink>
            </FooterColumn>
            <FooterColumn title="Company">
              <FooterLink href={localize(locale, "/contact")}>
                Contact
              </FooterLink>
              <FooterLink href={localize(locale, "/legal/privacy")}>
                Privacy Policy
              </FooterLink>
              <FooterLink href={localize(locale, "/legal/terms")}>
                Terms of Service
              </FooterLink>
            </FooterColumn>
          </div>
        </div>
        <div className="mt-12 border-border/60 border-t pt-6 text-muted-foreground text-xs">
          © {year} Closedloop.ai. All rights reserved.
        </div>
      </div>
    </footer>
  );
};

function FooterColumn({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="font-semibold text-foreground text-sm">{title}</h3>
      <ul className="flex flex-col gap-2">{children}</ul>
    </div>
  );
}

// Links are written out rather than mapped from a list so the build can stamp
// each label as product copy for click analytics (ISS-12557); every prop,
// including those provenance attributes, forwards to the anchor.
function FooterLink({
  external,
  ...props
}: ComponentProps<typeof Link> & { external?: boolean }) {
  return (
    <li>
      <Link
        className="text-muted-foreground text-sm transition-colors hover:text-primary"
        rel={external ? "noopener noreferrer" : undefined}
        target={external ? "_blank" : undefined}
        {...props}
      />
    </li>
  );
}
