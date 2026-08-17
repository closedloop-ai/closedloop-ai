/**
 * @file sync-source-content-clamp.test.ts
 * @description FEA-3692 — the desktop clamps a synced component's `content`
 * before POSTing it to `/desktop/components/sync`. The component-sync chunker
 * (`desktop-components-client.ts`) dead-letters any single component whose
 * SERIALIZED JSON exceeds its per-request byte budget
 * (`COMPONENTS_CHUNK_BYTE_BUDGET` ≈ 248 KiB).
 *
 * The prior FEA-3626 clamp bounded the RAW UTF-8 byte size (96 KiB), but JSON
 * string-escaping inflates the wire size: a control char escapes to the 6-byte
 * `\uXXXX` form. A 512 KiB NUL-filled definition clamped to 98 304 raw bytes still
 * serialized to ~576 KiB — the chunker classified it oversized, emitted zero
 * chunks + one oversized entry, and the component's existence row (name, kind,
 * contentHash, install path) silently never reached the cloud while the sync
 * cursor advanced past it.
 *
 * The fix clamps `content` by its SERIALIZED (JSON-escaped) UTF-8 byte size
 * (`SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES` = 128 KiB, ~120 KiB under the
 * chunk budget) using `serializedJsonUtf8ByteSize`, which — critically — counts a
 * lone surrogate as its 6-byte `\uXXXX` escape (matching `JSON.stringify`), not
 * the 3 bytes of its U+FFFD replacement. These tests pin: (1) the 98 KiB→~590 KiB
 * NUL regression clamps to fit and is NOT dead-lettered, (2) escape-heavy /
 * quote-heavy / multibyte / lone-surrogate / near-boundary bodies all serialize
 * under the chunk budget, (3) small content passes through unchanged, and (4)
 * truncation is codepoint-safe (no split scalar / replacement char at the tail).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SYNCED_COMPONENT_CONTENT_MAX_CHARS,
  SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES,
  serializedJsonUtf8ByteSize,
} from "@repo/api/src/types/synced-component-content";
import {
  COMPONENTS_CHUNK_BYTE_BUDGET,
  chunkComponentsByByteSize,
} from "../src/main/dashboard/desktop-components-client.js";
import { clampSyncedComponentContent } from "../src/main/database/component-sync-source.js";

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).byteLength;

/** Serialized (JSON-escaped) UTF-8 byte size, measured via the real serializer. */
function realSerializedBytes(s: string): number {
  // JSON.stringify wraps in quotes; strip them to compare with the content-only budget.
  return byteLength(JSON.stringify(s)) - 2;
}

function componentWith(externalId: string, content: string) {
  return {
    externalId,
    componentKind: "agent",
    componentKey: null,
    harness: null,
    name: "A component",
    version: null,
    description: null,
    sourceUrl: null,
    installPath: "/agents/x.md",
    packId: null,
    scope: null,
    projectPath: null,
    metadata: null,
    content,
    contentHash: "hash",
    resolvedState: "resolved" as const,
    firstSeenAt: null,
    lastSeenAt: null,
    uninstalledAt: null,
  };
}

test("serializedJsonUtf8ByteSize matches JSON.stringify, incl. lone surrogates (6 bytes, not 3)", () => {
  const lone = "\uD800"; // unpaired high surrogate
  // The subtlety: TextEncoder emits the 3-byte U+FFFD replacement, but
  // JSON.stringify escapes a lone surrogate to the 6-byte `\uXXXX` form.
  assert.equal(byteLength(lone), 3, "TextEncoder undercounts a lone surrogate");
  assert.equal(
    serializedJsonUtf8ByteSize(lone),
    6,
    "serialized size counts the lone surrogate as its 6-byte \\uXXXX escape"
  );

  for (const sample of [
    "",
    "plain ascii",
    '"quotes" \\back\\ \n\t control',
    "café — 日本語 — 😀🎉",
    "𐀀lead\uDFFFtail", // mix of pair + lone surrogates
    String.fromCharCode(0).repeat(1000), // NUL run → 6 bytes each
  ]) {
    assert.equal(
      serializedJsonUtf8ByteSize(sample),
      realSerializedBytes(sample),
      `serialized size mismatch for ${JSON.stringify(sample.slice(0, 24))}`
    );
  }
});

test("FEA-3692 regression: a 512 KiB NUL body (98 KiB raw → ~590 KiB serialized) clamps to fit and is NOT dead-lettered", () => {
  // The exact audit case: 512 KiB of NUL bytes. Under the OLD raw-byte clamp this
  // became 98 304 raw bytes that serialized to ~576 KiB (6× blow-up, each NUL →
  // `\u0000`), blowing the chunk budget → dropped wholesale, cursor advanced.
  const nulBody = String.fromCharCode(0).repeat(512 * 1024);

  // Precondition: the raw-byte-clamped size WOULD have blown the chunk budget.
  const rawClampSerialized = realSerializedBytes(
    String.fromCharCode(0).repeat(98_304)
  );
  assert.ok(
    rawClampSerialized > COMPONENTS_CHUNK_BYTE_BUDGET,
    `precondition: raw-byte-clamped NUL body serializes to ${rawClampSerialized}B, over the ${COMPONENTS_CHUNK_BYTE_BUDGET}B chunk budget`
  );

  const clamped = clampSyncedComponentContent(nulBody);

  // The clamped body's serialized size fits the serialized budget.
  assert.ok(
    serializedJsonUtf8ByteSize(clamped) <=
      SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES,
    `clamped serialized ${serializedJsonUtf8ByteSize(clamped)}B exceeds serialized budget ${SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES}B`
  );

  // And, crucially, the whole component is NOT dead-lettered by the chunker: it
  // packs into a real chunk, so its existence row reaches the cloud.
  const { chunks, oversized } = chunkComponentsByByteSize([
    componentWith("nul-agent", clamped),
  ]);
  assert.equal(
    oversized.length,
    0,
    "the NUL component fits a sub-cap request → not dropped"
  );
  assert.deepEqual(
    chunks.flat().map((c) => c.externalId),
    ["nul-agent"],
    "existence row is carried in a real chunk"
  );
});

test("clamp bounds every escape class (control / quote / multibyte / lone-surrogate) under the chunk budget", () => {
  const cases: Record<string, string> = {
    // Each control char → 6 serialized bytes.
    controls: String.fromCharCode(1).repeat(512 * 1024),
    // Each quote → 2 serialized bytes.
    quotes: '"'.repeat(512 * 1024),
    // 3-byte UTF-8 scalars.
    multibyte: "日".repeat(512 * 1024),
    // Astral scalars (surrogate PAIRS) — 4 UTF-8 bytes each.
    astral: "😀".repeat(256 * 1024),
    // LONE surrogates — 6 serialized bytes each; the case a TextEncoder measure
    // would undercount, letting the body slip back over budget.
    loneSurrogates: "\uD800".repeat(512 * 1024),
  };

  for (const [label, body] of Object.entries(cases)) {
    const clamped = clampSyncedComponentContent(body);

    // The clamped content's serialized size is within the serialized budget...
    assert.ok(
      serializedJsonUtf8ByteSize(clamped) <=
        SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES,
      `[${label}] clamped serialized ${serializedJsonUtf8ByteSize(clamped)}B exceeds budget`
    );
    // ...and honors the char cap.
    assert.ok(
      clamped.length <= SYNCED_COMPONENT_CONTENT_MAX_CHARS,
      `[${label}] clamped content exceeds char cap`
    );

    // ...so the full component serializes under the chunk byte budget and is not
    // dead-lettered.
    const { oversized } = chunkComponentsByByteSize([
      componentWith(`c-${label}`, clamped),
    ]);
    assert.equal(
      oversized.length,
      0,
      `[${label}] escape-heavy component is not dead-lettered`
    );
  }
});

test("clamp truncates on a codepoint boundary (no split surrogate pair / replacement char)", () => {
  // Fill with 3-byte scalars up to just under the budget, then append an astral
  // (surrogate-pair) emoji whose serialized bytes straddle the boundary. The
  // straddling code point must be dropped WHOLE — never half a surrogate pair,
  // never a U+FFFD replacement.
  const fillCount = Math.floor(
    (SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES - 2) / 3
  );
  const fill = "日".repeat(fillCount);
  const clamped = clampSyncedComponentContent(`${fill}😀`);

  assert.ok(
    serializedJsonUtf8ByteSize(clamped) <=
      SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES
  );
  assert.ok(
    !clamped.includes("�"),
    "no replacement char from a split multibyte codepoint"
  );
  // No lone surrogate at the tail (a split pair would leave a high surrogate).
  const lastCp = clamped.codePointAt(clamped.length - 1) ?? 0;
  assert.ok(
    !(lastCp >= 0xd8_00 && lastCp <= 0xdf_ff),
    "no dangling lone surrogate at the truncation boundary"
  );
});

test("clamp passes small content through unchanged (no re-encode round-trip)", () => {
  const small = '# Agent\n\nA short definition body with "quotes" and 日本語.';
  assert.equal(clampSyncedComponentContent(small), small);
});

test("clamp leaves an escape-heavy body exactly at the serialized budget unchanged", () => {
  // Quotes each cost 2 serialized bytes, so budget/2 quotes serialize to exactly
  // the budget and must pass through unchanged.
  const exact = '"'.repeat(SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES / 2);
  assert.equal(
    serializedJsonUtf8ByteSize(exact),
    SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES
  );
  assert.equal(clampSyncedComponentContent(exact), exact);
});

test("clamp handles a multi-MB body (bounded scan, codepoint-safe outcome)", () => {
  // Local `content` is stored untruncated, so a huge/misnamed file can be
  // arbitrarily large. Guard the OUTCOME: an 8 MiB body still clamps to <= the
  // serialized budget on a codepoint boundary.
  const massive = "z".repeat(8 * 1024 * 1024);
  const clamped = clampSyncedComponentContent(massive);
  assert.ok(
    serializedJsonUtf8ByteSize(clamped) <=
      SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES
  );
  // Pure ASCII → 1 serialized byte/char, so the clamp lands on the budget.
  assert.equal(clamped.length, SYNCED_COMPONENT_CONTENT_MAX_SERIALIZED_BYTES);
});
