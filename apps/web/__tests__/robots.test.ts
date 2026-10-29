import { afterEach, expect, test, vi } from "vitest";
import robots from "@/app/robots";

const ALLOW_ALL = { userAgent: "*", allow: "/" };
const ABSOLUTE_SITEMAP_URL = /^https?:\/\/closedloop\.ai\/sitemap\.xml$/;

afterEach(() => {
  vi.unstubAllEnvs();
});

test("names the sitemap as an absolute URL when a production host is set", () => {
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "closedloop.ai");

  const result = robots();

  expect(result.rules).toEqual(ALLOW_ALL);
  // The bare host has no scheme, so `siteUrl` supplies one — a `Sitemap:` line
  // is only useful absolute.
  expect(result.sitemap).toMatch(ABSOLUTE_SITEMAP_URL);
});

test("omits the sitemap entirely when no production host is set", () => {
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");

  const result = robots();

  expect(result.rules).toEqual(ALLOW_ALL);
  // Absent, not empty: `Sitemap:` takes an absolute URL, and with no base there
  // is none to name. A `""` here would emit a `Sitemap:` line pointing nowhere.
  expect(result.sitemap).toBeUndefined();
  expect("sitemap" in result).toBe(false);
});
