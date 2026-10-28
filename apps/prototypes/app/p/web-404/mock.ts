export type SiteLink = {
  readonly label: string;
  readonly href: string;
  // `/docs` is a Fumadocs route whose Tailwind reset cascades over the
  // marketing header once client-side routing pulls it into the same document,
  // so the real site reaches it with a plain anchor. Carried here so the
  // production build inherits the constraint instead of rediscovering it
  // (apps/web/app/[locale]/components/site-header.tsx).
  readonly hardNavigate?: boolean;
};

// Producer: the route files under `apps/web/app/[locale]/(site)/`, plus the
// Fumadocs `/docs` section. Paths are written unprefixed; in production
// `localize(locale, href)` (apps/web/lib/site.tsx) adds the locale segment.
export const docsLink: SiteLink = {
  label: "Read the docs",
  href: "/docs",
  hardNavigate: true,
};

export const homeLink: SiteLink = { label: "Go to the homepage", href: "/" };

// The two page-level actions, in order. Both render through the same
// hardNavigate branch as every other link on the screen.
export const primaryActions: readonly SiteLink[] = [homeLink, docsLink];

export const headerNavLinks: readonly SiteLink[] = [
  { ...docsLink, label: "Documentation" },
  { label: "Resources", href: "/resources" },
];

// The recovery set is every marketing page that RESOLVES today. Contact,
// Privacy and Terms are deliberately absent: the site footer links all three
// and none of them has a route, so they 404 themselves (FEA-1865). Offering
// them here would send a lost visitor from one 404 to another. Add them to
// this list when FEA-1865 ships those pages, not before. `footerColumns` below
// draws that Company column, so the frame shows the offer this list declines.
export const recoveryLinks: readonly SiteLink[] = [
  { label: "Pricing", href: "/pricing" },
  { label: "Resources", href: "/resources" },
  { label: "Blog", href: "/blog" },
  { label: "Community", href: "/community" },
];

// Producer: GITHUB_REPO_URL in
// apps/web/app/[locale]/(site)/components/home/constants.ts, copied because a
// prototype cannot import from apps/web. If the org moves repos, that constant
// is the one to follow.
export const githubRepoUrl = "https://github.com/closedloop-ai";

// Producer: `getFooterColumns` in
// apps/web/app/[locale]/components/site-footer.tsx. Labels only, no hrefs: the
// stand-in draws these as plain text so a reviewer can see the Company column
// the recovery set above is reacting to, without the sandbox holding a second
// copy of the real footer's destinations for those destinations to drift from.
export const footerColumns: readonly {
  readonly title: string;
  readonly labels: readonly string[];
}[] = [
  { title: "Product", labels: ["Pricing", "Resources", "Documentation"] },
  { title: "Community", labels: ["GitHub"] },
  { title: "Company", labels: ["Contact", "Privacy", "Terms"] },
];
