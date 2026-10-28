import { describe, expect, it } from "vitest";
import {
  DD_SOURCEMAP_UPLOAD_FLAG,
  shouldEmitBrowserSourceMaps,
} from "@/lib/datadog-rum/source-maps";

describe("shouldEmitBrowserSourceMaps", () => {
  it("emits maps when the upload flag is on", () => {
    expect(shouldEmitBrowserSourceMaps({ DD_SOURCEMAP_UPLOAD: "true" })).toBe(
      true
    );
  });

  it("stays off when the flag is absent", () => {
    expect(shouldEmitBrowserSourceMaps({})).toBe(false);
  });

  it("stays off for any value other than the exact string true", () => {
    // A build that emits maps it cannot upload leaves .map files in the
    // publicly served .next/static, so this predicate is deliberately strict
    // rather than truthy.
    for (const value of ["1", "yes", "TRUE", "on", "", "false"]) {
      expect(shouldEmitBrowserSourceMaps({ DD_SOURCEMAP_UPLOAD: value })).toBe(
        false
      );
    }
  });

  it("refuses to emit on a Vercel build even when the flag is on", () => {
    // ISS-8925. Vercel copies `.next/static` into what it serves before any
    // post-build step can run, so a map emitted here is published before the
    // strip that was meant to remove it — and what it publishes is served
    // `immutable` for a year and survived every purge lever tried. The emit
    // therefore does not happen at all where the platform decides what ships.
    expect(
      shouldEmitBrowserSourceMaps({
        DD_SOURCEMAP_UPLOAD: "true",
        VERCEL: "1",
      })
    ).toBe(false);
  });

  it("names the same env var the uploader gates on", () => {
    // The emit and the upload MUST read one switch. If these drift, a build
    // either produces maps nobody ships or runs an upload with nothing to send.
    expect(DD_SOURCEMAP_UPLOAD_FLAG).toBe("DD_SOURCEMAP_UPLOAD");
  });
});
