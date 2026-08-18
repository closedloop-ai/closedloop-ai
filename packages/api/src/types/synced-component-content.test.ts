import { describe, expect, it } from "vitest";
import { serializedJsonUtf8ByteSize } from "./synced-component-content.ts";

describe("serializedJsonUtf8ByteSize", () => {
  it.each([
    ["plain ascii", 11],
    ["\u00e9", 2],
    ["\u20ac", 3],
    ["\ud83d\ude00", 4],
    ['"', 2],
    ["\\", 2],
    ["\b", 2],
    ["\r", 2],
    ["\0", 6],
    ["\ud800", 6],
  ])("counts %j as %i serialized UTF-8 bytes", (value, expected) => {
    expect(serializedJsonUtf8ByteSize(value)).toBe(expected);
  });

  it("matches the JSON wire representation for mixed escaped and Unicode text", () => {
    const value = 'cafe\u0301 "quoted" \\ \0 \ud83d\ude00 \udfff';
    const serializedWithoutQuotes = JSON.stringify(value).slice(1, -1);

    expect(serializedJsonUtf8ByteSize(value)).toBe(
      Buffer.byteLength(serializedWithoutQuotes, "utf8")
    );
  });
});
