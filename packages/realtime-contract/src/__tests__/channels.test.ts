import { describe, expect, it } from "vitest";
import {
  ChannelKind,
  formatChannelAddress,
  isChannelOrgId,
  MAX_CHANNEL_ADDRESS_BYTES,
  parseChannelAddress,
} from "../channels";

const ORG = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";

describe("parseChannelAddress", () => {
  it("accepts a kind that is not in ChannelKind", () => {
    expect(parseChannelAddress(`presence:${ORG}:doc:abc_1`)).toEqual({
      kind: "presence",
      orgId: ORG,
      scope: ["doc", "abc_1"],
    });
  });

  it("rejects a bad kind", () => {
    for (const kind of ["Comments", "1abc", "", "a".repeat(33), "a_b"]) {
      expect(parseChannelAddress(`${kind}:${ORG}:x`)).toBeNull();
    }
  });

  it("rejects a bad org", () => {
    expect(parseChannelAddress("comments:not-a-uuid:x")).toBeNull();
    expect(parseChannelAddress("comments::x")).toBeNull();
  });

  it("rejects an uppercase org so each channel has one spelling", () => {
    expect(parseChannelAddress(`comments:${ORG}:x`)).not.toBeNull();
    expect(parseChannelAddress(`comments:${ORG.toUpperCase()}:x`)).toBeNull();
  });

  it("rejects an empty scope", () => {
    expect(parseChannelAddress(`comments:${ORG}`)).toBeNull();
    expect(parseChannelAddress(`comments:${ORG}:`)).toBeNull();
    expect(parseChannelAddress(`comments:${ORG}:a::b`)).toBeNull();
  });

  it("rejects an oversize segment", () => {
    expect(
      parseChannelAddress(`comments:${ORG}:${"a".repeat(128)}`)
    ).not.toBeNull();
    expect(
      parseChannelAddress(`comments:${ORG}:${"a".repeat(129)}`)
    ).toBeNull();
  });

  it("rejects an oversize address", () => {
    const prefix = `comments:${ORG}:`;
    const segment = "a".repeat(100);
    const atLimit = `${prefix}${segment}:${"b".repeat(
      MAX_CHANNEL_ADDRESS_BYTES - prefix.length - segment.length - 1
    )}`;
    expect(atLimit.length).toBe(MAX_CHANNEL_ADDRESS_BYTES);
    expect(parseChannelAddress(atLimit)).not.toBeNull();
    expect(parseChannelAddress(`${atLimit}b`)).toBeNull();
  });
});

describe("formatChannelAddress", () => {
  it("round-trips with parseChannelAddress for comments", () => {
    const address = formatChannelAddress(ChannelKind.Comments, ORG, [
      "artifact-1",
    ]);
    expect(parseChannelAddress(address)).toEqual({
      kind: ChannelKind.Comments,
      orgId: ORG,
      scope: ["artifact-1"],
    });
  });

  it("round-trips with parseChannelAddress for a document", () => {
    const address = formatChannelAddress(ChannelKind.Document, ORG, ["PLN-1"]);
    expect(parseChannelAddress(address)).toEqual({
      kind: ChannelKind.Document,
      orgId: ORG,
      scope: ["PLN-1"],
    });
  });

  it("throws rather than produce a malformed address", () => {
    expect(() =>
      formatChannelAddress(ChannelKind.Comments, "org", ["x"])
    ).toThrow();
    expect(() => formatChannelAddress(ChannelKind.Comments, ORG, [])).toThrow();
  });
});

describe("isChannelOrgId", () => {
  it("accepts exactly the org ids parseChannelAddress accepts", () => {
    for (const orgId of [ORG, ORG.toUpperCase(), "not-a-uuid", ""]) {
      expect(isChannelOrgId(orgId)).toBe(
        parseChannelAddress(`comments:${orgId}:x`) !== null
      );
    }
    expect(isChannelOrgId(ORG)).toBe(true);
  });
});
