import { ProjectArtifactBoardAnalyticsFailureKind } from "@repo/api/src/types/surface-analytics";
import { ApiError } from "@repo/app/shared/api/api-error";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  isProjectArtifactBoardConflict,
  projectArtifactBoardFailureKind,
  projectArtifactBoardPerformanceProperties,
} from "./project-artifact-board-analytics";

describe("CT-13 AC-009 Project Artifact Board analytics normalization", () => {
  it("classifies authoritative conflicts without message matching", () => {
    const conflict = new ApiError("future localized message", 409);
    expect(isProjectArtifactBoardConflict(conflict)).toBe(true);
    expect(isProjectArtifactBoardConflict(new Error("409 conflict"))).toBe(
      false
    );
  });

  it("maps contract, network, server, and unknown failures to a closed set", () => {
    const contractResult = z.object({ version: z.literal(1) }).safeParse({
      version: 2,
    });
    if (contractResult.success) {
      throw new Error("fixture must be invalid");
    }
    expect(projectArtifactBoardFailureKind(contractResult.error)).toBe(
      ProjectArtifactBoardAnalyticsFailureKind.Contract
    );
    expect(projectArtifactBoardFailureKind(new ApiError("offline", 0))).toBe(
      ProjectArtifactBoardAnalyticsFailureKind.Network
    );
    expect(projectArtifactBoardFailureKind(new ApiError("failed", 503))).toBe(
      ProjectArtifactBoardAnalyticsFailureKind.Server
    );
    expect(projectArtifactBoardFailureKind({ version: 99 })).toBe(
      ProjectArtifactBoardAnalyticsFailureKind.Unknown
    );
  });

  it("bounds valid performance values and refuses impossible inputs", () => {
    expect(
      projectArtifactBoardPerformanceProperties({
        cardCount: 121,
        durationMs: 90_000.4,
        laneCount: 6,
      })
    ).toEqual({
      card_count_bucket: "101+",
      duration_capped: true,
      duration_ms: 60_000,
      lane_count_bucket: "6-20",
    });
    expect(
      projectArtifactBoardPerformanceProperties({
        cardCount: -1,
        durationMs: Number.NaN,
        laneCount: 1.5,
      })
    ).toBeNull();
  });
});
