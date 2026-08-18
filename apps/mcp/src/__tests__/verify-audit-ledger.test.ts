import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerVerifyAuditLedger } from "../tools/verify-audit-ledger.js";
import {
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

const HEAD_FROM_VERIFY = {
  seq: "42",
  hash: "abc123",
};

const HEAD_FROM_GET = {
  seq: "41",
  hash: "def456",
};

describe("verify-audit-ledger MCP tool", () => {
  it("uses head from verify result when chain is intact (ok: true) and does not call GET /audit/head", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ok: true, head: HEAD_FROM_VERIFY });
    const get = vi.fn();
    const handler = createToolHarness(registerVerifyAuditLedger, {
      post,
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({})) as Record<
      string,
      unknown
    >;

    expect(post).toHaveBeenCalledWith("/audit/verify", {});
    expect(get).not.toHaveBeenCalled();
    expect(payload.ok).toBe(true);
    expect(payload.head).toEqual(HEAD_FROM_VERIFY);
  });

  it("fetches GET /audit/head when chain is broken (ok: false) and merges it into the result", async () => {
    const post = vi.fn().mockResolvedValue({
      ok: false,
      firstBrokenSeq: "39",
      head: undefined,
    });
    const get = vi.fn().mockResolvedValue(HEAD_FROM_GET);
    const handler = createToolHarness(registerVerifyAuditLedger, {
      post,
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(await handler({})) as Record<
      string,
      unknown
    >;

    expect(post).toHaveBeenCalledWith("/audit/verify", {});
    expect(get).toHaveBeenCalledWith("/audit/head");
    expect(payload.ok).toBe(false);
    expect(payload.head).toEqual(HEAD_FROM_GET);
  });
});
