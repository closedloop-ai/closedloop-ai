import { describe, expect, it } from "vitest";
import {
  AllowedLinkScheme,
  isAllowedLinkScheme,
  isAllowedLinkUri,
} from "./link-uri-policy";

// Stand-in for Tiptap's built-in validator. It accepts everything so the test
// isolates the scheme-allowlist behavior layered on top of it.
const allowAll = () => true;

describe("isAllowedLinkUri", () => {
  it("allows http(s) and mailto, case-insensitively", () => {
    for (const url of [
      "http://example.com",
      "https://example.com",
      "HTTP://example.com",
      "mailto:a@b.com",
      "MAILTO:a@b.com",
    ]) {
      expect(isAllowedLinkUri(url, allowAll)).toBe(true);
    }
  });

  it("rejects dangerous and disallowed schemes", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "ftp://example.com",
      "tel:+15551234",
    ]) {
      expect(isAllowedLinkUri(url, allowAll)).toBe(false);
    }
  });

  it("defers schemeless URLs (relative paths, fragments) to defaultValidate", () => {
    for (const url of [
      "#section",
      "/docs/intro",
      "../README.md",
      "//cdn.example.com/x",
    ]) {
      expect(isAllowedLinkUri(url, allowAll)).toBe(true);
    }
    // When the built-in validator rejects a schemeless URL, so do we.
    expect(isAllowedLinkUri("#section", () => false)).toBe(false);
  });

  it("catches disallowed schemes hidden behind leading whitespace or control chars", () => {
    for (const url of [
      " ftp://example.com",
      "\tjavascript:alert(1)",
      "\njavascript:alert(1)",
      "\rjavascript:alert(1)",
      "\fjavascript:alert(1)",
      "\vjavascript:alert(1)",
      "   tel:+15551234",
      "  \t javascript:alert(1)",
    ]) {
      expect(isAllowedLinkUri(url, allowAll)).toBe(false);
    }
  });

  it("catches disallowed schemes split by an embedded tab/newline", () => {
    for (const url of [
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "java\rscript:alert(1)",
    ]) {
      expect(isAllowedLinkUri(url, allowAll)).toBe(false);
    }
  });

  it("still allows http(s)/mailto once leading whitespace is stripped", () => {
    for (const url of [
      " https://example.com",
      "\thttp://example.com",
      "  mailto:a@b.com",
    ]) {
      expect(isAllowedLinkUri(url, allowAll)).toBe(true);
    }
  });
});

describe("AllowedLinkScheme", () => {
  it("exposes the allowlist as a const object with derived membership", () => {
    expect(Object.values(AllowedLinkScheme)).toEqual([
      "http",
      "https",
      "mailto",
    ]);
    for (const scheme of Object.values(AllowedLinkScheme)) {
      expect(isAllowedLinkScheme(scheme)).toBe(true);
    }
    for (const scheme of ["javascript", "data", "ftp", "tel", "vbscript"]) {
      expect(isAllowedLinkScheme(scheme)).toBe(false);
    }
  });
});
