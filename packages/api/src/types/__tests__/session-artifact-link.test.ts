import { describe, expect, it } from "vitest";
import { SessionArtifactLinkKind } from "../session-artifact-link";

describe("SessionArtifactLinkKind", () => {
  it("pins the persisted session to pull-request link kind", () => {
    expect(SessionArtifactLinkKind.SessionPr).toBe("session_pr");
  });
});
