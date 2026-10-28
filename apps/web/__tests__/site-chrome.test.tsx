import type { AnchorHTMLAttributes, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

/**
 * `next/link` and a raw `<a>` both render as an anchor, so static markup cannot
 * tell the two nav branches apart on its own. Tagging the Link with a data
 * attribute is what makes `if (link.hardNavigate)` observable: the hard-navigate
 * arm must NOT carry it, which is the whole point of that branch (it exists so
 * /docs is a real navigation and fumadocs' CSS reset never enters the marketing
 * DOM via client-side routing).
 */
vi.mock("next/link", () => ({
  default: ({
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} data-next-link="true">
      {children}
    </a>
  ),
}));

/**
 * Radix renders `SheetContent` only while the sheet is open, and `MobileNav`
 * owns that state internally with no way in from a static render. These stubs
 * drop the open/close machinery — which belongs to the design system, not here
 * — so the nav-link branches this file is about actually execute.
 */
vi.mock("@repo/design-system/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

const DOCS_HREF = "/docs";
const RESOURCES_HREF = "/resources";
const GITHUB_HREF = "https://github.test/closedloop-ai";
const NEXT_LINK_MARKER = 'data-next-link="true"';

describe("SiteHeader", () => {
  test("hard-navigates to /docs and client-routes everything else", async () => {
    const { SiteHeader } = await import(
      "@/app/[locale]/components/site-header"
    );

    const html = renderToStaticMarkup(<SiteHeader locale="en" />);
    const docs = anchorFor(html, DOCS_HREF);
    const resources = anchorFor(html, RESOURCES_HREF);

    expect(docs).not.toContain(NEXT_LINK_MARKER);
    expect(resources).toContain(NEXT_LINK_MARKER);
  });

  test("leaves rel and target off nav links, none of which are external", async () => {
    const { SiteHeader } = await import(
      "@/app/[locale]/components/site-header"
    );

    const html = renderToStaticMarkup(<SiteHeader locale="en" />);

    expect(anchorFor(html, DOCS_HREF)).not.toContain("rel=");
    expect(anchorFor(html, DOCS_HREF)).not.toContain("target=");
    expect(anchorFor(html, RESOURCES_HREF)).not.toContain("rel=");
    expect(anchorFor(html, RESOURCES_HREF)).not.toContain("target=");
  });

  test("localizes every nav href to the locale it is given", async () => {
    const { SiteHeader } = await import(
      "@/app/[locale]/components/site-header"
    );

    const html = renderToStaticMarkup(<SiteHeader locale="de" />);

    expect(html).toContain('href="/de/docs"');
    expect(html).toContain('href="/de/resources"');
  });
});

describe("MobileNav", () => {
  test("opens only GitHub in a new tab and keeps nav links in place", async () => {
    const { MobileNav } = await import(
      "@/app/[locale]/components/site-header-mobile"
    );

    const html = renderToStaticMarkup(
      <MobileNav
        docsHref={DOCS_HREF}
        githubUrl={GITHUB_HREF}
        resourcesHref={RESOURCES_HREF}
      />
    );

    const github = anchorFor(html, GITHUB_HREF);
    expect(github).toContain('rel="noopener noreferrer"');
    expect(github).toContain('target="_blank"');

    // An internal link must not be handed `target="_blank"`, which would drop
    // the user out of the site.
    for (const href of [DOCS_HREF, RESOURCES_HREF]) {
      expect(anchorFor(html, href)).not.toContain("rel=");
      expect(anchorFor(html, href)).not.toContain("target=");
    }
  });

  test("hard-navigates to /docs and client-routes resources", async () => {
    const { MobileNav } = await import(
      "@/app/[locale]/components/site-header-mobile"
    );

    const html = renderToStaticMarkup(
      <MobileNav
        docsHref={DOCS_HREF}
        githubUrl={GITHUB_HREF}
        resourcesHref={RESOURCES_HREF}
      />
    );

    expect(anchorFor(html, DOCS_HREF)).not.toContain(NEXT_LINK_MARKER);
    expect(anchorFor(html, RESOURCES_HREF)).toContain(NEXT_LINK_MARKER);
  });
});

describe("SiteFooter", () => {
  test("marks external column links as external and internal ones as not", async () => {
    const { SiteFooter } = await import(
      "@/app/[locale]/components/site-footer"
    );

    const html = renderToStaticMarkup(<SiteFooter locale="en" />);

    const externalDocs = anchorFor(
      html,
      "https://marketing.closedloop.ai/docs"
    );
    expect(externalDocs).toContain('rel="noopener noreferrer"');
    expect(externalDocs).toContain('target="_blank"');

    const pricing = anchorFor(html, "/pricing");
    expect(pricing).not.toContain("rel=");
    expect(pricing).not.toContain("target=");
  });
});

/** The opening tag of the first anchor carrying `href`, attributes included. */
function anchorFor(html: string, href: string): string {
  const marker = `href="${href}"`;
  const at = html.indexOf(marker);

  if (at === -1) {
    throw new Error(`no anchor with ${marker} in rendered markup`);
  }

  return html.slice(html.lastIndexOf("<a", at), html.indexOf(">", at) + 1);
}
