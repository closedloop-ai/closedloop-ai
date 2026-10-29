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

describe("buildLoopbackRedirectUrl account_created marker (ISS-10913)", () => {
  it("stamps the marker when this auth return created an account", () => {
    const url = new URL(
      buildLoopbackRedirectUrl("http://127.0.0.1:49152/cb", "c", "s", true)
    );

    expect(url.searchParams.get("account_created")).toBe("1");
  });

  it("omits the param when no creation was observed", () => {
    // An absent optional field stays absent on the wire — a `0` would be a
    // claim the page cannot make, and omission is also what an installed
    // desktop build that predates the param already reads.
    const url = new URL(
      buildLoopbackRedirectUrl("http://127.0.0.1:49152/cb", "c", "s", false)
    );

    expect(url.searchParams.has("account_created")).toBe(false);
  });

  it("omits the param for a caller that passes no marker at all", () => {
    const url = new URL(
      buildLoopbackRedirectUrl("http://127.0.0.1:49152/cb", "c", "s")
    );

    expect(url.searchParams.has("account_created")).toBe(false);
  });
});

describe("buildLoopbackRedirectUrl desktop bootstrap marker", () => {
  it("adds the marker only for the separate bootstrap return", () => {
    const bootstrap = new URL(
      buildLoopbackRedirectUrl(
        "http://127.0.0.1:49152/cb",
        "c",
        "s",
        true,
        true
      )
    );
    const ordinary = new URL(
      buildLoopbackRedirectUrl("http://127.0.0.1:49152/cb", "c", "s", true)
    );

    expect(bootstrap.searchParams.get("desktop_bootstrap")).toBe("1");
    expect(ordinary.searchParams.has("desktop_bootstrap")).toBe(false);
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
