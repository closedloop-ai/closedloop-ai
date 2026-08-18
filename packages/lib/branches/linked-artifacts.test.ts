import { describe, expect, it } from "vitest";
import { deriveLinkedArtifactsFromBranchName } from "./linked-artifacts";

describe("deriveLinkedArtifactsFromBranchName", () => {
  it("extracts a single slug and canonicalizes it to uppercase", () => {
    expect(
      deriveLinkedArtifactsFromBranchName("fea-1952-branches-epic-f")
    ).toEqual([{ slug: "FEA-1952" }]);
  });

  it("extracts every supported slug type, order-preserving", () => {
    expect(
      deriveLinkedArtifactsFromBranchName("prd-1/fea-2/pln-3/pro-4/wrk-5/ses-6")
    ).toEqual([
      { slug: "PRD-1" },
      { slug: "FEA-2" },
      { slug: "PLN-3" },
      { slug: "PRO-4" },
      { slug: "WRK-5" },
      { slug: "SES-6" },
    ]);
  });

  it("dedupes a slug repeated in the branch name", () => {
    expect(
      deriveLinkedArtifactsFromBranchName("fea-3457-fix/pln-988-and-fea-3457")
    ).toEqual([{ slug: "FEA-3457" }, { slug: "PLN-988" }]);
  });

  it("returns no artifacts for a slug-less branch name", () => {
    expect(deriveLinkedArtifactsFromBranchName("just-a-feature")).toEqual([]);
  });

  it("does not match an unknown prefix", () => {
    expect(deriveLinkedArtifactsFromBranchName("bug-12/task-9")).toEqual([]);
  });

  it("matches a slug whose number is wider than five digits", () => {
    // The family prefix is the gate, not the number's width — capping it would
    // silently stop linking branches once slug numbering outgrows the cap.
    expect(deriveLinkedArtifactsFromBranchName("fea-123456-wide")).toEqual([
      { slug: "FEA-123456" },
    ]);
  });
});
