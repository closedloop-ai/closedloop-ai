import { describe, expect, it } from "vitest";
import { isAllowedDesktopLoopbackRedirectUri } from "./desktop-loopback-redirect";

describe("isAllowedDesktopLoopbackRedirectUri", () => {
  it("accepts IP-literal loopback over http on any port", () => {
    expect(
      isAllowedDesktopLoopbackRedirectUri("http://127.0.0.1:49152/cb")
    ).toBe(true);
    expect(isAllowedDesktopLoopbackRedirectUri("http://[::1]:8080/cb")).toBe(
      true
    );
    // No explicit port (defaults to loopback) is still loopback.
    expect(isAllowedDesktopLoopbackRedirectUri("http://127.0.0.1/cb")).toBe(
      true
    );
  });

  it("rejects localhost (repointable via DNS/hosts, per RFC 8252 §7.3)", () => {
    expect(
      isAllowedDesktopLoopbackRedirectUri("http://localhost:3000/cb")
    ).toBe(false);
  });

  it("rejects non-loopback hosts, including look-alikes", () => {
    expect(isAllowedDesktopLoopbackRedirectUri("http://evil.com/cb")).toBe(
      false
    );
    expect(
      isAllowedDesktopLoopbackRedirectUri("http://127.0.0.1.evil.com/cb")
    ).toBe(false);
    // A public host that merely embeds the loopback IP as a label is not loopback.
    expect(
      isAllowedDesktopLoopbackRedirectUri("http://127.0.0.1x.example.com/cb")
    ).toBe(false);
  });

  it("rejects https and non-http schemes to loopback", () => {
    // Loopback is http-only; https/file/custom schemes are never valid here.
    expect(
      isAllowedDesktopLoopbackRedirectUri("https://127.0.0.1:8080/cb")
    ).toBe(false);
    expect(
      isAllowedDesktopLoopbackRedirectUri("closedloop://127.0.0.1/cb")
    ).toBe(false);
    expect(isAllowedDesktopLoopbackRedirectUri("file:///etc/passwd")).toBe(
      false
    );
  });

  it("rejects embedded credentials", () => {
    expect(
      isAllowedDesktopLoopbackRedirectUri("http://user:pass@127.0.0.1:8080/cb")
    ).toBe(false);
    expect(
      isAllowedDesktopLoopbackRedirectUri("http://user@127.0.0.1:8080/cb")
    ).toBe(false);
  });

  it("rejects unparseable input", () => {
    expect(isAllowedDesktopLoopbackRedirectUri("not a url")).toBe(false);
    expect(isAllowedDesktopLoopbackRedirectUri("")).toBe(false);
  });
});
