import type { ThreadData } from "@liveblocks/client";
import { DocumentThreadAnchorStatus } from "@repo/api/src/types/comment";
import { describe, expect, it } from "vitest";
import { deriveAnchorStatus } from "../anchor-status";

function makeThread(metadata: Record<string, unknown>): ThreadData {
  // Partial fixture: deriveAnchorStatus only reads `thread.metadata`.
  return { metadata } as unknown as ThreadData;
}

describe("deriveAnchorStatus (web feed)", () => {
  it("prefers an explicit metadata.anchorStatus", () => {
    expect(
      deriveAnchorStatus(
        makeThread({ anchorStatus: DocumentThreadAnchorStatus.Floating })
      )
    ).toBe(DocumentThreadAnchorStatus.Floating);
  });

  it("infers Anchored from a set anchorPreview when no explicit status", () => {
    expect(
      deriveAnchorStatus(makeThread({ anchorPreview: "some-preview" }))
    ).toBe(DocumentThreadAnchorStatus.Anchored);
  });

  it("falls back to ArtifactLevel (not null) when there is no signal", () => {
    expect(deriveAnchorStatus(makeThread({}))).toBe(
      DocumentThreadAnchorStatus.ArtifactLevel
    );
  });
});
