/**
 * Unit tests for readNdjsonLines — the shared NDJSON AsyncGenerator.
 *
 * Verifies correct line parsing including partial lines split across chunks,
 * blank line skipping, and trailing data without a newline terminator.
 */

import { describe, expect, it } from "vitest";
import { readNdjsonLines } from "../stream-utils";

// ---------------------------------------------------------------------------
// Test helper: build a ReadableStreamDefaultReader from string chunks
// ---------------------------------------------------------------------------

function makeReader(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const encoded = chunks.map((c) => encoder.encode(c));
  let index = 0;

  return {
    read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      if (index >= encoded.length) {
        return Promise.resolve({ done: true, value: undefined });
      }
      return Promise.resolve({ done: false, value: encoded[index++] });
    },
    releaseLock() {},
    cancel() {
      return Promise.resolve();
    },
    get closed() {
      return Promise.resolve();
    },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

async function collectLines(chunks: string[]): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of readNdjsonLines(makeReader(chunks))) {
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readNdjsonLines", () => {
  it("yields complete newline-terminated lines from a single chunk", async () => {
    const lines = await collectLines(['{"a":1}\n{"b":2}\n']);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("re-assembles a line split across two chunks", async () => {
    const lines = await collectLines(['{"par', 'tial":true}\n']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('{"partial":true}');
  });

  it("yields trailing content without a newline terminator", async () => {
    const lines = await collectLines(['{"a":1}\n', '{"trailing":true}']);
    expect(lines).toEqual(['{"a":1}', '{"trailing":true}']);
  });

  it("skips blank lines between JSON objects", async () => {
    const lines = await collectLines(['{"a":1}\n\n{"b":2}\n']);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("handles a single chunk with many lines separated by newlines", async () => {
    const input = Array.from({ length: 5 }, (_, i) => `{"i":${i}}`).join("\n");
    const lines = await collectLines([`${input}\n`]);
    expect(lines).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(lines[i]).toBe(`{"i":${i}}`);
    }
  });

  it("trims whitespace from yielded lines", async () => {
    const lines = await collectLines(['  {"x":1}  \n']);
    expect(lines[0]).toBe('{"x":1}');
  });

  it("yields nothing for an empty stream", async () => {
    const lines = await collectLines([]);
    expect(lines).toEqual([]);
  });

  it("re-assembles a line split across three chunks", async () => {
    const lines = await collectLines(["{", '"key":', '"value"}\n']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('{"key":"value"}');
  });

  it("handles multiple lines from multiple chunks correctly", async () => {
    const lines = await collectLines(['{"a":1}\n{"b":', "2}\n", '{"c":3}\n']);
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});
