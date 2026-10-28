/**
 * Additional branch coverage for the streaming inline-image scanner, targeting
 * arms the sibling `inline-image-request-body.test.ts` suite does not reach:
 * the escaped-character switch inside key decoding, a lowercase hex digit in a
 * `\u` escape, whitespace tolerance around a key's colon and its value, a
 * non-colon character following a key, a non-array `inlineImages` value, and a
 * multi-byte character split across the final stream flush.
 */

import { describe, expect, it } from "vitest";
import { readInlineImageAwareRequestText } from "./inline-image-request-body";

function streamingRequest(text: string, chunkSize = 8): Request {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return { body: stream } as unknown as Request;
}

const read = (text: string, maxBytes: number, chunkSize?: number) =>
  readInlineImageAwareRequestText(streamingRequest(text, chunkSize), maxBytes);

describe("readInlineImageAwareRequestText — escaped key characters", () => {
  it("scans past every single-character JSON escape in a key name without corrupting scanner state", async () => {
    // None of these decode to letters in "inlineImages", so this key never
    // matches the target — the point is exercising decodeJsonSimpleEscape's
    // full switch (", \, /, b, f, n, r, t) without crashing or mis-tracking
    // depth/string state, then confirming the REAL target key right after
    // still matches correctly.
    const escapes = ['"', "\\", "/", "b", "f", "n", "r", "t"];
    const escapedKey = `k${escapes.map((c) => `\\${c}`).join("")}z`;
    const body = `{"${escapedKey}":1,"inlineImages":[{"d":"${"z".repeat(5000)}"}]}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(false);
    expect(result.requestBodyBytes).toBeGreaterThan(100);
  });

  it("resolves a lowercase-letter hex digit inside a \\u escape", async () => {
    // l decodes to "l"; the hex digits "0","0","6","c" exercise the
    // lowercase a-f branch of isJsonHexDigit. If that branch were missing,
    // the escape would abort mid-decode and the key would never assemble
    // into "inlineImages", so the cap would never trip.
    const body = `{"in\\u006cineImages":[{"d":"${"z".repeat(5000)}"}]}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(false);
  });

  it("does not crash or corrupt scanner state on an unrecognized escape in a key name", async () => {
    const body = `{"a\\qz":1,"inlineImages":[{"d":"${"z".repeat(5000)}"}]}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(false);
  });
});

describe("readInlineImageAwareRequestText — whitespace and separator tolerance", () => {
  it("tolerates whitespace between a key's closing quote and its colon", async () => {
    const body = `{"inlineImages" :[{"d":"${"z".repeat(5000)}"}]}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(false);
  });

  it("tolerates whitespace between the colon and the array's opening bracket", async () => {
    const body = `{"inlineImages":   [{"d":"${"z".repeat(5000)}"}]}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(false);
  });

  it("tolerates whitespace between the array's opening bracket and its first element", async () => {
    const body = `{"inlineImages":[ {"d":"${"z".repeat(5000)}"}]}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(false);
  });

  it("does not cap a body whose inlineImages array is genuinely empty despite whitespace before the bracket", async () => {
    // If the whitespace skip before the value starts were missing, the FIRST
    // whitespace character itself would be misread as "a non-array value",
    // tripping the cap on this legitimately empty (and thus non-image-bearing)
    // array — even though the huge `content` field is exactly the case this
    // reader exists to let through uncapped.
    const body = `{"inlineImages":   [],"content":"${"a".repeat(5000)}"}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(true);
  });

  it("does not cap a body whose inlineImages array is empty but has whitespace inside the brackets", async () => {
    // Same failure mode one token later: if the whitespace skip INSIDE the
    // array (before its closing bracket) were missing, that whitespace would
    // be misread as a non-`]` array element, tripping the cap on an array
    // that is actually empty.
    const body = `{"inlineImages":[   ],"content":"${"a".repeat(5000)}"}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(true);
  });

  it("never treats a stray non-colon character as the key/value separator", async () => {
    // Malformed on purpose: no comma resets `expectingTopLevelKey` after the
    // odd `?`, so nothing downstream can be recognized as a top-level key
    // either. The scanner must not mistake the `?` for `:` and start
    // tracking the value regardless.
    const body = `{"inlineImages"?[{"d":"${"z".repeat(5000)}"}]}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(true);
  });
});

describe("readInlineImageAwareRequestText — non-array inlineImages value", () => {
  // pins current behavior; looks odd because scanTargetValueChar sets
  // `matched = true` for ANY non-"[" first character of the value, so a
  // string/number/object value for `inlineImages` trips the same early cap
  // as a real array — even though hasInlineImageInputs (the authoritative
  // post-parse check) requires an actual non-empty array and would say this
  // body has none.
  it("caps a body whose top-level inlineImages value is not an array", async () => {
    const body = `{"inlineImages":"not-an-array","content":"${"a".repeat(5000)}"}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(false);
  });
});

describe("readInlineImageAwareRequestText — decoder flush at stream end", () => {
  it("still returns the trailing character produced by flushing a split multi-byte sequence", async () => {
    // "¬" (U+00AC) encodes as the two bytes 0xC2 0xAC. Enqueueing only the
    // first byte then closing the stream leaves TextDecoder holding an
    // incomplete sequence that only the unconditional final `decode()`
    // flush (with no more bytes ever arriving) resolves — to the U+FFFD
    // replacement character, since the second byte never arrives.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc2]));
        controller.close();
      },
    });

    const result = await readInlineImageAwareRequestText(
      { body: stream } as unknown as Request,
      10_000
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.length).toBeGreaterThan(0);
    expect(result.requestBodyBytes).toBe(1);
  });
});
