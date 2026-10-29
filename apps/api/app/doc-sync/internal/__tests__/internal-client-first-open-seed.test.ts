import { log } from "@repo/observability/log";
import {
  DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
  DocSyncDocumentCommand,
  docSyncDocumentPath,
  FirstOpenSeedState,
} from "@repo/realtime-contract/doc-sync-internal";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
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

const ORG_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ROOM_ID = generateDocumentRoomId(ORG_ID, "PRD-42");
const SEED = { markdown: "# Plan", version: 3 };
const bearer = { authorization: `Bearer ${OIDC_TOKEN}` };

beforeEach(() => {
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  vi.mocked(getVercelOidcToken).mockReset().mockResolvedValue(OIDC_TOKEN);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("probeFirstOpenSeed", () => {
  it("gets the probe path with only the room, and keeps an unknown state", async () => {
    const fetch = answering(json(200, { state: "added-later" }));
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(
      client.probeFirstOpenSeed(ROOM_ID, { timeoutMs: 1000 })
    ).resolves.toEqual({ ok: true, value: { state: "added-later" } });
    expect(sent(fetch)).toEqual({
      url: `${CONFIG.url}${docSyncDocumentPath(ROOM_ID, DocSyncDocumentCommand.FirstOpenSeed)}`,
      method: "GET",
      headers: bearer,
      body: undefined,
    });
  });

  it("makes one attempt: a 500 is returned, not retried", async () => {
    const fetch = answering(
      json(500, {}),
      json(200, { state: FirstOpenSeedState.Stored })
    );
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(
      client.probeFirstOpenSeed(ROOM_ID, { timeoutMs: 1000 })
    ).resolves.toMatchObject({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 500,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it(
    "gives up at the timeout it is handed, not the client's default",
    async () => {
      const client = createDocSyncInternalClient({
        config: CONFIG,
        fetch: stalling(),
        timeoutMs: STALL_TEST_TIMEOUT_MS * 10,
      });

      await expect(
        client.probeFirstOpenSeed(ROOM_ID, { timeoutMs: STALL_TIMEOUT_MS })
      ).resolves.toEqual({
        ok: false,
        failure: InternalCallFailure.Unreachable,
      });
    },
    STALL_TEST_TIMEOUT_MS
  );

  it("refuses an unaddressable name with no request", async () => {
    const fetch = answering();
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(
      client.probeFirstOpenSeed("org:artifact:PRD/1", { timeoutMs: 1000 })
    ).resolves.toEqual({ ok: false, failure: InternalCallFailure.Invalid });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.mocked(log.error).mock.calls[0]?.[1]).toMatchObject({
      path: `${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}/:documentName/${DocSyncDocumentCommand.FirstOpenSeed}`,
    });
  });
});

describe("seedIfNeverStored", () => {
  it("posts the markdown and version as JSON, and parses the answer", async () => {
    const fetch = answering(json(200, { applied: true, updateBytes: 40 }));
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(
      client.seedIfNeverStored(ROOM_ID, SEED, { timeoutMs: 1000 })
    ).resolves.toEqual({ ok: true, value: { applied: true, updateBytes: 40 } });
    expect(sent(fetch)).toEqual({
      url: `${CONFIG.url}${docSyncDocumentPath(ROOM_ID, DocSyncDocumentCommand.SeedIfNeverStored)}`,
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: SEED,
    });
  });

  it("makes one attempt: a 503 is returned, not retried", async () => {
    const fetch = answering(
      json(503, {}),
      json(200, { applied: true, updateBytes: 1 })
    );
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(
      client.seedIfNeverStored(ROOM_ID, SEED, { timeoutMs: 1000 })
    ).resolves.toMatchObject({ ok: false, status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses a request the contract refuses, with no request", async () => {
    const fetch = answering();
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(
      client.seedIfNeverStored(
        ROOM_ID,
        { ...SEED, markdown: "" },
        { timeoutMs: 1000 }
      )
    ).resolves.toEqual({ ok: false, failure: InternalCallFailure.Invalid });
    expect(fetch).not.toHaveBeenCalled();
  });

  it(
    "gives up at the timeout it is handed",
    async () => {
      const client = createDocSyncInternalClient({
        config: CONFIG,
        fetch: stalling(),
        timeoutMs: STALL_TEST_TIMEOUT_MS * 10,
      });

      await expect(
        client.seedIfNeverStored(ROOM_ID, SEED, { timeoutMs: STALL_TIMEOUT_MS })
      ).resolves.toEqual({
        ok: false,
        failure: InternalCallFailure.Unreachable,
      });
    },
    STALL_TEST_TIMEOUT_MS
  );
});
