import type { ReactElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The fumadocs source is built from MDX on disk at import time, so a real one
 * cannot be steered into the "page missing" or "description absent" states this
 * file is about. The stub is a page lookup and nothing else.
 */
const mocks = vi.hoisted(() => ({
  pages: new Map<string, unknown>(),
}));

vi.mock("@/lib/docs", () => ({
  getDocsSource: (locale: string) => ({
    getPage: (slug?: string[]) =>
      mocks.pages.get(`${locale}:${(slug ?? []).join("/")}`),
    generateParams: () => [{ slug: ["intro"] }],
    getPageTree: () => ({ name: "root", children: [] }),
  }),
}));

vi.mock("@/components/api-page", () => ({ APIPage: () => null }));

import { NOT_FOUND_DIGEST } from "./support/next-navigation";

const TOC = [{ title: "Overview", url: "#overview", depth: 2 }];

const page = (overrides: Record<string, unknown> = {}) => ({
  url: "/en/docs/guide",
  data: {
    title: "Guide",
    description: "How to use it",
    toc: TOC,
    body: () => null,
    ...overrides,
  },
});

beforeEach(() => {
  mocks.pages.clear();
});

describe("generateMetadata", () => {
  test("titles the page after the doc and points og:url at its slug", async () => {
    mocks.pages.set("en:guide/intro", page());
    const { generateMetadata } = await import(
      "@/app/[locale]/docs/[[...slug]]/page"
    );

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en", slug: ["guide", "intro"] }),
    });

    expect(metadata.title).toContain("Guide");
    expect(metadata.description).toBe("How to use it");
    // Built from the slug, not `page.url`: non-default sources retain their
    // locale prefix, while metadata consolidates every locale onto `/docs`.
    expect(metadata.openGraph?.url).toBe("/docs/guide/intro");
  });

  test("points the docs root at /docs when there is no slug", async () => {
    mocks.pages.set("en:", page());
    const { generateMetadata } = await import(
      "@/app/[locale]/docs/[[...slug]]/page"
    );

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en" }),
    });

    expect(metadata.openGraph?.url).toBe("/docs");
  });

  test("treats an empty slug array as the docs root, not an empty path", async () => {
    mocks.pages.set("en:", page());
    const { generateMetadata } = await import(
      "@/app/[locale]/docs/[[...slug]]/page"
    );

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en", slug: [] }),
    });

    // `slug?.length` rather than `slug` — an empty array is truthy, so testing
    // the array itself would emit `/docs/` with a trailing slash.
    expect(metadata.openGraph?.url).toBe("/docs");
  });

  test("falls back to generic copy when the doc carries no description", async () => {
    mocks.pages.set("en:guide", page({ description: undefined }));
    const { generateMetadata } = await import(
      "@/app/[locale]/docs/[[...slug]]/page"
    );

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en", slug: ["guide"] }),
    });

    expect(metadata.description).toBe("Closedloop.ai documentation");
  });

  test("returns generic metadata with no og:url for a missing doc", async () => {
    const { generateMetadata } = await import(
      "@/app/[locale]/docs/[[...slug]]/page"
    );

    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en", slug: ["nope"] }),
    });

    expect(metadata.title).toContain("Documentation");
    // This render 404s, so it has no URL identity to advertise.
    expect(metadata.openGraph?.url).toBeUndefined();
  });
});

describe("DynamicDocsPage", () => {
  test("hands the doc's table of contents to the page shell", async () => {
    mocks.pages.set("en:guide", page());
    const { default: DynamicDocsPage } = await import(
      "@/app/[locale]/docs/[[...slug]]/page"
    );

    const element = (await DynamicDocsPage({
      params: Promise.resolve({ locale: "en", slug: ["guide"] }),
    })) as ReactElement<{ toc: unknown }>;

    expect(element.props.toc).toBe(TOC);
  });

  test("404s instead of rendering a shell for a missing doc", async () => {
    const { default: DynamicDocsPage } = await import(
      "@/app/[locale]/docs/[[...slug]]/page"
    );

    // The digest, not merely "it threw": dropping the guard also throws here,
    // as a TypeError off the undefined page one line later. Matching the digest
    // is what separates a deliberate 404 from a crash.
    await expect(
      DynamicDocsPage({
        params: Promise.resolve({ locale: "en", slug: ["nope"] }),
      })
    ).rejects.toMatchObject({ digest: NOT_FOUND_DIGEST });
  });
});
