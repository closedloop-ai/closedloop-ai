import { describe, expect, it } from "vitest";
import { browserActivityFromUserAgent } from "../local-trusted-browser-activity";

// Real user-agent strings, written as literals: the header is not ours.
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Safari/537.36";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";

describe("browserActivityFromUserAgent", () => {
  it("reads Chrome on a Mac", () => {
    expect(browserActivityFromUserAgent(CHROME_MAC)).toEqual({
      browserName: "Chrome",
      browserVersion: "141.0.7390.54",
      deviceType: "Macintosh",
      isMobile: false,
    });
  });

  it("names Edge rather than the Chrome token it also carries", () => {
    expect(browserActivityFromUserAgent(EDGE_WINDOWS)).toMatchObject({
      browserName: "Edge",
      browserVersion: "141.0.3537.57",
      deviceType: "Windows NT 10.0",
    });
  });

  it("reads mobile Safari and Firefox", () => {
    expect(browserActivityFromUserAgent(SAFARI_IPHONE)).toEqual({
      browserName: "Safari",
      browserVersion: "18.6",
      deviceType: "iPhone",
      isMobile: true,
    });
    expect(browserActivityFromUserAgent(FIREFOX_LINUX)).toMatchObject({
      browserName: "Firefox",
      deviceType: "X11",
    });
  });

  it("omits what an unrecognized header does not carry", () => {
    expect(browserActivityFromUserAgent("curl/8.7.1")).toEqual({
      isMobile: false,
    });
  });

  it("is null without a header", () => {
    expect(browserActivityFromUserAgent(undefined)).toBeNull();
    expect(browserActivityFromUserAgent("   ")).toBeNull();
  });
});
