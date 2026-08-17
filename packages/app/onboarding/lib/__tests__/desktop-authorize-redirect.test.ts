import { describe, expect, it } from "vitest";
import {
  buildLoopbackCancelUrl,
  buildLoopbackRedirectUrl,
  DESKTOP_AUTHORIZE_ACCESS_DENIED,
} from "../desktop-authorize-redirect";

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

describe("buildLoopbackCancelUrl", () => {
  it("hands the loopback an access_denied error and the round-tripped state", () => {
    const url = new URL(
      buildLoopbackCancelUrl("http://127.0.0.1:52100/cb", "state-1")
    );
    expect(url.searchParams.get("error")).toBe(DESKTOP_AUTHORIZE_ACCESS_DENIED);
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("carries no code, which is what makes an older desktop build settle", () => {
    // A desktop that predates the `error` param fails its own code-present
    // check and ends the run as a state mismatch. Wrong wording, but it
    // RESOLVES — where before it waited out the full sign-in timeout.
    const url = new URL(
      buildLoopbackCancelUrl("http://127.0.0.1:52100/cb", "state-1")
    );
    expect(url.searchParams.get("code")).toBeNull();
  });

  it("preserves an existing path and port on the loopback redirect", () => {
    const url = new URL(
      buildLoopbackCancelUrl("http://127.0.0.1:52100/cb", "state-1")
    );
    expect(url.host).toBe("127.0.0.1:52100");
    expect(url.pathname).toBe("/cb");
  });
});
