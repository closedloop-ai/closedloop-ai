import { afterEach, expect, test, vi } from "vitest";
import sitemap from "@/app/sitemap";
import { blogPosts } from "@/lib/blog";
import { locales } from "@/lib/site";

const STATIC_ROUTE_COUNT = 5;
const HOST = "closedloop.ai";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("lists nothing at all when no production host is set", () => {
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");

  // Every entry is an absolute URL, so with no base there is nothing to list —
  // an entry with a relative or guessed host is worse than no sitemap.
  expect(sitemap()).toEqual([]);
});

test("expands every static route and every blog post across all locales", () => {
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", HOST);

  const entries = sitemap();

  expect(entries).toHaveLength(
    locales.length * (STATIC_ROUTE_COUNT + blogPosts.length)
  );
  for (const locale of locales.filter((value) => value !== "en")) {
    const prefixed = entries.filter((entry) =>
      new URL(entry.url).pathname.startsWith(`/${locale}`)
    );
    expect(prefixed).toHaveLength(STATIC_ROUTE_COUNT + blogPosts.length);
  }
  const unprefixed = entries.filter(
    (entry) =>
      !locales.some((locale) =>
        new URL(entry.url).pathname.startsWith(`/${locale}`)
      )
  );
  expect(unprefixed).toHaveLength(STATIC_ROUTE_COUNT + blogPosts.length);
  expect(
    entries.some((entry) => new URL(entry.url).pathname.startsWith("/en"))
  ).toBe(false);
});

test("dates a blog entry from its publishedAt, not the run clock", () => {
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", HOST);
  const post = blogPosts[0];

  const entry = sitemap().find(
    (candidate) => new URL(candidate.url).pathname === `/blog/${post.slug}`
  );

  expect(entry?.lastModified).toEqual(new Date(post.publishedAt));
});
