import assert from "node:assert/strict";
import { test } from "vitest";
import { byteLengthOfResponseChunk } from "../src/server/response-size.js";

test("byteLengthOfResponseChunk: string uses utf8 by default", () => {
  assert.equal(byteLengthOfResponseChunk("hello", undefined), 5);
});

test("byteLengthOfResponseChunk: string respects encoding argument", () => {
  assert.equal(byteLengthOfResponseChunk("hello", "utf16le"), 10);
});

test("byteLengthOfResponseChunk: non-string encoding is treated as utf8", () => {
  assert.equal(byteLengthOfResponseChunk("hello", 42), 5);
});

test("byteLengthOfResponseChunk: Buffer returns byteLength", () => {
  const buf = Buffer.from("hello");
  assert.equal(byteLengthOfResponseChunk(buf, undefined), 5);
});

test("byteLengthOfResponseChunk: Uint8Array returns byteLength", () => {
  const arr = new Uint8Array([1, 2, 3, 4]);
  assert.equal(byteLengthOfResponseChunk(arr, undefined), 4);
});

test("byteLengthOfResponseChunk: null returns 0", () => {
  assert.equal(byteLengthOfResponseChunk(null, undefined), 0);
});

test("byteLengthOfResponseChunk: undefined returns 0", () => {
  assert.equal(byteLengthOfResponseChunk(undefined, undefined), 0);
});

test("byteLengthOfResponseChunk: number returns 0", () => {
  assert.equal(byteLengthOfResponseChunk(42, undefined), 0);
});

test("byteLengthOfResponseChunk: object returns 0", () => {
  assert.equal(byteLengthOfResponseChunk({}, undefined), 0);
});

test("byteLengthOfResponseChunk: empty string returns 0", () => {
  assert.equal(byteLengthOfResponseChunk("", undefined), 0);
});

test("byteLengthOfResponseChunk: multi-byte utf8 string", () => {
  assert.equal(byteLengthOfResponseChunk("é", undefined), 2);
});
