import { describe, expect, it } from "vitest";
import { ARTIFACT_SLUG_PREFIXES } from "./artifact-slug-prefixes";
import { DocumentType } from "./document";
import {
  expandSlugAliases,
  SLUG_COUNTER_KEY,
  SLUG_LOOKUP_PREFIXES,
  SLUG_PREFIX_ALIASES,
  SlugPrefix,
} from "./slug-prefix";

// FEA-3949 Slice A: the DOC (evergreen document) subtype gets its own slug
// prefix DOC-*, wired into ARTIFACT_SLUG_PREFIXES alongside PRD/PLN/FEA.
describe("SlugPrefix DOC (FEA-3949)", () => {
  it("exposes DOC as a slug prefix", () => {
    expect(SlugPrefix.Doc).toBe("DOC");
  });

  it("maps DocumentType.Doc to the DOC slug prefix", () => {
    expect(ARTIFACT_SLUG_PREFIXES[DocumentType.Doc]).toBe(SlugPrefix.Doc);
  });

  it("does not collide with any other slug prefix value", () => {
    const values = Object.values(SlugPrefix);
    expect(new Set(values).size).toBe(values.length);
  });
});

// FEA-4137: Feature → Issue. New slugs mint as ISS-###; FEA-### stays a compat
// alias resolving to the same numeric identity; the shared counter row keeps the
// numeric series continuous.
describe("Issue slug migration (FEA-4137)", () => {
  it("exposes ISS as the canonical Issue prefix and keeps FEA as an alias", () => {
    expect(SlugPrefix.Issue).toBe("ISS");
    expect(SlugPrefix.Feature).toBe("FEA");
  });

  it("mints ISS- for the Feature document type (new canonical slug)", () => {
    expect(ARTIFACT_SLUG_PREFIXES[DocumentType.Feature]).toBe(SlugPrefix.Issue);
  });

  it("keys the ISS counter on the FEA row for numeric continuity", () => {
    expect(SLUG_COUNTER_KEY[SlugPrefix.Issue]).toBe(SlugPrefix.Feature);
  });

  it("aliases ISS ↔ FEA bidirectionally", () => {
    expect(SLUG_PREFIX_ALIASES[SlugPrefix.Issue]).toEqual([SlugPrefix.Feature]);
    expect(SLUG_PREFIX_ALIASES[SlugPrefix.Feature]).toEqual([SlugPrefix.Issue]);
  });

  it("includes both ISS and FEA in the exact-slug lookup prefixes", () => {
    expect(SLUG_LOOKUP_PREFIXES).toContain(SlugPrefix.Issue);
    expect(SLUG_LOOKUP_PREFIXES).toContain(SlugPrefix.Feature);
  });

  describe("expandSlugAliases", () => {
    it("expands ISS-592 to include its FEA- alias (canonical first)", () => {
      expect(expandSlugAliases("ISS-592")).toEqual(["ISS-592", "FEA-592"]);
    });

    it("expands FEA-592 to include its ISS- alias (input first)", () => {
      expect(expandSlugAliases("FEA-592")).toEqual(["FEA-592", "ISS-592"]);
    });

    it("preserves the numeric identity across the alias", () => {
      expect(expandSlugAliases("ISS-1")).toEqual(["ISS-1", "FEA-1"]);
      expect(expandSlugAliases("FEA-1")).toEqual(["FEA-1", "ISS-1"]);
    });

    it("preserves letter-case of the matched prefix on the alias", () => {
      expect(expandSlugAliases("iss-5")).toEqual(["iss-5", "fea-5"]);
    });

    it("returns just the slug for a prefix with no alias", () => {
      expect(expandSlugAliases("PRD-42")).toEqual(["PRD-42"]);
      expect(expandSlugAliases("PLN-7")).toEqual(["PLN-7"]);
    });

    it("returns just the input for a non-typed slug", () => {
      expect(expandSlugAliases("abcdef0123456")).toEqual(["abcdef0123456"]);
      expect(expandSlugAliases("not-a-slug-x")).toEqual(["not-a-slug-x"]);
    });
  });
});
