import { describe, expect, it } from "vitest";
import { isGithubPrUrl } from "../branch-pr-url";

describe("isGithubPrUrl", () => {
  it("accepts canonical GitHub PR URLs", () => {
    expect(isGithubPrUrl("https://github.com/acme/repo/pull/123")).toBe(true);
    expect(isGithubPrUrl("https://github.com/acme/repo/pull/1/files")).toBe(
      true
    );
  });

  it("rejects unsafe schemes", () => {
    expect(isGithubPrUrl("javascript:alert(1)")).toBe(false);
    expect(isGithubPrUrl("data:text/html,<script>")).toBe(false);
  });

  it("rejects off-domain and non-https hosts", () => {
    expect(isGithubPrUrl("http://github.com/acme/repo/pull/1")).toBe(false);
    expect(isGithubPrUrl("https://evil.com/acme/repo/pull/1")).toBe(false);
    expect(isGithubPrUrl("https://github.com.evil.com/a/b/pull/1")).toBe(false);
  });

  it("rejects non-PR GitHub paths and malformed input", () => {
    expect(isGithubPrUrl("https://github.com/acme/repo/issues/1")).toBe(false);
    expect(isGithubPrUrl("https://github.com/acme/repo/pull/abc")).toBe(false);
    expect(isGithubPrUrl("not a url")).toBe(false);
    expect(isGithubPrUrl(null)).toBe(false);
    expect(isGithubPrUrl(undefined)).toBe(false);
    expect(isGithubPrUrl("")).toBe(false);
  });
});
