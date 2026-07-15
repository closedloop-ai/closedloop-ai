import { describe, expect, it } from "vitest";
import { sanitizeLinkUrl } from "./sanitize-link-url";

describe("sanitizeLinkUrl", () => {
  it("allows http and https URLs", () => {
    expect(sanitizeLinkUrl("http://example.com")).toBe("http://example.com");
    expect(sanitizeLinkUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1"
    );
  });

  it("allows mailto URLs", () => {
    expect(sanitizeLinkUrl("mailto:foo@bar.com")).toBe("mailto:foo@bar.com");
  });

  it("allows bare fragment links", () => {
    expect(sanitizeLinkUrl("#section")).toBe("#section");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizeLinkUrl("  https://example.com  ")).toBe(
      "https://example.com"
    );
  });

  it("rejects javascript: URLs", () => {
    expect(sanitizeLinkUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects javascript: URLs disguised with embedded newlines", () => {
    expect(sanitizeLinkUrl("java\nscript:alert(1)")).toBeNull();
  });

  it("rejects data: and vbscript: URLs", () => {
    expect(
      sanitizeLinkUrl("data:text/html,<script>alert(1)</script>")
    ).toBeNull();
    expect(sanitizeLinkUrl("vbscript:msgbox(1)")).toBeNull();
  });

  it("rejects empty or whitespace-only input", () => {
    expect(sanitizeLinkUrl("")).toBeNull();
    expect(sanitizeLinkUrl("   ")).toBeNull();
  });

  it("accepts scheme-less relative URLs as typed (no XSS surface, preserves prior behavior)", () => {
    expect(sanitizeLinkUrl("example.com")).toBe("example.com");
    expect(sanitizeLinkUrl("www.example.com/path")).toBe(
      "www.example.com/path"
    );
    expect(sanitizeLinkUrl("/docs/page")).toBe("/docs/page");
    expect(sanitizeLinkUrl("../other")).toBe("../other");
  });
});
