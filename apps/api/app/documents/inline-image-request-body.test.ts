/**
 * Coverage for the inline-image-aware request reader.
 *
 * The contract is narrow and easy to get wrong: the byte cap applies ONLY once a
 * top-level, non-empty `inlineImages` array has actually been observed. A
 * content-only document request may legitimately be large and must not be
 * rejected; an image-bearing one must be cut off before base64 consumes
 * unbounded memory. That is why this ships a real streaming JSON scanner rather
 * than a substring test — and the cases below are the ones a substring test
 * would get wrong.
 */

import { describe, expect, it } from "vitest";
import {
  hasInlineImageInputs,
  readInlineImageAwareRequestText,
} from "./inline-image-request-body";

/** A Request whose body streams `text` in fixed-size chunks, so the scanner is
 *  exercised across chunk boundaries rather than seeing one buffer. */
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

describe("hasInlineImageInputs", () => {
  it("is true only for a non-empty inlineImages array", () => {
    expect(
      hasInlineImageInputs({ inlineImages: [{ filename: "a.png" }] })
    ).toBe(true);
  });

  it("is false for an empty array, a missing key, or a non-array value", () => {
    expect(hasInlineImageInputs({ inlineImages: [] })).toBe(false);
    expect(hasInlineImageInputs({ content: "x" })).toBe(false);
    expect(hasInlineImageInputs({ inlineImages: "nope" })).toBe(false);
  });

  it("is false for values that are not plain objects", () => {
    expect(hasInlineImageInputs(null)).toBe(false);
    expect(hasInlineImageInputs(undefined)).toBe(false);
    expect(hasInlineImageInputs("string")).toBe(false);
    // An array is typeof "object" — the guard must reject it explicitly.
    expect(hasInlineImageInputs([{ inlineImages: [1] }])).toBe(false);
  });
});

describe("readInlineImageAwareRequestText — bodyless and small requests", () => {
  it("returns an empty value when the request has no body", async () => {
    const result = await readInlineImageAwareRequestText(
      { body: null } as unknown as Request,
      10
    );

    expect(result).toEqual({ ok: true, requestBodyBytes: 0, value: "" });
  });

  it("reassembles a body split across chunk boundaries", async () => {
    const body = JSON.stringify({ content: "hello world", title: "doc" });
    const result = await read(body, 10_000, 3);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(body);
    expect(result.requestBodyBytes).toBe(
      new TextEncoder().encode(body).byteLength
    );
  });
});

describe("readInlineImageAwareRequestText — the cap is conditional", () => {
  it("does NOT cap a large body with no inlineImages key", async () => {
    // The whole point: a legacy content-only request may exceed the cap and
    // must still be read in full.
    const body = JSON.stringify({ content: "x".repeat(5000) });

    const result = await read(body, 100);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(body);
    expect(result.requestBodyBytes).toBeGreaterThan(100);
  });

  it("does NOT cap when inlineImages is present but EMPTY", async () => {
    // An empty array is not an image-bearing request, so the cap stays off.
    const body = JSON.stringify({
      inlineImages: [],
      content: "y".repeat(5000),
    });

    const result = await read(body, 100);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(body);
  });

  it("DOES cap once a non-empty top-level inlineImages array is observed", async () => {
    const body = JSON.stringify({
      inlineImages: [{ dataBase64: "z".repeat(5000) }],
    });

    const result = await read(body, 100);

    expect(result.ok).toBe(false);
    expect(result.requestBodyBytes).toBeGreaterThan(100);
  });

  it("still returns ok when an image-bearing body stays under the cap", async () => {
    const body = JSON.stringify({ inlineImages: [{ filename: "a.png" }] });

    const result = await read(body, 10_000);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(body);
  });
});

describe("readInlineImageAwareRequestText — only a TOP-LEVEL key counts", () => {
  it("ignores an inlineImages key nested inside another object", async () => {
    // A substring match would cap this; the scanner must not, because the
    // top-level request carries no images.
    const body = JSON.stringify({
      metadata: { inlineImages: [{ dataBase64: "q".repeat(5000) }] },
    });

    const result = await read(body, 100);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(body);
  });

  it("ignores an inlineImages key nested inside an array element", async () => {
    const body = JSON.stringify({
      blocks: [{ inlineImages: [{ dataBase64: "q".repeat(5000) }] }],
    });

    const result = await read(body, 100);

    expect(result.ok).toBe(true);
  });

  it("ignores the literal text appearing inside a string VALUE", async () => {
    const body = JSON.stringify({
      content: `talking about "inlineImages": [1] ${"w".repeat(5000)}`,
    });

    const result = await read(body, 100);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(body);
  });

  it("matches a top-level key that follows another top-level key", async () => {
    const body = JSON.stringify({
      content: "short",
      inlineImages: [{ dataBase64: "z".repeat(5000) }],
    });

    const result = await read(body, 100);

    expect(result.ok).toBe(false);
  });

  it("matches a top-level key that follows a nested object", async () => {
    // Depth must return to 1 for the key to be seen as top-level.
    const body = JSON.stringify({
      metadata: { nested: { deep: true } },
      inlineImages: [{ dataBase64: "z".repeat(5000) }],
    });

    const result = await read(body, 100);

    expect(result.ok).toBe(false);
  });
});

describe("readInlineImageAwareRequestText — JSON string escapes in the key", () => {
  it("decodes a non-standard escape to the bare character, so the key still matches", async () => {
    // `\s` is not a standard JSON escape, and decodeJsonSimpleEscape falls
    // through to the character itself — so `"inlineImage\s"` decodes to
    // `inlineImages` and IS the target. Pinned because it means the cap cannot
    // be dodged by escaping a letter of the key.
    const body = `{"inlineImage\\s":[{"d":"${"z".repeat(5000)}"}]}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(false);
  });

  it("does not match a key that differs after escape decoding", async () => {
    const body = `{"inlineImagez":[1],"content":"${"a".repeat(5000)}"}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(true);
  });

  it("resolves a \\u escape so an obfuscated key still matches", async () => {
    // `i` is `i` — the same key spelled to defeat a substring match.
    const body = `{"\\u0069nlineImages":[{"d":"${"z".repeat(5000)}"}]}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(false);
  });

  it("does not crash on a malformed \\u escape", async () => {
    const body = `{"\\uZZZZinlineImages":[1],"content":"${"a".repeat(2000)}"}`;

    const result = await read(body, 100);

    expect(result.ok).toBe(true);
  });

  it("handles an escaped quote inside a string value", async () => {
    const body = JSON.stringify({
      content: 'he said "inlineImages" once',
      title: "t",
    });

    const result = await read(body, 10_000);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(body);
  });
});

describe("readInlineImageAwareRequestText — reader failure", () => {
  it("degrades to the bytes read so far rather than throwing", async () => {
    // A mid-stream transport error must not turn a document save into a 500;
    // the caller gets what arrived and parses (or fails) on its own terms.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"content":"partial'));
      },
      pull() {
        throw new Error("stream broke");
      },
    });

    const result = await readInlineImageAwareRequestText(
      { body: stream } as unknown as Request,
      10_000
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toContain("partial");
  });
});
