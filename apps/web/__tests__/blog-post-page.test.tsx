import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import BlogPostPage, {
  generateMetadata,
} from "@/app/[locale]/(site)/blog/[slug]/page";
import { blogPosts } from "@/lib/blog";
import { NOT_FOUND_DIGEST } from "./support/next-navigation";

const KNOWN_SLUG = blogPosts[0].slug;
const MISSING_SLUG = "no-such-post";

const HTML_TEXT_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
};
const HTML_TEXT_ESCAPABLE = /["&'<>]/g;

describe("generateMetadata", () => {
  test("titles the page after the post it found", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en", slug: KNOWN_SLUG }),
    });

    expect(metadata.title).toContain(blogPosts[0].title);
    expect(metadata.description).toBe(blogPosts[0].description);
  });

  test("falls back to generic blog metadata for an unknown slug", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ locale: "en", slug: MISSING_SLUG }),
    });

    expect(metadata.title).toContain("Blog");
    expect(metadata.description).toBe("Closedloop.ai blog");
  });

  test("claims no og:url either way", async () => {
    // Both arms pass `null`: `proxy.ts` 302s the raw `/blog/` prefix off-site,
    // so an unprefixed `og:url` would point at a redirect. A URL appearing here
    // means someone made this page advertise one that does not serve.
    const found = await generateMetadata({
      params: Promise.resolve({ locale: "en", slug: KNOWN_SLUG }),
    });
    const missing = await generateMetadata({
      params: Promise.resolve({ locale: "en", slug: MISSING_SLUG }),
    });

    expect(found.openGraph?.url).toBeUndefined();
    expect(missing.openGraph?.url).toBeUndefined();
  });
});

describe("BlogPostPage", () => {
  test("renders the post body when the slug resolves", async () => {
    const html = renderToStaticMarkup(
      await BlogPostPage({
        params: Promise.resolve({ locale: "en", slug: KNOWN_SLUG }),
      })
    );

    // Escaped, not raw: React escapes `& < > " '` in text children, so a copy
    // edit adding an apostrophe to a post would redden this on markup the
    // component rendered correctly. `apps/web` copy belongs to marketing in
    // CODEOWNERS, so that edit is a routine one this test must survive.
    expect(html).toContain(asMarkupText(blogPosts[0].title));
    expect(html).toContain(asMarkupText(blogPosts[0].publishedAt));
    for (const paragraph of blogPosts[0].body) {
      expect(html).toContain(asMarkupText(paragraph));
    }
  });

  test("404s rather than rendering an empty article for an unknown slug", async () => {
    // The digest, not merely "it threw": dropping the guard also throws here,
    // as a TypeError off the undefined post one line later. Matching the digest
    // is what separates a deliberate 404 from a crash.
    await expect(
      BlogPostPage({
        params: Promise.resolve({ locale: "en", slug: MISSING_SLUG }),
      })
    ).rejects.toMatchObject({ digest: NOT_FOUND_DIGEST });
  });
});

/** A copy string as `renderToStaticMarkup` writes it into a text child. */
function asMarkupText(copy: string): string {
  return copy.replace(HTML_TEXT_ESCAPABLE, (char) => HTML_TEXT_ESCAPES[char]);
}
