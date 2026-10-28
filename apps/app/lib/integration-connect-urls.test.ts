import { describe, expect, it } from "vitest";
import {
  getGitHubConnectUrl,
  getGoogleOAuthUrl,
} from "./integration-connect-urls";

/**
 * These builders return the exact Next API-route URLs that OAuth entry points
 * navigate the browser to across settings, onboarding, and insights. A silent
 * change to the path or query params would
 * break the redirect flow for every provider, so each assertion pins the
 * fully-constructed URL — path plus every query parameter — rather than a
 * substring.
 */
describe("integration-connect-urls", () => {
  describe("getGitHubConnectUrl", () => {
    // PLN-1742 M5: authorize mode targets the Clerk linking page; the
    // in-house authorize route survives only as the install entry point.
    it("defaults to the Clerk linking page with no query string", () => {
      expect(getGitHubConnectUrl()).toBe("/connect/github/link");
    });

    it("returns the bare linking page when mode is explicitly 'authorize'", () => {
      expect(getGitHubConnectUrl("authorize")).toBe("/connect/github/link");
    });

    it("adds install=true when mode is 'install'", () => {
      expect(getGitHubConnectUrl("install")).toBe(
        "/api/integrations/github?install=true"
      );
    });

    it("adds a returnTo param in authorize mode", () => {
      expect(getGitHubConnectUrl("authorize", { returnTo: "/settings" })).toBe(
        "/connect/github/link?returnTo=%2Fsettings"
      );
    });

    it("combines install and returnTo params in install mode (install first)", () => {
      expect(getGitHubConnectUrl("install", { returnTo: "/onboarding" })).toBe(
        "/api/integrations/github?install=true&returnTo=%2Fonboarding"
      );
    });

    it("url-encodes a returnTo that carries its own query string", () => {
      expect(
        getGitHubConnectUrl("authorize", {
          returnTo: "/settings?tab=integrations",
        })
      ).toBe("/connect/github/link?returnTo=%2Fsettings%3Ftab%3Dintegrations");
    });

    it("ignores an empty returnTo (falsy) and stays on the bare route", () => {
      expect(getGitHubConnectUrl("authorize", { returnTo: "" })).toBe(
        "/connect/github/link"
      );
    });
  });

  describe("getGoogleOAuthUrl", () => {
    it("returns the google integration route", () => {
      expect(getGoogleOAuthUrl()).toBe("/api/integrations/google");
    });
  });
});
