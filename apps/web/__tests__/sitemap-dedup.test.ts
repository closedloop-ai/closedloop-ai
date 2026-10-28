import { afterEach, expect, test, vi } from "vitest";

/**
 * `app/sitemap.ts` keys its entries by URL in a `Map` rather than pushing to an
 * array. With the blog as it stands today no two entries collide — 5 static
 * routes x 6 locales + 2 distinct slugs is 42 distinct URLs — so a test over the
 * REAL `blogPosts` cannot tell the `Map` from a plain `push`, and would pass
 * while pinning nothing. This file supplies the colliding input that makes the
 * `Map` load-bearing: two posts sharing a slug, which is the authoring mistake
 * it defends against.
 *
 * It lives in its own file because the mock has to be in place before
 * `app/sitemap.ts` is imported, and the sibling `sitemap.test.ts` asserts
 * against the real post list.
 */

const DUPLICATED_SLUG = "same-slug-twice";

vi.mock("@/lib/blog", () => ({
  blogPosts: [
    {
      slug: DUPLICATED_SLUG,
      title: "First",
      description: "",
      publishedAt: "2026-01-01",
      readingTime: "1 min read",
      body: [],
    },
    {
      slug: DUPLICATED_SLUG,
      title: "Second — same slug, later date",
      description: "",
      publishedAt: "2026-02-02",
      readingTime: "1 min read",
      body: [],
    },
  ],
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

test("emits one entry when two posts resolve to the same URL", async () => {
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "closedloop.ai");
  const { default: sitemap } = await import("@/app/sitemap");
  const { locales } = await import("@/lib/site");

  const entries = sitemap();
  const blogEntries = entries.filter((entry) =>
    new URL(entry.url).pathname.endsWith(`/blog/${DUPLICATED_SLUG}`)
  );

  // One per locale, not two: a plain `entries.push(...)` emits both and doubles
  // this count, which is the mutation this file exists to kill.
  expect(blogEntries).toHaveLength(locales.length);
  // Last write wins, so the surviving entry carries the SECOND post's date —
  // asserting the count alone would survive a `Map` that kept the first.
  expect(blogEntries[0].lastModified).toEqual(new Date("2026-02-02"));
});
