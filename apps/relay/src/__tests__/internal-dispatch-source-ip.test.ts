import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const TEST_SECRET = "test-internal-secret";

let handleInternalDispatch: typeof import("../peer-dispatch.js").handleInternalDispatch;

beforeEach(async () => {
  vi.stubEnv("INTERNAL_API_SECRET", TEST_SECRET);
  vi.stubEnv("RELAY_INTERNAL_ALLOWED_IPS", "10.0.0.0/8");
  vi.resetModules();
  ({ handleInternalDispatch } = await import("../peer-dispatch.js"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function makeReq(remoteAddress: string | undefined): IncomingMessage {
  return {
    headers: { "x-internal-secret": TEST_SECRET },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function makeRes() {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

describe("handleInternalDispatch source-IP allowlist", () => {
  // Pins current behavior; looks odd. A missing remote address becomes "",
  // which ipToNumber folds to 0.0.0.0. It is refused here only because
  // 0.0.0.0 is outside 10.0.0.0/8. An allowlist entry such as 0.0.0.0/8
  // would let the same request through.
  it("forbids an empty remote address that falls outside the allowlist", async () => {
    const res = makeRes();

    await handleInternalDispatch(
      makeReq(undefined),
      res as unknown as ServerResponse
    );

    expect(res.writeHead).toHaveBeenCalledWith(403, {
      "Content-Type": "application/json",
    });
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({ error: "Forbidden" })
    );
  });
});
