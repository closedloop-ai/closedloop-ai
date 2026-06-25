import { describe, expect, it } from "vitest";
import { resolveDatadogRumBuildVersion } from "@/lib/datadog-rum/build-version";

describe("resolveDatadogRumBuildVersion", () => {
  it("prefers Vercel git metadata during Vercel builds", () => {
    expect(
      resolveDatadogRumBuildVersion({
        NEXT_PUBLIC_DATADOG_RUM_VERSION: "stale-explicit-version",
        VERCEL: "1",
        VERCEL_GIT_COMMIT_SHA: "preview-head-sha",
      })
    ).toBe("preview-head-sha");
  });

  it("preserves explicit local and test versions before Vercel metadata", () => {
    expect(
      resolveDatadogRumBuildVersion({
        NEXT_PUBLIC_DATADOG_RUM_VERSION: "local-rum-version",
        VERCEL_GIT_COMMIT_SHA: "local-git-sha",
      })
    ).toBe("local-rum-version");
  });

  it("falls back to unknown when no version source is available", () => {
    expect(resolveDatadogRumBuildVersion({})).toBe("unknown");
  });
});
