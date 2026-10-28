import { describe, expect, test } from "vitest";
import { blogPosts, getBlogPost } from "@/lib/blog";

describe("getBlogPost", () => {
  test("returns the post whose slug matches", () => {
    const target = blogPosts[0];

    expect(getBlogPost(target.slug)).toBe(target);
  });

  test("returns undefined for a slug no post carries", () => {
    expect(getBlogPost("no-such-post")).toBeUndefined();
  });
});
