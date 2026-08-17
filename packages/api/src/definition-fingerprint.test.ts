import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeComponentUuid } from "./component-identity";
import {
  computeDefinitionHash,
  type DefinitionFingerprintInput,
  NORMALIZER_CONTRACT_VERSION,
  normalizeDefinitionField,
  sha256Hex,
} from "./definition-fingerprint";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const base: DefinitionFingerprintInput = {
  frontmatter: "---\nname: reviewer\n---",
  body: "# Reviewer\n\nReview the code carefully.",
  kind: "subagent",
};

const hashOf = (input: DefinitionFingerprintInput) =>
  computeDefinitionHash(input).definitionHash;

describe("sha256Hex", () => {
  it("matches the FIPS 180-4 known answer for the empty string", () => {
    // The canonical SHA-256("") test vector.
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  it('matches the known answer for "abc"', () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("matches node:crypto across message lengths (block-boundary fuzz)", () => {
    // Cover single/multi-block, the 55/56/64-byte padding edges, and unicode.
    const cases = [
      "",
      "a",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(63),
      "a".repeat(64),
      "a".repeat(65),
      "a".repeat(1000),
      "café résumé — naïve\n\tmixed\r\nwhitespace",
      "🔥 multi-byte 你好 \u0000 control",
    ];
    for (const msg of cases) {
      const expected = createHash("sha256").update(msg, "utf8").digest("hex");
      expect(sha256Hex(msg), `sha256(${JSON.stringify(msg)})`).toBe(expected);
    }
  });

  it("always returns 64 lowercase hex chars", () => {
    expect(sha256Hex("anything")).toMatch(SHA256_HEX_RE);
  });
});

describe("normalizeDefinitionField", () => {
  it("folds CRLF and lone CR to LF", () => {
    expect(normalizeDefinitionField("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("applies NFC (canonical composition)", () => {
    // "é" as e + combining acute (NFD) normalizes to the single composed code point.
    const decomposed = "café";
    const composed = "café";
    expect(decomposed).not.toBe(composed); // different byte sequences
    expect(normalizeDefinitionField(decomposed)).toBe(composed);
  });

  it("does NOT apply compatibility folding (NFKC)", () => {
    // The ligature "ﬁ" (U+FB01) would fold to "fi" under NFKC; NFC preserves it.
    expect(normalizeDefinitionField("ﬁle")).toBe("ﬁle");
    // Full-width digit stays full-width under NFC (NFKC would map to ASCII "1").
    expect(normalizeDefinitionField("１")).toBe("１");
  });

  it("preserves interior/leading/trailing whitespace, case, and punctuation", () => {
    const s = "  # Title \n\n   Body,  with   spaces!  ";
    expect(normalizeDefinitionField(s)).toBe(s);
  });
});

describe("computeDefinitionHash — shape & determinism", () => {
  it("returns a 64-char lowercase hex hash and the contract version", () => {
    const result = computeDefinitionHash(base);
    expect(result.definitionHash).toMatch(SHA256_HEX_RE);
    expect(result.normalizerContractVersion).toBe(NORMALIZER_CONTRACT_VERSION);
  });

  it("is deterministic across repeated calls", () => {
    expect(hashOf(base)).toBe(hashOf(base));
    expect(hashOf(base)).toBe(hashOf({ ...base }));
  });

  it("treats omitted frontmatter and empty-string frontmatter identically", () => {
    const withEmpty = hashOf({ ...base, frontmatter: "" });
    const { frontmatter: _omit, ...withoutFrontmatter } = base;
    expect(hashOf(withoutFrontmatter)).toBe(withEmpty);
  });
});

describe("computeDefinitionHash — provenance independence (PD5)", () => {
  it("depends only on frontmatter+body+kind (no provenance inputs exist)", () => {
    // The input type structurally excludes source/owner/path/org/pack. This test
    // documents that: adding provenance would be a type error, and identical
    // content fingerprints identically no matter where it was observed.
    const fromRepo = hashOf(base);
    const fromLocal = hashOf({ ...base });
    const fromPack = hashOf({ ...base });
    expect(fromRepo).toBe(fromLocal);
    expect(fromLocal).toBe(fromPack);
  });
});

describe("computeDefinitionHash — normalization equivalence", () => {
  it("is stable across CRLF vs LF line endings", () => {
    const lf = hashOf({ ...base, body: "line one\nline two\n" });
    const crlf = hashOf({ ...base, body: "line one\r\nline two\r\n" });
    const cr = hashOf({ ...base, body: "line one\rline two\r" });
    expect(lf).toBe(crlf);
    expect(lf).toBe(cr);
  });

  it("is stable across NFC/NFD encodings of the same character", () => {
    const nfd = hashOf({ ...base, body: "café" });
    const nfc = hashOf({ ...base, body: "café" });
    expect(nfd).toBe(nfc);
  });
});

describe("computeDefinitionHash — semantic sensitivity", () => {
  it("changes on a one-character semantic edit", () => {
    expect(hashOf({ ...base, body: `${base.body}.` })).not.toBe(hashOf(base));
  });

  it("changes on a whitespace-only edit (preserves meaningful whitespace)", () => {
    expect(
      hashOf({ ...base, body: base.body.replace("code", "code ") })
    ).not.toBe(hashOf(base));
    // Indentation is meaningful to a fingerprint.
    expect(hashOf({ ...base, body: `  ${base.body}` })).not.toBe(hashOf(base));
  });

  it("changes on a case-only edit (preserves case)", () => {
    expect(hashOf({ ...base, body: base.body.toUpperCase() })).not.toBe(
      hashOf(base)
    );
  });

  it("changes when the kind changes (fingerprint = content + kind, PD5)", () => {
    expect(hashOf({ ...base, kind: "command" })).not.toBe(hashOf(base));
    expect(hashOf({ ...base, kind: "skill" })).not.toBe(hashOf(base));
  });

  it("does not let frontmatter and body run together ambiguously", () => {
    // "a" + "b\nc"  must differ from  "a\nb" + "c".
    const a = hashOf({ ...base, frontmatter: "a", body: "b\nc" });
    const b = hashOf({ ...base, frontmatter: "a\nb", body: "c" });
    expect(a).not.toBe(b);
  });

  it("resists boundary-shift collisions even when a field contains the frame delimiter", () => {
    // Length-prefix framing must hold even if content mimics the "<len>:" frame.
    // "5:x" (frontmatter) + "" (body) vs "" (frontmatter) + "5:x" (body).
    const a = hashOf({ ...base, frontmatter: "5:x", body: "" });
    const b = hashOf({ ...base, frontmatter: "", body: "5:x" });
    expect(a).not.toBe(b);
    // A moved boundary character must not collide either.
    const c = hashOf({ ...base, frontmatter: "ab", body: "c" });
    const d = hashOf({ ...base, frontmatter: "a", body: "bc" });
    expect(c).not.toBe(d);
  });
});

describe("coarse componentUuid vs exact definitionHash", () => {
  const content = "# Reviewer\n\nReview the code.";
  const whitespaceCaseEdit = "  # REVIEWER\n\n   Review   the code. ";

  it("coarse identity groups whitespace/case edits; the fingerprint splits them", () => {
    // componentUuid (fact-1, lenient) collapses whitespace/case ...
    const coarseA = computeComponentUuid({
      source: "closedloop-ai/plugins",
      owner: "org-1",
      content,
    });
    const coarseB = computeComponentUuid({
      source: "closedloop-ai/plugins",
      owner: "org-1",
      content: whitespaceCaseEdit,
    });
    expect(coarseA).toBe(coarseB);

    // ... but definitionHash (fact-2, whitespace/case-preserving) does not.
    const exactA = hashOf({ ...base, frontmatter: "", body: content });
    const exactB = hashOf({
      ...base,
      frontmatter: "",
      body: whitespaceCaseEdit,
    });
    expect(exactA).not.toBe(exactB);
  });

  it("the fingerprint ignores provenance that the coarse identity folds in", () => {
    // componentUuid changes with source/owner ...
    const coarseA = computeComponentUuid({
      source: "repo/a",
      owner: "org-1",
      content,
    });
    const coarseB = computeComponentUuid({
      source: "repo/b",
      owner: "org-2",
      content,
    });
    expect(coarseA).not.toBe(coarseB);
    // ... the fingerprint has no such inputs at all: same content → same hash.
    expect(hashOf({ ...base, frontmatter: "", body: content })).toBe(
      hashOf({ ...base, frontmatter: "", body: content })
    );
  });
});

describe("normalizer contract version", () => {
  it("is folded into the hash pre-image (v1 pins the current rule set)", () => {
    // Recompute the frozen pre-image independently and confirm the hash matches,
    // proving the version participates in the digest. If the contract version or
    // pre-image layout ever changes, this pinned expectation must change too.
    const frame = (text: string) => `${text.length}:${text}`;
    const preImage =
      "closedloop.definition-fingerprint" +
      frame(String(NORMALIZER_CONTRACT_VERSION)) +
      frame(base.kind) +
      frame(normalizeDefinitionField(base.frontmatter ?? "")) +
      frame(normalizeDefinitionField(base.body));
    expect(hashOf(base)).toBe(sha256Hex(preImage));
  });

  it("pins v1 as the current contract version", () => {
    expect(NORMALIZER_CONTRACT_VERSION).toBe(1);
  });
});
