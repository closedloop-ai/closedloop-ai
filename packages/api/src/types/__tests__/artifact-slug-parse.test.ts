import { describe, expect, it } from "vitest";
import { parseTypedArtifactSlug } from "../artifact-slug-parse.ts";
import { ARTIFACT_SLUG_PREFIXES } from "../artifact-slug-prefixes.ts";
import type { DocumentType } from "../document.ts";
import { SLUG_PREFIX_ALIASES, SlugPrefix } from "../slug-prefix.ts";

// ISS-7648. `parseTypedArtifactSlug` returns TWO slugs from one input and they
// are not interchangeable: `canonicalSlug` preserves the input's own prefix for
// the exact, case-sensitive by-slug lookup, while `identitySlug` re-prefixes the
// digits with the DocumentType's single canonical prefix so `FEA-1952` and
// `ISS-1952` fold to one entity. Swapping them at a call site 404s a link or
// un-folds an identity, so every case below asserts the whole returned object.
//
// The alias and untypeable-prefix cases are derived FROM the slug SSOTs rather
// than hardcoding `FEA`/`PRO`, so the next prefix added to either registry is
// covered without editing this file.

type TypeablePrefix = { documentType: DocumentType; prefix: SlugPrefix };

const TYPEABLE_PREFIXES: TypeablePrefix[] = Object.entries(
  ARTIFACT_SLUG_PREFIXES
).flatMap(([documentType, prefix]) =>
  prefix ? [{ documentType: documentType as DocumentType, prefix }] : []
);

const documentTypeForPrefix = (prefix: SlugPrefix): DocumentType | undefined =>
  TYPEABLE_PREFIXES.find((entry) => entry.prefix === prefix)?.documentType;

// EVERY (canonical, alias) pair in the registry, both directions. The fold in
// `DOCUMENT_TYPE_BY_SLUG_PREFIX` can resolve a canonical key that an EARLIER
// alias entry populated, so a pair whose canonical prefix is absent from
// `ARTIFACT_SLUG_PREFIXES` is not automatically dropped — filtering the table on
// that map would silently skip a registry entry.
const ALL_ALIAS_PAIRS = Object.entries(SLUG_PREFIX_ALIASES).flatMap(
  ([canonicalPrefix, aliases]) =>
    (aliases ?? []).map((aliasPrefix) => ({
      aliasPrefix,
      canonicalPrefix: canonicalPrefix as SlugPrefix,
    }))
);

const REGISTERED_ALIAS_PAIR_COUNT = Object.values(SLUG_PREFIX_ALIASES).reduce(
  (total, aliases) => total + (aliases?.length ?? 0),
  0
);

// The subset whose canonical prefix is DIRECTLY in `ARTIFACT_SLUG_PREFIXES`, so
// the expected DocumentType and identitySlug can be pinned to concrete values
// without re-deriving the fold. This is an anchoring subset, not a claim about
// which pairs the parser honors — `ALL_ALIAS_PAIRS` covers that.
const TYPEABLE_ALIAS_CASES = ALL_ALIAS_PAIRS.flatMap(
  ({ aliasPrefix, canonicalPrefix }) => {
    const documentType = documentTypeForPrefix(canonicalPrefix);
    return documentType ? [{ aliasPrefix, canonicalPrefix, documentType }] : [];
  }
);

const PARSEABLE_PREFIXES = new Set<SlugPrefix>([
  ...TYPEABLE_PREFIXES.map((entry) => entry.prefix),
  ...ALL_ALIAS_PAIRS.map((entry) => entry.aliasPrefix),
  ...ALL_ALIAS_PAIRS.map((entry) => entry.canonicalPrefix),
]);

const UNTYPEABLE_PREFIXES = Object.values(SlugPrefix).filter(
  (prefix) => !PARSEABLE_PREFIXES.has(prefix)
);

// Corruptions of a REAL parseable prefix, so the malformed table cannot drift
// from the prefix registry. The two prefix-free shapes have nothing to derive.
const [{ aliasPrefix: SAMPLE_PREFIX }] = ALL_ALIAS_PAIRS;

const MALFORMED_SHAPES = [
  `${SAMPLE_PREFIX}1952`,
  `${SAMPLE_PREFIX}-`,
  "-1952",
  "1952",
  `${SAMPLE_PREFIX}_1952`,
  `${SAMPLE_PREFIX}-19a2`,
  `${SAMPLE_PREFIX}-1952-3`,
  `${SAMPLE_PREFIX}9-1952`,
  ` ${SAMPLE_PREFIX}-1952`,
  `${SAMPLE_PREFIX}-1952 `,
  `${SAMPLE_PREFIX}-1952\n`,
];

describe("parseTypedArtifactSlug", () => {
  it("derives non-empty case sets from the slug SSOTs", () => {
    // Guards the SSOT-derived `it.each` tables below: an empty table registers
    // zero tests and reads as a clean pass.
    expect(TYPEABLE_PREFIXES.length).toBeGreaterThan(0);
    expect(TYPEABLE_ALIAS_CASES.length).toBeGreaterThan(0);
    // Every registry entry reaches the alias table — no direction is skipped.
    expect(ALL_ALIAS_PAIRS).toHaveLength(REGISTERED_ALIAS_PAIR_COUNT);
    expect(REGISTERED_ALIAS_PAIR_COUNT).toBeGreaterThan(0);
    // The three prefixes the docstring names as untypeable, pinned so a fold
    // bug that typed everything could not silently empty the table.
    expect(UNTYPEABLE_PREFIXES).toEqual(
      expect.arrayContaining([
        SlugPrefix.Project,
        SlugPrefix.Workflow,
        SlugPrefix.Session,
      ])
    );
  });

  it.each(TYPEABLE_PREFIXES)(
    "resolves the canonical $prefix- prefix to $documentType with both slugs identical",
    ({ documentType, prefix }) => {
      expect(parseTypedArtifactSlug(`${prefix}-1952`)).toEqual({
        canonicalSlug: `${prefix}-1952`,
        documentType,
        identitySlug: `${prefix}-1952`,
      });
    }
  );

  it.each(ALL_ALIAS_PAIRS)(
    "resolves $aliasPrefix-1952 exactly as its $canonicalPrefix- canonical does, apart from its own addressable slug",
    ({ aliasPrefix, canonicalPrefix }) => {
      const canonical = parseTypedArtifactSlug(`${canonicalPrefix}-1952`);

      // Both directions of the registry are asserted, including one whose
      // canonical prefix is only reachable through an earlier alias entry. A
      // canonical prefix the parser cannot type at all makes both sides null,
      // which the non-vacuity test above keeps from becoming the whole table.
      expect(parseTypedArtifactSlug(`${aliasPrefix}-1952`)).toEqual(
        canonical === null
          ? null
          : { ...canonical, canonicalSlug: `${aliasPrefix}-1952` }
      );
    }
  );

  it.each(TYPEABLE_ALIAS_CASES)(
    "folds the $aliasPrefix- alias onto $documentType while keeping its own addressable slug",
    ({ aliasPrefix, canonicalPrefix, documentType }) => {
      expect(parseTypedArtifactSlug(`${aliasPrefix}-1952`)).toEqual({
        canonicalSlug: `${aliasPrefix}-1952`,
        documentType,
        identitySlug: `${canonicalPrefix}-1952`,
      });
    }
  );

  it.each(TYPEABLE_ALIAS_CASES)(
    "gives $aliasPrefix-1952 and $canonicalPrefix-1952 one shared identity but distinct addressable slugs",
    ({ aliasPrefix, canonicalPrefix }) => {
      const alias = parseTypedArtifactSlug(`${aliasPrefix}-1952`);
      const canonical = parseTypedArtifactSlug(`${canonicalPrefix}-1952`);

      expect(alias?.identitySlug).toBe(canonical?.identitySlug);
      expect(alias?.canonicalSlug).toBe(`${aliasPrefix}-1952`);
      expect(canonical?.canonicalSlug).toBe(`${canonicalPrefix}-1952`);
      // The two fields are not interchangeable: on an alias input they diverge.
      expect(alias?.canonicalSlug).not.toBe(alias?.identitySlug);
    }
  );

  it.each(TYPEABLE_ALIAS_CASES)(
    "upper-cases a lowercase $aliasPrefix- branch-name slug in BOTH returned slugs",
    ({ aliasPrefix, canonicalPrefix, documentType }) => {
      expect(
        parseTypedArtifactSlug(`${aliasPrefix.toLowerCase()}-1952`)
      ).toEqual({
        canonicalSlug: `${aliasPrefix}-1952`,
        documentType,
        identitySlug: `${canonicalPrefix}-1952`,
      });
    }
  );

  it.each(TYPEABLE_PREFIXES)(
    "upper-cases a lowercase canonical $prefix- slug in BOTH returned slugs",
    ({ documentType, prefix }) => {
      expect(parseTypedArtifactSlug(`${prefix.toLowerCase()}-7`)).toEqual({
        canonicalSlug: `${prefix}-7`,
        documentType,
        identitySlug: `${prefix}-7`,
      });
    }
  );

  it("normalizes a mixed-case prefix", () => {
    expect(parseTypedArtifactSlug("PrD-7")).toEqual({
      canonicalSlug: `${SlugPrefix.Prd}-7`,
      documentType: documentTypeForPrefix(SlugPrefix.Prd),
      identitySlug: `${SlugPrefix.Prd}-7`,
    });
  });

  it("preserves leading-zero digits verbatim in both slugs", () => {
    const [{ aliasPrefix, canonicalPrefix, documentType }] =
      TYPEABLE_ALIAS_CASES;

    expect(parseTypedArtifactSlug(`${aliasPrefix}-0042`)).toEqual({
      canonicalSlug: `${aliasPrefix}-0042`,
      documentType,
      identitySlug: `${canonicalPrefix}-0042`,
    });
  });

  it.each(UNTYPEABLE_PREFIXES)(
    "returns null for the untypeable %s- prefix",
    (prefix) => {
      expect(parseTypedArtifactSlug(`${prefix}-1952`)).toBeNull();
      expect(parseTypedArtifactSlug(`${prefix.toLowerCase()}-1952`)).toBeNull();
    }
  );

  it("returns null for a well-formed slug with an unknown prefix", () => {
    expect(parseTypedArtifactSlug("XYZ-1952")).toBeNull();
  });

  it.each([
    { label: "null", slug: null },
    { label: "undefined", slug: undefined },
    { label: "an empty string", slug: "" },
  ])("returns null for $label", ({ slug }) => {
    expect(parseTypedArtifactSlug(slug)).toBeNull();
  });

  it.each(MALFORMED_SHAPES)(
    "returns null for the non-typed shape %j",
    (slug) => {
      expect(parseTypedArtifactSlug(slug)).toBeNull();
    }
  );
});
