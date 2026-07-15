import { describe, expect, it } from "vitest";
import { buildLoopbackRedirectUrl } from "../desktop-authorize-redirect";

describe("buildLoopbackRedirectUrl", () => {
  it("appends code and state to the loopback redirect", () => {
    const url = new URL(
      buildLoopbackRedirectUrl(
        "http://127.0.0.1:49152/cb",
        "the-code",
        "the-state"
      )
    );

    expect(url.origin).toBe("http://127.0.0.1:49152");
    expect(url.pathname).toBe("/cb");
    expect(url.searchParams.get("code")).toBe("the-code");
    expect(url.searchParams.get("state")).toBe("the-state");
  });

  it("preserves an existing query string on the redirect_uri", () => {
    const url = new URL(
      buildLoopbackRedirectUrl("http://127.0.0.1:49152/cb?foo=bar", "c", "s")
    );

    expect(url.searchParams.get("foo")).toBe("bar");
    expect(url.searchParams.get("code")).toBe("c");
    expect(url.searchParams.get("state")).toBe("s");
  });

  it("url-encodes code and state", () => {
    const url = buildLoopbackRedirectUrl(
      "http://127.0.0.1:49152/cb",
      "a b/c",
      "x&y"
    );

    expect(url).toContain("code=a+b%2Fc");
    expect(url).toContain("state=x%26y");
  });
});
