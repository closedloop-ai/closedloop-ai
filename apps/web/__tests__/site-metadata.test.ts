import { describe, expect, test } from "vitest";
import { createPageMetadata, locales, localize } from "@/lib/site";

describe("localize", () => {
  test("maps the site root to the bare locale prefix", () => {
    // `/${locale}/` — with a trailing slash — is a different URL to Next and to
    // a crawler, so the root is special-cased rather than concatenated.
    expect(localize("de", "/")).toBe("/de");
  });

  test("prefixes any other route with the locale", () => {
    expect(localize("de", "/pricing")).toBe("/de/pricing");
  });
});

describe("createPageMetadata", () => {
  test("advertises an og:url when given a path", () => {
    const metadata = createPageMetadata("Docs", "The docs", "/docs");

    expect(metadata.openGraph?.url).toBe("/docs");
  });

  test("emits no og:url at all when the path is null", () => {
    const metadata = createPageMetadata("Docs", "The docs", null);

    // Absent, not empty: `path` is nullable precisely so a render with no URL
    // identity (a 404, or a route that redirects off-site) emits no `og:url`
    // rather than one pointing nowhere.
    //
    // No test can prove the CONDITIONAL spread is what does this. `createMetadata`
    // reads `path` in exactly one place — `if (path && metadata.openGraph)` — so
    // passing `{ path: null }` and passing nothing produce byte-identical
    // metadata, and `...(path === null ? {} : { path })` collapsed to `...{ path }`
    // is an equivalent mutation today. It stops being equivalent the moment
    // @repo/seo reads `path` anywhere that distinguishes null from absent, which
    // is why the spread stays.
    expect(metadata.openGraph?.url).toBeUndefined();
  });

  test("attaches the shared OpenGraph card to every page", () => {
    const withPath = createPageMetadata("Docs", "The docs", "/docs");
    const withoutPath = createPageMetadata("Docs", "The docs", null);

    expect(JSON.stringify(withPath.openGraph)).toContain(
      "/opengraph-image.png"
    );
    expect(JSON.stringify(withoutPath.openGraph)).toContain(
      "/opengraph-image.png"
    );
  });
});

describe("locales", () => {
  test("lists the six locales the app routes", () => {
    expect([...locales]).toEqual(["en", "de", "es", "fr", "pt", "zh"]);
  });
});
