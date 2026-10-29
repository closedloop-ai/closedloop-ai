import { describe, expect, it } from "vitest";
import {
  BusOp,
  busMessageSchema,
  internalPublishBodySchema,
  revokeTargetSchema,
} from "../internal";
import { MAX_SIGNAL_PAYLOAD_BYTES } from "../signal";

const ORG = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
/** A kind and type nothing declares: the service passes both through. */
const PROBE = `probe:${ORG}:x`;

describe("internalPublishBodySchema", () => {
  const body = { channel: PROBE, type: "probe.fired", data: { id: "x1" } };

  it("accepts an undeclared kind and type", () => {
    expect(internalPublishBodySchema.parse(body)).toEqual(body);
  });

  it("holds the serialized body to the signal byte cap, inclusive", () => {
    const overhead = JSON.stringify({ ...body, data: { id: "" } }).length;
    const atCap = {
      ...body,
      data: { id: "x".repeat(MAX_SIGNAL_PAYLOAD_BYTES - overhead) },
    };
    const overCap = {
      ...body,
      data: { id: "x".repeat(MAX_SIGNAL_PAYLOAD_BYTES - overhead + 1) },
    };

    expect(internalPublishBodySchema.safeParse(atCap).success).toBe(true);
    expect(internalPublishBodySchema.safeParse(overCap).success).toBe(false);
  });

  it.each([
    ["a malformed address", { ...body, channel: "probe:not-an-org:x" }],
    ["a malformed type", { ...body, type: "Probe" }],
  ])("refuses %s", (_name, candidate) => {
    expect(internalPublishBodySchema.safeParse(candidate).success).toBe(false);
  });
});

describe("revokeTargetSchema", () => {
  it.each([{ userId: "user_1" }, { channel: PROBE }, { orgId: ORG }])(
    "accepts %j",
    (target) => {
      expect(revokeTargetSchema.parse(target)).toEqual(target);
    }
  );

  it.each([
    ["two targets", { userId: "user_1", orgId: ORG }],
    ["no target", {}],
    ["an uppercase org", { orgId: ORG.toUpperCase() }],
    ["a malformed channel", { channel: "probe:x" }],
    ["an empty user", { userId: "" }],
  ])("refuses %s", (_name, target) => {
    expect(revokeTargetSchema.safeParse(target).success).toBe(false);
  });
});

describe("busMessageSchema", () => {
  it("reads both operations back from their JSON", () => {
    const publish = {
      op: BusOp.Publish,
      channel: PROBE,
      type: "probe.fired",
      data: [1, "two"],
    };
    const revoke = { op: BusOp.Revoke, target: { userId: "user_1" } };

    expect(busMessageSchema.parse(JSON.parse(JSON.stringify(publish)))).toEqual(
      publish
    );
    expect(busMessageSchema.parse(JSON.parse(JSON.stringify(revoke)))).toEqual(
      revoke
    );
    expect(busMessageSchema.safeParse({ op: "replay" }).success).toBe(false);
  });
});
