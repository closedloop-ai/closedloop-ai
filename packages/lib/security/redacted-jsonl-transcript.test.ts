import { describe, expect, it } from "vitest";
import {
  RedactedJsonlTranscriptByteAdapter,
  RedactedJsonlTranscriptLineTooLongError,
  redactJsonlTranscriptByteChunks,
} from "./redacted-jsonl-transcript.js";

const A32 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("redacted JSONL transcript bytes", () => {
  it("redacts synthetic secret-shaped text split across input chunks", () => {
    const adapter = new RedactedJsonlTranscriptByteAdapter();
    const input = JSON.stringify({
      type: "assistant",
      message: `token sk_live_${A32} done`,
    });

    const chunks = [
      ...adapter.write(encoder.encode(input.slice(0, 35))),
      ...adapter.write(encoder.encode(`${input.slice(35)}\n`)),
    ];

    const output = decodeChunks(chunks);
    expect(output).toContain("[REDACTED:sk_live]");
    expect(output).not.toContain(A32);
    expect(JSON.parse(output)).toMatchObject({
      type: "assistant",
      message: "token [REDACTED:sk_live] done",
    });
  });

  it("emits complete lines and defers a partial trailing line", () => {
    const adapter = new RedactedJsonlTranscriptByteAdapter();
    const complete = JSON.stringify({ fileKey: "main", text: "ready" });
    const partial = JSON.stringify({
      fileKey: "subagent:agent-1.jsonl",
      text: `pending ghp_${A32}0000`,
    });

    const chunks = adapter.write(encoder.encode(`${complete}\n${partial}`));
    const flushed = adapter.flush();

    expect(decodeChunks(chunks)).toBe(`${complete}\n`);
    expect(flushed).toEqual({ chunks: [], droppedPartial: true });
    expect(decodeChunks(chunks)).not.toContain("[REDACTED:ghp]");
    expect(JSON.stringify(flushed)).not.toContain(A32);
  });

  it("redacts the deferred line after its newline arrives", () => {
    const adapter = new RedactedJsonlTranscriptByteAdapter();
    const line = JSON.stringify({
      fileKey: "subagent:agent-1.jsonl",
      text: `pending ghp_${A32}0000`,
    });

    expect(adapter.write(encoder.encode(line))).toEqual([]);
    const chunks = adapter.write(encoder.encode("\n"));

    const output = decodeChunks(chunks);
    expect(output).toContain("[REDACTED:ghp]");
    expect(output).not.toContain(A32);
    expect(JSON.parse(output)).toMatchObject({
      fileKey: "subagent:agent-1.jsonl",
      text: "pending [REDACTED:ghp]",
    });
  });

  it("preserves parseable JSONL for multiple complete lines per chunk", () => {
    const inputLines = [
      { fileKey: "main", text: `Bearer ${A32}${A32}` },
      { fileKey: "subagent:agent-2.jsonl", text: "ordinary prose" },
    ];
    const adapter = new RedactedJsonlTranscriptByteAdapter();

    const output = decodeChunks(
      adapter.write(
        encoder.encode(
          `${inputLines.map((line) => JSON.stringify(line)).join("\n")}\n`
        )
      )
    );

    const parsed = output
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { fileKey: string; text: string });
    expect(parsed).toEqual([
      { fileKey: "main", text: "Bearer [REDACTED:bearer]" },
      { fileKey: "subagent:agent-2.jsonl", text: "ordinary prose" },
    ]);
  });

  it("preserves parseable JSONL for one line spanning many chunks", () => {
    const adapter = new RedactedJsonlTranscriptByteAdapter();
    const line = JSON.stringify({
      fileKey: "main",
      text: `one long token ghp_${A32}0000`,
    });

    const chunks = Array.from(`${line}\n`, (character) =>
      adapter.write(encoder.encode(character))
    ).flat();

    const output = decodeChunks(chunks);
    expect(output).toBe(
      `${JSON.stringify({
        fileKey: "main",
        text: "one long token [REDACTED:ghp]",
      })}\n`
    );
    expect(output).not.toContain(A32);
    expect(JSON.parse(output)).toMatchObject({
      fileKey: "main",
      text: "one long token [REDACTED:ghp]",
    });
  });

  it("handles UTF-8 byte boundaries without corrupting transcript text", () => {
    const adapter = new RedactedJsonlTranscriptByteAdapter();
    const line = JSON.stringify({
      fileKey: "main",
      text: `snowman ☃ sk_test_${A32}`,
    });
    const bytes = encoder.encode(`${line}\n`);
    const splitInsideSnowman = line.indexOf("☃");
    const splitAt =
      encoder.encode(line.slice(0, splitInsideSnowman + 1)).length - 1;

    const chunks = [
      ...adapter.write(bytes.slice(0, splitAt)),
      ...adapter.write(bytes.slice(splitAt)),
    ];

    const output = decodeChunks(chunks);
    expect(output).toContain("snowman ☃ [REDACTED:sk_test]");
    expect(output).not.toContain("\uFFFD");
    expect(output).not.toContain(A32);
    expect(JSON.parse(output)).toMatchObject({
      fileKey: "main",
      text: "snowman ☃ [REDACTED:sk_test]",
    });
  });

  it("throws when a partial line exceeds the byte ceiling", () => {
    const adapter = new RedactedJsonlTranscriptByteAdapter({
      maxLineBytes: 8,
    });

    expect(() => adapter.write(encoder.encode("abcdefghi"))).toThrow(
      RangeError
    );
  });

  it("throws when a complete line exceeds the byte ceiling", () => {
    const adapter = new RedactedJsonlTranscriptByteAdapter({
      maxLineBytes: 8,
    });

    expect(() => adapter.write(encoder.encode("abcdefghi\n"))).toThrow(
      RangeError
    );
  });

  it("attaches already-redacted chunks when a later partial line exceeds the byte ceiling", () => {
    const complete = JSON.stringify({ text: `ghp_${A32}0000` });
    const adapter = new RedactedJsonlTranscriptByteAdapter({
      maxLineBytes: encoder.encode(`${complete}\n`).byteLength,
    });
    const partial = "x".repeat(encoder.encode(`${complete}\n`).byteLength + 1);

    try {
      adapter.write(encoder.encode(`${complete}\n${partial}`));
      throw new Error("Expected oversized partial line to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RedactedJsonlTranscriptLineTooLongError);
      const output = decodeChunks(
        (error as RedactedJsonlTranscriptLineTooLongError).chunks
      );
      expect(output).toBe(`${JSON.stringify({ text: "[REDACTED:ghp]" })}\n`);
      expect(output).not.toContain(A32);
    }
  });

  it("attaches already-redacted chunks when a later complete line exceeds the byte ceiling", () => {
    const complete = JSON.stringify({ text: `ghp_${A32}0000` });
    const adapter = new RedactedJsonlTranscriptByteAdapter({
      maxLineBytes: encoder.encode(`${complete}\n`).byteLength,
    });

    try {
      adapter.write(
        encoder.encode(
          `${complete}\n${"x".repeat(encoder.encode(`${complete}\n`).byteLength)}\n`
        )
      );
      throw new Error("Expected oversized complete line to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RedactedJsonlTranscriptLineTooLongError);
      const output = decodeChunks(
        (error as RedactedJsonlTranscriptLineTooLongError).chunks
      );
      expect(output).toBe(`${JSON.stringify({ text: "[REDACTED:ghp]" })}\n`);
      expect(output).not.toContain(A32);
    }
  });

  it("requires a positive safe integer byte ceiling", () => {
    expect(
      () => new RedactedJsonlTranscriptByteAdapter({ maxLineBytes: 0 })
    ).toThrow(RangeError);
  });

  it("can resume with later complete lines after an oversized partial line", () => {
    const adapter = new RedactedJsonlTranscriptByteAdapter({
      maxLineBytes: 8,
    });

    expect(() => adapter.write(encoder.encode("abcdefghi"))).toThrow(
      RangeError
    );

    const output = decodeChunks(adapter.write(encoder.encode("ok\n")));
    expect(output).toBe("ok\n");
  });

  it("flush() calls consumeText when the decoder has buffered an incomplete multi-byte sequence", () => {
    // Writing only the first byte of a 3-byte "€" (U+20AC) leaves the decoder with
    // a buffered incomplete sequence. flush() calls decoder.decode() which produces
    // the replacement char "�" (non-empty) → consumeText is invoked (branch 5
    // arm 0 = truthy finalText). No complete JSONL line → droppedPartial is true.
    const adapter = new RedactedJsonlTranscriptByteAdapter();
    const euroBytes = encoder.encode("€"); // [0xE2, 0x82, 0xAC]
    adapter.write(euroBytes.slice(0, 1)); // stream only first byte
    const flushed = adapter.flush();
    expect(flushed.chunks).toEqual([]);
    expect(flushed.droppedPartial).toBe(true);
  });

  it("write() with an empty chunk emits nothing and leaves the pending buffer intact", () => {
    // Not a test of `consumeText`'s `if (!text) return []` short-circuit: that
    // guard is unfalsifiable. With `text === ""` the fall-through appends
    // nothing, finds no newline, and returns the same empty array with the same
    // pending state, so removing the guard changes no output for any input.
    // What IS observable — and what this pins — is that an interleaved empty
    // write does not disturb a partial line already buffered.
    const adapter = new RedactedJsonlTranscriptByteAdapter();
    const encoder = new TextEncoder();
    const line = JSON.stringify({ text: `xoxb-1234567890-${A32}` });

    expect(adapter.write(encoder.encode(line))).toEqual([]);
    expect(adapter.write(new Uint8Array(0))).toEqual([]);

    // The buffered partial survived the empty write and completes normally.
    const completed = decodeChunks(adapter.write(encoder.encode("\n")));
    expect(completed).toBe(
      `${JSON.stringify({ text: "[REDACTED:slack_token]" })}\n`
    );
    expect(completed).not.toContain(A32);
  });

  it("streams redacted complete lines from async iterables", async () => {
    const first = JSON.stringify({ text: `xoxb-1234567890-${A32}` });
    const second = JSON.stringify({ text: `partial whsec_${A32}` });

    const output = decodeChunks(
      await collectAsync(
        redactJsonlTranscriptByteChunks([
          encoder.encode(`${first}\n${second.slice(0, 10)}`),
          encoder.encode(second.slice(10)),
        ])
      )
    );

    expect(output).toBe(
      `${JSON.stringify({ text: "[REDACTED:slack_token]" })}\n`
    );
    expect(output).not.toContain("[REDACTED:whsec]");
    expect(output).not.toContain(A32);
  });
});

function decodeChunks(chunks: Uint8Array[]): string {
  return chunks.map((chunk) => decoder.decode(chunk)).join("");
}

async function collectAsync(
  chunks: AsyncIterable<Uint8Array>
): Promise<Uint8Array[]> {
  const collected: Uint8Array[] = [];
  for await (const chunk of chunks) {
    collected.push(chunk);
  }
  return collected;
}
