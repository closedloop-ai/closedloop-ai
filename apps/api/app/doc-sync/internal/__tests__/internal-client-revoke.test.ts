import { HttpServiceErrorCode } from "@repo/http-service/errors";
import { log } from "@repo/observability/log";
import { DOC_SYNC_REVOKE_PATH } from "@repo/realtime-contract/doc-sync-internal";
import type { RevokeTarget } from "@repo/realtime-contract/internal";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { getVercelOidcToken } from "@vercel/oidc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answering,
  CONFIG,
  json,
  OIDC_TOKEN,
  STALL_TEST_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  sent,
  stalling,
} from "@/__tests__/support/doc-sync/internal/internal-client.test-fixtures";
import { createDocSyncInternalClient } from "../internal-client";

vi.mock("@vercel/oidc", () => ({ getVercelOidcToken: vi.fn() }));

const TARGET: RevokeTarget = { userId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" };

beforeEach(() => {
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  vi.mocked(getVercelOidcToken).mockReset().mockResolvedValue(OIDC_TOKEN);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("revoke", () => {
  it("posts the target as JSON to the revoke path with the bearer, and parses the count", async () => {
    const fetch = answering(json(200, { closedConnections: 2 }));
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(client.revoke(TARGET)).resolves.toEqual({
      ok: true,
      value: { closedConnections: 2 },
    });
    expect(sent(fetch)).toEqual({
      url: `${CONFIG.url}${DOC_SYNC_REVOKE_PATH}`,
      method: "POST",
      headers: {
        authorization: `Bearer ${OIDC_TOKEN}`,
        "content-type": "application/json",
      },
      body: { target: TARGET },
    });
  });

  it("maps a 400 to rejected", async () => {
    const client = createDocSyncInternalClient({
      config: CONFIG,
      fetch: answering(json(400, { code: HttpServiceErrorCode.InvalidBody })),
    });

    await expect(client.revoke(TARGET)).resolves.toEqual({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 400,
      code: HttpServiceErrorCode.InvalidBody,
    });
  });

  it(
    "maps a stalled service to unreachable at the timeout",
    async () => {
      const client = createDocSyncInternalClient({
        config: CONFIG,
        fetch: stalling(),
        timeoutMs: STALL_TIMEOUT_MS,
      });

      await expect(client.revoke(TARGET)).resolves.toEqual({
        ok: false,
        failure: InternalCallFailure.Unreachable,
      });
    },
    STALL_TEST_TIMEOUT_MS
  );

  it("sends nothing when unconfigured", async () => {
    const fetch = answering();
    const client = createDocSyncInternalClient({ config: undefined, fetch });

    await expect(client.revoke(TARGET)).resolves.toEqual({
      ok: false,
      failure: InternalCallFailure.NotConfigured,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps a target the contract refuses to invalid with no request", async () => {
    const fetch = answering();
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(client.revoke({ userId: "" })).resolves.toEqual({
      ok: false,
      failure: InternalCallFailure.Invalid,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
