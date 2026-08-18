import { describe, expect, it } from "vitest";
import {
  getGitHubConnectUrl,
  getGoogleOAuthUrl,
  getLinearOAuthUrl,
} from "./integration-connect-urls";

/**
 * These builders return the exact Next API-route URLs that OAuth entry points
 * navigate the browser to across settings, onboarding, insights, and the
 * agent-onboarding card. A silent change to the path or query params would
 * break the redirect flow for every provider, so each assertion pins the
 * fully-constructed URL — path plus every query parameter — rather than a
 * substring.
 */
describe("integration-connect-urls", () => {
  describe("getGitHubConnectUrl", () => {
    it("defaults to the authorize route with no query string", () => {
      expect(getGitHubConnectUrl()).toBe("/api/integrations/github");
    });

    it("returns the bare authorize route when mode is explicitly 'authorize'", () => {
      expect(getGitHubConnectUrl("authorize")).toBe("/api/integrations/github");
    });

    it("adds install=true when mode is 'install'", () => {
      expect(getGitHubConnectUrl("install")).toBe(
        "/api/integrations/github?install=true"
      );
    });

    it("adds a returnTo param in authorize mode", () => {
      expect(getGitHubConnectUrl("authorize", { returnTo: "/settings" })).toBe(
        "/api/integrations/github?returnTo=%2Fsettings"
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
      ).toBe(
        "/api/integrations/github?returnTo=%2Fsettings%3Ftab%3Dintegrations"
      );
    });

    it("ignores an empty returnTo (falsy) and stays on the bare route", () => {
      expect(getGitHubConnectUrl("authorize", { returnTo: "" })).toBe(
        "/api/integrations/github"
      );
    });
  });

  describe("getGoogleOAuthUrl", () => {
    it("returns the google integration route", () => {
      expect(getGoogleOAuthUrl()).toBe("/api/integrations/google");
    });
  });

  describe("getLinearOAuthUrl", () => {
    it("returns the linear integration route", () => {
      expect(getLinearOAuthUrl()).toBe("/api/integrations/linear");
    });
  });
});
