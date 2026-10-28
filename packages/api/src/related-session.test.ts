/**
 * ISS-7235 — the non-Session exception and the shared display cap.
 *
 * The exception is enumerated over the WHOLE `ArtifactType` vocabulary rather
 * than spot-checked, so a fifth type added later fails here until someone
 * decides deliberately whether it inherits the field.
 */
import { describe, expect, it } from "vitest";
import { ArtifactType } from "./types/artifact.ts";
import { BRANCH_LIST_SERVER_PAGE_SIZE_MAX } from "./types/branch-list-contract.ts";
import {
  RELATED_SESSIONS_DISPLAY_CAP,
  RELATED_SESSIONS_PAGE_ARTIFACT_CAP,
  supportsRelatedSessionsField,
} from "./types/related-session.ts";

describe("supportsRelatedSessionsField", () => {
  it("admits every non-Session artifact type", () => {
    const admitted = Object.values(ArtifactType).filter((type) =>
      supportsRelatedSessionsField(type)
    );

    expect(admitted).toEqual([
      ArtifactType.Document,
      ArtifactType.Branch,
      ArtifactType.Deployment,
    ]);
  });

  it("excludes Session, and only Session", () => {
    const excluded = Object.values(ArtifactType).filter(
      (type) => !supportsRelatedSessionsField(type)
    );

    expect(excluded).toEqual([ArtifactType.Session]);
  });
});

describe("RELATED_SESSIONS_DISPLAY_CAP", () => {
  it("is a positive whole number of pills", () => {
    expect(Number.isInteger(RELATED_SESSIONS_DISPLAY_CAP)).toBe(true);
    expect(RELATED_SESSIONS_DISPLAY_CAP).toBeGreaterThan(0);
  });
});

describe("RELATED_SESSIONS_PAGE_ARTIFACT_CAP", () => {
  it("stays pinned to the Branches server page maximum", () => {
    expect(RELATED_SESSIONS_PAGE_ARTIFACT_CAP).toBe(
      BRANCH_LIST_SERVER_PAGE_SIZE_MAX
    );
  });
});
