import { Surface } from "@repo/api/src/types/surface-analytics";
import { describe, expect, it } from "vitest";
import { resolveBrowserAnalyticsContext } from "./browser-context";
import { AppEnvironment } from "./environment";

describe("deployment attribution", () => {
  it.each([Surface.Marketing, Surface.Web])(
    "prioritizes preview for %s even with production configuration",
    (surface) => {
      expect(
        resolveBrowserAnalyticsContext({
          surface,
          deploymentEnvironment: "preview",
          appEnvironment: "production",
        })
      ).toEqual({ surface, environment: AppEnvironment.Preview });
    }
  );
  it.each([
    ["production", AppEnvironment.Production],
    ["stage", AppEnvironment.Stage],
    ["development", AppEnvironment.Development],
  ])(
    "maps explicit %s using existing telemetry vocabulary",
    (appEnvironment, environment) => {
      expect(
        resolveBrowserAnalyticsContext({
          surface: Surface.Marketing,
          appEnvironment,
        }).environment
      ).toBe(environment);
    }
  );
  it.each([
    [Surface.Marketing, "https://www.closedloop.ai", AppEnvironment.Production],
    [Surface.Marketing, "https://closedloop.ai", AppEnvironment.Production],
    [Surface.Web, "https://app.closedloop.ai", AppEnvironment.Production],
    [
      Surface.Marketing,
      "https://www.closedloop.ai.evil.example",
      AppEnvironment.Stage,
    ],
    [Surface.Web, "https://www.closedloop.ai", AppEnvironment.Stage],
    [Surface.Marketing, "http://localhost:3001", AppEnvironment.Development],
    [Surface.Marketing, "invalid", AppEnvironment.Stage],
    [Surface.Marketing, undefined, AppEnvironment.Stage],
  ])("classifies %s at %s conservatively", (surface, siteUrl, environment) => {
    expect(
      resolveBrowserAnalyticsContext({ surface, siteUrl }).environment
    ).toBe(environment);
  });
  it("keeps explicit stage consistent with product telemetry", () => {
    expect(
      resolveBrowserAnalyticsContext({
        surface: Surface.Marketing,
        appEnvironment: "stage",
        siteUrl: "http://localhost:3001",
      }).environment
    ).toBe(AppEnvironment.Stage);
  });
  it("prioritizes the public Vercel marker over the server fallback", () => {
    expect(
      resolveBrowserAnalyticsContext({
        surface: Surface.Marketing,
        publicDeploymentEnvironment: "preview",
        deploymentEnvironment: "production",
        appEnvironment: "production",
      }).environment
    ).toBe(AppEnvironment.Preview);
  });
});
