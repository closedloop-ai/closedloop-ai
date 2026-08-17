/**
 * Provenance-free exact-definition fingerprint for an agentic component.
 *
 * This is the **fact-2** identity of PRD-527 / FEA-3290 (F1): "which *exact*
 * version of a definition ran/exists", as opposed to the fact-1 *coarse*
 * identity (`componentUuid`, see `component-identity.ts`).
 *
 * The two are deliberately distinct:
 *
 * - `computeComponentUuid` folds in **provenance** (`source` + `owner`) and runs
 *   a *lenient* normalizer that strips ALL whitespace and lowercases — so two
 *   whitespace-/case-only edits of the same file group as the *same logical
 *   component*.
 * - `computeDefinitionHash` (this module) is **provenance-FREE** (definition
 *   content + kind only — never repo/path/user/org/pack/source) and
 *   __whitespace-preserving__ — so a whitespace-only or case-only edit produces a
 *   __different__ fingerprint (a genuinely different exact version), while purely
 *   cosmetic byte-encoding differences (line endings, Unicode encoding of the
 *   same character) do NOT.
 *
 * This is the **load-bearing normalizer + hashing contract** that F6 Discovery
 * (FEA-3296 §3.3) imports to fingerprint scan results. Discovery MUST NOT
 * reimplement it; it calls `computeDefinitionHash`. Because historical hashes
 * must never be reinterpreted, the rule set is pinned by
 * `NORMALIZER_CONTRACT_VERSION`, which is folded into every hash — changing any
 * normalization rule requires bumping the version, which yields a new hash space
 * rather than silently re-keying existing versions.
 *
 * Client-safe: the SHA-256 implementation below is a small, self-contained,
 * pure-JS (no `node:crypto`, no WebCrypto, no dependency) function, so this
 * module resolves identically in the browser, the desktop renderer, and the
 * server — the same portability constraint `component-identity.ts` observes. It
 * also means this module adds **no** new dependency to `@repo/api` (and thus no
 * Dockerfile churn for the Dockerized consumers such as `apps/mcp`).
 *
 * @see component-identity.ts — the coarse, provenance-bearing fact-1 identity.
 */

import type { AgentComponentKind } from "./types/agent-component";

/**
 * Version of the normalization + hashing rule set below. Persisted alongside
 * every `definitionHash` so a stored fingerprint is always interpreted under the
 * rules that produced it. **Bump this whenever any normalization rule changes**
 * (that intentionally moves every future hash into a new space; it never
 * rewrites already-stored hashes). Folded into the hash pre-image, so two
 * contract versions can never collide even on identical content.
 */
export const NORMALIZER_CONTRACT_VERSION = 1;

/**
 * Domain-separation tag mixed into the hash pre-image so a `definitionHash` can
 * never collide with any other SHA-256 in the platform that happened to hash the
 * same bytes. Stable — changing it re-keys every fingerprint.
 */
const FINGERPRINT_DOMAIN = "closedloop.definition-fingerprint";

/**
 * Frame one variable-length field into the hash pre-image, collision-proof:
 * `<utf16-code-unit-length>:<field>`. Length-prefix framing means no field's
 * content can ever shift a field boundary — unlike a delimiter, it is robust
 * even if a field contains the delimiter/NUL/newline. So body `"a\nb"` +
 * frontmatter `""` can never collide with body `"a"` + frontmatter `"b"`.
 * Part of the frozen contract — do not change the framing without bumping
 * {@link NORMALIZER_CONTRACT_VERSION}.
 */
function frameField(text: string): string {
  return `${text.length}:${text}`;
}

const CRLF_OR_CR_RE = /\r\n?/g;

/**
 * Normalize a single definition text field to its canonical fingerprint form.
 *
 * Rules (v1 of {@link NORMALIZER_CONTRACT_VERSION}):
 * 1. **UTF-8 / Unicode**: JS strings are already Unicode scalar sequences; we do
 *    not re-decode.
 * 2. **Unicode form: NFC** (canonical composition). This folds only encoding
 *    artifacts — the two encodings of the *same* character (e.g. `é` as one
 *    code point vs. `e` + combining acute) become identical — WITHOUT folding
 *    compatibility variants (NFKC would fold `ﬁ`→`fi`, full-width→half-width,
 *    superscripts, etc., which are *semantically meaningful* differences a
 *    definition fingerprint must preserve). NFC is the W3C-recommended
 *    interchange form and what editors/filesystems already emit. (Resolves
 *    PLN-1403 open question OQ3.)
 * 3. **Line endings**: CRLF and lone CR both fold to LF, so the same definition
 *    fingerprints identically regardless of the OS/editor that saved it.
 * 4. **Everything else is preserved**: leading/trailing and interior
 *    whitespace, case, punctuation, and ordering all remain significant. A
 *    whitespace-only or case-only edit is a genuinely different exact version
 *    and MUST produce a different fingerprint (this is what distinguishes the
 *    fingerprint from the coarse `componentUuid`).
 */
export function normalizeDefinitionField(text: string): string {
  return text.normalize("NFC").replace(CRLF_OR_CR_RE, "\n");
}

/**
 * Inputs to the provenance-free definition fingerprint. Deliberately carries
 * **only** the definition's own content + its `kind` — never any provenance
 * (repo, path, owner, org, pack, source, device). Adding a provenance field
 * here would be a contract violation (PD5).
 */
export type DefinitionFingerprintInput = {
  /**
   * The definition's frontmatter block (e.g. the YAML header of a `.md`
   * component), if the format has one. Omit or pass `""` when there is none;
   * `undefined` and `""` fingerprint identically.
   */
  frontmatter?: string;
  /** The definition's body — the full, untruncated content after frontmatter. */
  body: string;
  /**
   * The component kind (`subagent` | `command` | `skill` | …). Folded into the
   * fingerprint per PD5 ("fingerprint = normalized content + kind"): the same
   * bytes under two different kinds are two different exact versions.
   */
  kind: AgentComponentKind;
};

/** The result of fingerprinting a definition. */
export type DefinitionFingerprint = {
  /**
   * Lowercase 64-char hex SHA-256 of the normalized, provenance-free
   * definition. This is the fact-2 exact-version identity.
   */
  definitionHash: string;
  /**
   * The {@link NORMALIZER_CONTRACT_VERSION} under which `definitionHash` was
   * produced. Persist this next to the hash so it is never reinterpreted under a
   * later rule set.
   */
  normalizerContractVersion: number;
};

/**
 * Build the deterministic, provenance-free pre-image the fingerprint hashes.
 * Order and separators are part of the frozen contract — do not reorder.
 */
function buildFingerprintPreImage(input: DefinitionFingerprintInput): string {
  const frontmatter = normalizeDefinitionField(input.frontmatter ?? "");
  const body = normalizeDefinitionField(input.body);
  // Domain-separated, version-pinned, kind-scoped, content-only. Every
  // variable-length field is length-prefixed so no content can shift a boundary.
  return [
    FINGERPRINT_DOMAIN,
    frameField(String(NORMALIZER_CONTRACT_VERSION)),
    frameField(input.kind),
    frameField(frontmatter),
    frameField(body),
  ].join("");
}

/**
 * Compute the provenance-free exact-definition fingerprint.
 *
 * Deterministic and pure: identical `{ frontmatter, body, kind }` (up to the
 * normalization rules above) always yield the same `definitionHash`, on any
 * surface, with no provenance ever affecting the result.
 */
export function computeDefinitionHash(
  input: DefinitionFingerprintInput
): DefinitionFingerprint {
  return {
    definitionHash: sha256Hex(buildFingerprintPreImage(input)),
    normalizerContractVersion: NORMALIZER_CONTRACT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Self-contained, client-safe SHA-256 (FIPS 180-4).
//
// A tiny, dependency-free implementation so `@repo/api` stays importable in the
// browser/desktop renderer/server alike and gains no new dependency. Correctness
// is pinned in the test suite against Node's `crypto` (known-answer + fuzz).
// ---------------------------------------------------------------------------

/** Whitespace splitter for the hex-word constant blocks (hoisted per useTopLevelRegex). */
const WHITESPACE_RE = /\s+/;

// The SHA-256 core below is FIPS 180-4: its `^`, `&`, `~`, `<<`, `>>>` operators are
// intrinsic to the algorithm and this module is a frozen hashing contract, so they
// cannot be rewritten. Suppress noBitwiseOperators for the implementation block only.
// biome-ignore-start lint/suspicious/noBitwiseOperators: FIPS 180-4 SHA-256 requires bitwise ops; frozen hash contract.

/**
 * Parse a whitespace-separated list of 8-hex-digit words into a `Uint32Array`.
 * The constants are expressed as strings so the well-known FIPS 180-4 hex values
 * stay readable as a block without tripping the numeric-separator lint.
 */
function u32words(hex: string): Uint32Array {
  const words = hex.trim().split(WHITESPACE_RE);
  const out = new Uint32Array(words.length);
  for (let i = 0; i < words.length; i++) {
    out[i] = Number.parseInt(words[i], 16) >>> 0;
  }
  return out;
}

/** SHA-256 round constants (first 32 bits of the cube roots of the first 64 primes). */
const K = u32words(`
  428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5
  d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174
  e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da
  983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967
  27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85
  a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070
  19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3
  748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2
`);

/** SHA-256 initial hash values (first 32 bits of the square roots of the first 8 primes). */
const H0 = u32words(`
  6a09e667 bb67ae85 3c6ef372 a54ff53a 510e527f 9b05688c 1f83d9ab 5be0cd19
`);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Compute the lowercase hex SHA-256 of a UTF-8-encoded string. */
export function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const bitLen = bytes.length * 8;

  // Pad: 0x80, then zeros, then 64-bit big-endian length to a 64-byte boundary.
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  // 64-bit length; JS bitwise is 32-bit, so the high word derives from division.
  const hi = Math.floor(bitLen / 4_294_967_296);
  const lo = bitLen >>> 0;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 8, hi);
  dv.setUint32(paddedLen - 4, lo);

  const h = H0.slice();

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = dv.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let hex = "";
  for (let i = 0; i < 8; i++) {
    hex += h[i].toString(16).padStart(8, "0");
  }
  return hex;
}
// biome-ignore-end lint/suspicious/noBitwiseOperators: end SHA-256 implementation block.
