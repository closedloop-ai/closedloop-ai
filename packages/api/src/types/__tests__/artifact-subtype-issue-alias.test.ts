import { describe, expect, it } from "vitest";
import {
  ArtifactSubtype,
  ArtifactSubtypeAlias,
  ArtifactSubtypeInput,
  normalizeArtifactSubtype,
} from "../artifact";

// FEA-3956 (PRD-560 Phase 3): the DB/wire boundary accepts the canonical `ISSUE`
// subtype in addition to the legacy `FEATURE`, mapping the canonical input to
// the persisted `FEATURE` subtype (non-destructive; rows stay stored as
// FEATURE). These tests cover BOTH the canonical shape (a skewed newer client
// sending `ISSUE`) and the legacy compat shape (`FEATURE`), plus the
// exhaustiveness contract that a new subtype must be mapped.

describe("ArtifactSubtype ISSUE alias (FEA-3956)", () => {
  it("exposes ISSUE as the canonical input alias, not a persisted subtype", () => {
    expect(ArtifactSubtypeAlias.Issue).toBe("ISSUE");
    // ISSUE never persists — it is deliberately absent from the persisted enum.
    expect(Object.values(ArtifactSubtype)).not.toContain(
      ArtifactSubtypeAlias.Issue
    );
  });

  it("lists ISSUE in the accepted input superset alongside FEATURE", () => {
    const inputs = Object.values(ArtifactSubtypeInput);
    expect(inputs).toContain(ArtifactSubtypeAlias.Issue);
    expect(inputs).toContain(ArtifactSubtype.Feature);
  });

  it("normalizes the canonical ISSUE input to the persisted FEATURE subtype", () => {
    expect(normalizeArtifactSubtype(ArtifactSubtypeAlias.Issue)).toBe(
      ArtifactSubtype.Feature
    );
  });

  it("still accepts legacy FEATURE unchanged (skew-safe compat alias)", () => {
    expect(normalizeArtifactSubtype(ArtifactSubtype.Feature)).toBe(
      ArtifactSubtype.Feature
    );
  });

  it("returns every other persisted subtype unchanged", () => {
    for (const subtype of [
      ArtifactSubtype.Prd,
      ArtifactSubtype.ImplementationPlan,
      ArtifactSubtype.Template,
      ArtifactSubtype.Doc,
    ]) {
      expect(normalizeArtifactSubtype(subtype)).toBe(subtype);
    }
  });

  it("maps every accepted input to a persisted subtype (exhaustive)", () => {
    for (const input of Object.values(ArtifactSubtypeInput)) {
      const canonical = normalizeArtifactSubtype(input);
      // Every canonical target is a persisted subtype (never the ISSUE alias).
      expect(Object.values(ArtifactSubtype)).toContain(canonical);
    }
  });
});
