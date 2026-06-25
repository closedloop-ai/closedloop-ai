import { describe, expect, it } from "vitest";
import {
  isRecord,
  normalizeMethod,
  parseRelayResponseEnvelope,
  type RelayEncodedBody,
  splitPathAndQuery,
  unwrapRelayBody,
} from "../relay-request-model";

const UNSUPPORTED_METHOD_RE = /Unsupported relay method/;

describe("normalizeMethod", () => {
  const cases: { input: string; expected: string }[] = [
    { input: "get", expected: "GET" },
    { input: "Post", expected: "POST" },
    { input: "PUT", expected: "PUT" },
    { input: "patch", expected: "PATCH" },
    { input: "delete", expected: "DELETE" },
  ];

  it.each(cases)("normalizes $input -> $expected", ({ input, expected }) => {
    expect(normalizeMethod(input)).toBe(expected);
  });

  it.each([
    "HEAD",
    "OPTIONS",
    "TRACE",
    "",
  ])("throws on unsupported method %s", (method) => {
    expect(() => normalizeMethod(method)).toThrow(UNSUPPORTED_METHOD_RE);
  });
});

describe("splitPathAndQuery", () => {
  it("returns only the path when there is no query string", () => {
    expect(splitPathAndQuery("/api/gateway/health")).toEqual({
      path: "/api/gateway/health",
    });
  });

  it("parses a single-valued query param", () => {
    expect(splitPathAndQuery("/api/gateway/x?a=1")).toEqual({
      path: "/api/gateway/x",
      query: { a: "1" },
    });
  });

  it("collapses repeated params into an array, keeps singles scalar", () => {
    expect(splitPathAndQuery("/api/gateway/x?a=1&a=2&b=3")).toEqual({
      path: "/api/gateway/x",
      query: { a: ["1", "2"], b: "3" },
    });
  });

  it("decodes percent-encoded values", () => {
    expect(splitPathAndQuery("/api/gateway/x?q=a%20b")).toEqual({
      path: "/api/gateway/x",
      query: { q: "a b" },
    });
  });
});

describe("parseRelayResponseEnvelope", () => {
  it("parses the relay { status, body } shape", () => {
    expect(
      parseRelayResponseEnvelope({ status: 200, body: { ok: true } })
    ).toEqual({ status: 200, body: { ok: true }, headers: undefined });
  });

  it("parses the electron { statusCode, data } shape", () => {
    expect(
      parseRelayResponseEnvelope({ statusCode: 404, data: { error: "x" } })
    ).toEqual({ status: 404, body: { error: "x" }, headers: undefined });
  });

  it("keeps headers only when every value is a string", () => {
    expect(
      parseRelayResponseEnvelope({
        status: 200,
        body: {},
        headers: { a: "1", b: "2" },
      })?.headers
    ).toEqual({ a: "1", b: "2" });
    expect(
      parseRelayResponseEnvelope({
        status: 200,
        body: {},
        headers: { a: "1", b: 2 },
      })?.headers
    ).toBeUndefined();
  });

  it.each([
    null,
    42,
    "str",
    [],
    { status: 200 }, // missing body
    { body: {} }, // missing status
  ])("returns null for non-envelope input %o", (value) => {
    expect(parseRelayResponseEnvelope(value)).toBeNull();
  });
});

describe("unwrapRelayBody", () => {
  const cases: { body: RelayEncodedBody; expected: unknown }[] = [
    { body: { kind: "none" }, expected: undefined },
    { body: { kind: "json", value: { a: 1 } }, expected: { a: 1 } },
    {
      body: { kind: "text", value: "hi", contentType: "text/plain" },
      expected: "hi",
    },
    {
      body: { kind: "base64", value: "AAAA", contentType: null },
      expected: "AAAA",
    },
  ];

  it.each(cases)("unwraps $body.kind", ({ body, expected }) => {
    expect(unwrapRelayBody(body)).toEqual(expected);
  });
});

describe("isRecord", () => {
  it.each([
    { value: {}, expected: true },
    { value: { a: 1 }, expected: true },
    { value: [], expected: false },
    { value: null, expected: false },
    { value: "x", expected: false },
    { value: 1, expected: false },
  ])("isRecord($value) === $expected", ({ value, expected }) => {
    expect(isRecord(value)).toBe(expected);
  });
});
