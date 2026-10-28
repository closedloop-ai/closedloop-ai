import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { describe, expect, it } from "vitest";
import { optionalSingleArtifactEditSurface } from "./single-artifact-edit-surface";

describe("optionalSingleArtifactEditSurface", () => {
  it.each([
    ArtifactStatusEditSurface.Detail,
    ArtifactStatusEditSurface.InlineCell,
    ArtifactStatusEditSurface.Board,
  ])("accepts the single-artifact surface %s", (surface) => {
    expect(optionalSingleArtifactEditSurface.parse(surface)).toBe(surface);
  });

  it.each([undefined, "future_surface"])(
    "degrades omitted or unknown provenance to omission",
    (surface) => {
      expect(optionalSingleArtifactEditSurface.parse(surface)).toBeUndefined();
    }
  );

  it.each([
    ArtifactStatusEditSurface.Bulk,
    ArtifactStatusEditSurface.RowAction,
  ])("refuses the known non-single-artifact surface %s", (surface) => {
    expect(optionalSingleArtifactEditSurface.safeParse(surface).success).toBe(
      false
    );
  });
});
