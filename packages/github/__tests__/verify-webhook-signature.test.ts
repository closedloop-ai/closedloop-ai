import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { verifyWebhookSignature } from "../index";

const SECRET = "test-webhook-secret";
const PAYLOAD = JSON.stringify({ action: "opened" });

function sign(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("verifyWebhookSignature", () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.GITHUB_APP_WEBHOOK_SECRET;
    process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      Reflect.deleteProperty(process.env, "GITHUB_APP_WEBHOOK_SECRET");
    } else {
      process.env.GITHUB_APP_WEBHOOK_SECRET = originalSecret;
    }
  });

  it("returns true for a signature computed with the configured secret", () => {
    expect(verifyWebhookSignature(PAYLOAD, sign(PAYLOAD, SECRET))).toBe(true);
  });

  it("returns false for a signature computed with the wrong secret", () => {
    expect(verifyWebhookSignature(PAYLOAD, sign(PAYLOAD, "other-secret"))).toBe(
      false
    );
  });

  it("returns false when the signature lacks the sha256= prefix", () => {
    expect(verifyWebhookSignature(PAYLOAD, "deadbeef")).toBe(false);
  });
});
