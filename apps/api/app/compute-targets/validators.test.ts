import { PluginUpdateOutcome } from "@repo/api/src/types/compute-target";
import { describe, expect, it } from "vitest";
import {
  createDesktopCommandValidator,
  healthCheckResultValidator,
} from "./validators";

const validCommand = {
  operationId: "op-1",
  method: "POST",
  path: "/api/gateway/symphony/chat/run-1",
  streaming: false,
  commandId: "0196b1bb-7a00-7000-8000-000000000010",
  signature: "YWJj",
  signaturePayload: "payload",
};

describe("createDesktopCommandValidator", () => {
  it("accepts command public-key fingerprints with the generated 22 character suffix", () => {
    expect(
      createDesktopCommandValidator.safeParse({
        ...validCommand,
        publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
      }).success
    ).toBe(true);
  });

  it("rejects shorter command public-key fingerprints", () => {
    const parsed = createDesktopCommandValidator.safeParse({
      ...validCommand,
      publicKeyFingerprint: "cl:abcdefghijklmnop",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts paths starting with /api/gateway/", () => {
    expect(
      createDesktopCommandValidator.safeParse({
        operationId: "op-1",
        method: "POST",
        path: "/api/gateway/symphony/chat/run-1",
        streaming: false,
      }).success
    ).toBe(true);
  });

  it("rejects legacy /api/engineer/* paths that are no longer in the gateway namespace", () => {
    const parsed = createDesktopCommandValidator.safeParse({
      operationId: "op-1",
      method: "GET",
      path: "/api/engineer/health-check",
      streaming: false,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) =>
          issue.message.includes("/api/gateway/")
        )
      ).toBe(true);
    }
  });
});

describe("healthCheckResultValidator", () => {
  it("preserves plugin enable repair fields", () => {
    const parsed = healthCheckResultValidator.parse({
      id: "plugin-code",
      label: "Symphony Plugin",
      required: true,
      passed: true,
      enableAttempted: true,
      enableOutcome: PluginUpdateOutcome.Success,
      enablePluginIds: ["code@closedloop-ai"],
    });

    expect(parsed.enableAttempted).toBe(true);
    expect(parsed.enableOutcome).toBe("success");
    expect(parsed.enablePluginIds).toEqual(["code@closedloop-ai"]);
  });

  it("omits unknown additive plugin repair outcome telemetry", () => {
    const parsed = healthCheckResultValidator.parse({
      id: "plugin-code",
      label: "Symphony Plugin",
      required: true,
      passed: false,
      enableAttempted: true,
      enableOutcome: "not_attempted",
      updateAttempted: true,
      updateOutcome: "queued",
    });

    expect(parsed.enableAttempted).toBe(true);
    expect(parsed.enableOutcome).toBeUndefined();
    expect(parsed.updateAttempted).toBe(true);
    expect(parsed.updateOutcome).toBeUndefined();
  });
});
