import { describe, expect, it } from "vitest";
import {
  MAX_SIGNAL_PAYLOAD_BYTES,
  parseSignalEnvelope,
  type SignalEnvelope,
  SignalEnvelopeRejection,
  serializeSignalEnvelope,
} from "../signal";
import { SignalTypes } from "../signals";

const ORG = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";

const envelope: SignalEnvelope = {
  c: `comments:${ORG}:artifact-1`,
  t: "thread.updated",
  d: { threadId: "t1", rev: 3 },
  ts: 1_700_000_000_000,
  tp: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
};

function withoutKey(key: keyof SignalEnvelope): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(envelope).filter(([entryKey]) => entryKey !== key)
  );
}

describe("parseSignalEnvelope", () => {
  it("accepts a type that no SignalTypes entry declares", () => {
    const undeclared = {
      ...envelope,
      c: `inbox:${ORG}:u1`,
      t: "never.declared",
    };
    expect(
      Object.values(SignalTypes).some((types) => "never.declared" in types)
    ).toBe(false);
    expect(parseSignalEnvelope(JSON.stringify(undeclared))).toEqual({
      success: true,
      envelope: undeclared,
    });
  });

  it("rejects a malformed type", () => {
    for (const t of ["Thread", "1thread", "", `a${"b".repeat(64)}`]) {
      expect(parseSignalEnvelope(JSON.stringify({ ...envelope, t }))).toEqual({
        success: false,
        reason: SignalEnvelopeRejection.Malformed,
      });
    }
  });

  it("rejects a missing field", () => {
    for (const key of ["c", "t", "d", "ts"] as const) {
      expect(parseSignalEnvelope(JSON.stringify(withoutKey(key))).success).toBe(
        false
      );
    }
    expect(parseSignalEnvelope(JSON.stringify(withoutKey("tp"))).success).toBe(
      true
    );
  });

  it("rejects a malformed channel address and non-JSON input", () => {
    expect(
      parseSignalEnvelope(JSON.stringify({ ...envelope, c: "comments:x:y" }))
        .success
    ).toBe(false);
    expect(parseSignalEnvelope("{not json")).toEqual({
      success: false,
      reason: SignalEnvelopeRejection.Malformed,
    });
  });

  it("rejects an oversized payload, measured in UTF-8 bytes", () => {
    const base = JSON.stringify({ ...envelope, d: { pad: "" } });
    const room = MAX_SIGNAL_PAYLOAD_BYTES - base.length;
    const atLimit = JSON.stringify({
      ...envelope,
      d: { pad: "a".repeat(room) },
    });
    expect(atLimit.length).toBe(MAX_SIGNAL_PAYLOAD_BYTES);
    expect(parseSignalEnvelope(atLimit).success).toBe(true);
    // Same character count, one extra UTF-8 byte.
    const multiByte = JSON.stringify({
      ...envelope,
      d: { pad: `é${"a".repeat(room - 1)}` },
    });
    expect(multiByte.length).toBe(MAX_SIGNAL_PAYLOAD_BYTES);
    expect(parseSignalEnvelope(multiByte)).toEqual({
      success: false,
      reason: SignalEnvelopeRejection.PayloadTooLarge,
    });
  });
});

describe("serializeSignalEnvelope", () => {
  it("serializes a valid envelope that parses back unchanged", () => {
    expect(parseSignalEnvelope(serializeSignalEnvelope(envelope))).toEqual({
      success: true,
      envelope,
    });
  });

  it("throws on an oversized payload", () => {
    expect(() =>
      serializeSignalEnvelope({
        ...envelope,
        d: { pad: "a".repeat(MAX_SIGNAL_PAYLOAD_BYTES) },
      })
    ).toThrow(String(MAX_SIGNAL_PAYLOAD_BYTES));
  });
});
