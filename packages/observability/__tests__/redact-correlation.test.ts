import { describe, expect, it } from "vitest";
import {
  redactGatewaySessionId,
  redactTraceGatewaySessionId,
  SHORT_HASH_PATTERN,
} from "../redact-correlation";

const RAW_GATEWAY_SESSION_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

describe("redactGatewaySessionId", () => {
  it("returns null when there is no session id", () => {
    expect(redactGatewaySessionId(null)).toBeNull();
    expect(redactGatewaySessionId(undefined)).toBeNull();
  });

  it("hashes a session id to a short hex digest, never the raw value", () => {
    const hashed = redactGatewaySessionId(RAW_GATEWAY_SESSION_ID);
    expect(hashed).toMatch(SHORT_HASH_PATTERN);
    expect(hashed).not.toBe(RAW_GATEWAY_SESSION_ID);
  });

  it("is stable for the same input so logs stay correlatable", () => {
    const raw = "session-stable";
    expect(redactGatewaySessionId(raw)).toBe(redactGatewaySessionId(raw));
  });
});

describe("redactTraceGatewaySessionId", () => {
  it("replaces a raw gatewaySessionId with its stable hash, leaving other fields", () => {
    const redacted = redactTraceGatewaySessionId({
      commandId: "cmd-1",
      computeTargetId: "target-1",
      gatewaySessionId: RAW_GATEWAY_SESSION_ID,
    });

    expect(redacted.gatewaySessionId).toBe(
      redactGatewaySessionId(RAW_GATEWAY_SESSION_ID)
    );
    expect(redacted.gatewaySessionId).toMatch(SHORT_HASH_PATTERN);
    expect(redacted.gatewaySessionId).not.toBe(RAW_GATEWAY_SESSION_ID);
    expect(redacted.commandId).toBe("cmd-1");
    expect(redacted.computeTargetId).toBe("target-1");
    expect(JSON.stringify(redacted)).not.toContain(RAW_GATEWAY_SESSION_ID);
  });

  it("leaves an absent gatewaySessionId untouched (e.g. before hello-ack)", () => {
    // Annotate the optional key so the value can stay absent while still
    // satisfying the helper's `{ gatewaySessionId?: string }` constraint.
    const trace: {
      commandId: string;
      computeTargetId: string;
      gatewaySessionId?: string;
    } = { commandId: "cmd-1", computeTargetId: "target-1" };
    expect(redactTraceGatewaySessionId(trace)).toEqual(trace);
  });
});
