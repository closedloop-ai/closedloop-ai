import { describe, expect, it } from "vitest";
import { isLoopbackUrl } from "../loopback-url";

describe("isLoopbackUrl", () => {
  it.each([
    "http://localhost:6060",
    "https://localhost:6060",
    "http://127.0.0.1:6060",
    "http://[::1]:6060",
  ])("accepts %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    // A loopback name as a prefix of another host.
    "http://localhost.evil.example",
    // Loopback in the userinfo, another host after the @.
    "http://127.0.0.1@evil.example",
    "not a url",
    "127.0.0.2",
    // Only the literal 127.0.0.1 counts, not all of 127/8: fails closed.
    "http://127.0.0.2:6060",
    // fetch rejects these before sending.
    "ftp://localhost:6060",
    "http://user:pass@localhost:6060",
    "http://user@localhost:6060",
  ])("refuses %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });
});
