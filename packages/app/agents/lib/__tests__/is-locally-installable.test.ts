/**
 * FEA-4017: `isLocallyInstallable` decides whether the "Install (Locally)"
 * header action is offered on the agentic component detail page. Only
 * pack-sourced components map to a vetted local pack id, so only those are
 * installable; every other source is hidden (mirroring how Promote hides for
 * non-distributable kinds).
 */
import { SourceType } from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import { isLocallyInstallable } from "../component-meta";

describe("isLocallyInstallable", () => {
  it("is installable for a pack-sourced component", () => {
    expect(isLocallyInstallable({ sourceType: SourceType.Pack })).toBe(true);
  });

  it("is NOT installable for non-pack sources", () => {
    for (const sourceType of [
      SourceType.Repo,
      SourceType.Local,
      SourceType.Server,
      SourceType.Scope,
    ]) {
      expect(isLocallyInstallable({ sourceType })).toBe(false);
    }
  });
});
