import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import { describe, expect, it, vi } from "vitest";
import { createDesktopApi } from "../src/main/preload-common";
import { FEATURE_FLAGS } from "../src/shared/feature-flags";

describe("CT-10 Project Artifact Board Desktop admission", () => {
  it("is gated by the PostHog key alone, with no Labs registry entry", () => {
    expect(
      FEATURE_FLAGS.some(
        (definition) => definition.key === MANUAL_ARTIFACT_ORDERING_FLAG_KEY
      )
    ).toBe(false);
  });

  it("reads and moves through the shared cloud bridges, with no board-specific bridge", () => {
    const desktopApi = createDesktopApi({
      invoke: vi.fn(),
      send: vi.fn(),
    });

    expect(desktopApi).toHaveProperty("cloudApiFetch");
    expect(desktopApi).not.toHaveProperty("projectArtifactBoard");
    expect(desktopApi).not.toHaveProperty("getProjectArtifactBoardPage");
    expect(desktopApi).not.toHaveProperty("moveProjectArtifactSubtree");
  });
});
