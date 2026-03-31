/**
 * Tier-1 compatibility test: readNdjsonLines browser stream parsing.
 *
 * Validates that readNdjsonLines correctly handles all standard NDJSON
 * reading scenarios using a mocked ReadableStream with controlled chunks.
 */
import { describe, expect, it } from "vitest";
import { readNdjsonLines } from "@/lib/engineer/stream-utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeChunks(
  chunks: string[]
): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  const reader: ReadableStreamDefaultReader<Uint8Array> = {
    read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (index >= chunks.length) {
        return Promise.resolve({ done: true, value: undefined });
      }
      const value = encoder.encode(chunks[index++]);
      return Promise.resolve({ done: false, value });
    },
    releaseLock() {},
    cancel(): Promise<void> {
      return Promise.resolve();
    },
    closed: Promise.resolve(undefined),
  };
  return reader;
}

async function collectLines(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readNdjsonLines(reader)) {
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readNdjsonLines", () => {
  it("parses standard NDJSON with one JSON object per line", async () => {
    const chunks = ['{"id":1,"msg":"hello"}\n{"id":2,"msg":"world"}\n'];
    const lines = await collectLines(encodeChunks(chunks));

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1, msg: "hello" });
    expect(JSON.parse(lines[1])).toEqual({ id: 2, msg: "world" });
  });

  it("handles partial chunks (data split across multiple reads)", async () => {
    // First chunk ends mid-object; second chunk completes it and includes another
    const chunks = ['{"id":1,"ms', 'g":"split"}\n{"id":2}\n'];
    const lines = await collectLines(encodeChunks(chunks));

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1, msg: "split" });
    expect(JSON.parse(lines[1])).toEqual({ id: 2 });
  });

  it("handles UTF-8 multi-byte characters", async () => {
    // Multi-byte UTF-8 sequence split across chunk boundary
    const fullLine = '{"msg":"こんにちは"}\n';
    const encoder = new TextEncoder();
    const bytes = encoder.encode(fullLine);
    // Split the byte array in the middle of the UTF-8 sequence
    const splitPoint = Math.floor(bytes.length / 2);
    const chunk1 = bytes.slice(0, splitPoint);
    const chunk2 = bytes.slice(splitPoint);

    let index = 0;
    const chunks = [chunk1, chunk2];
    const reader: ReadableStreamDefaultReader<Uint8Array> = {
      read(): Promise<ReadableStreamReadResult<Uint8Array>> {
        if (index >= chunks.length) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return Promise.resolve({ done: false, value: chunks[index++] });
      },
      releaseLock() {},
      cancel(): Promise<void> {
        return Promise.resolve();
      },
      closed: Promise.resolve(undefined),
    };

    const lines = await collectLines(reader);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ msg: "こんにちは" });
  });

  it("handles empty lines (should be skipped)", async () => {
    const chunks = ['{"id":1}\n\n\n{"id":2}\n'];
    const lines = await collectLines(encodeChunks(chunks));

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1 });
    expect(JSON.parse(lines[1])).toEqual({ id: 2 });
  });

  it("handles trailing content without newline terminator", async () => {
    // Last object is not followed by a newline
    const chunks = ['{"id":1}\n{"id":2}'];
    const lines = await collectLines(encodeChunks(chunks));

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ id: 1 });
    expect(JSON.parse(lines[1])).toEqual({ id: 2 });
  });
});
