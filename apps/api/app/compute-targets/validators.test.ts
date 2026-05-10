import { describe, expect, it } from "vitest";
import { createDesktopCommandValidator } from "./validators";

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
});
