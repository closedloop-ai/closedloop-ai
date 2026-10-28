import { HttpServiceErrorCode } from "@repo/http-service/errors";
import { log } from "@repo/observability/log";
import {
  DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
  DocSyncDocumentCommand,
  DocSyncInternalErrorCode,
  docSyncDocumentPath,
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
import {
  createDocSyncInternalClient,
  DOC_SYNC_DELETE_ATTEMPTS,
  DOC_SYNC_DELETE_RETRY_DELAY_MS,
  DOC_SYNC_INTERNAL_CALL_FAILED_EVENT,
  DOC_SYNC_INTERNAL_NOT_CONFIGURED_EVENT,
  DocSyncClientErrorCode,
} from "../internal-client";

vi.mock("@vercel/oidc", () => ({ getVercelOidcToken: vi.fn() }));

const ORG_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ROOM_ID = generateDocumentRoomId(ORG_ID, "PRD-42");
const ANCHOR = { threadId: "th_1", anchorText: "the quoted text" };

function loggedFailurePaths() {
  return vi
    .mocked(log.error)
    .mock.calls.map(([, fields]) => (fields as { path?: string }).path);
}

/** The retry delay is scheduled only after the first DELETE's response has been read. */
async function untilTimerPending() {
  for (let turn = 0; turn < 50 && vi.getTimerCount() === 0; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  vi.mocked(getVercelOidcToken).mockReset().mockResolvedValue(OIDC_TOKEN);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("each command's request", () => {
  const bearer = { authorization: `Bearer ${OIDC_TOKEN}` };

  it("addCommentAnchor posts the thread and anchor text as JSON", async () => {
    const fetch = answering(json(200, { anchored: true }));
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(client.addCommentAnchor(ROOM_ID, ANCHOR)).resolves.toEqual({
      ok: true,
      value: { anchored: true },
    });
    expect(sent(fetch)).toEqual({
      url: `${CONFIG.url}${docSyncDocumentPath(ROOM_ID, DocSyncDocumentCommand.CommentAnchors)}`,
      method: "POST",
      headers: { ...bearer, "content-type": "application/json" },
      body: ANCHOR,
    });
  });

  it("readText gets the text path", async () => {
    const fetch = answering(json(200, { text: "one\ntwo" }));
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(client.readText(ROOM_ID)).resolves.toEqual({
      ok: true,
      value: { text: "one\ntwo" },
    });
    expect(sent(fetch)).toEqual({
      url: `${CONFIG.url}${docSyncDocumentPath(ROOM_ID, DocSyncDocumentCommand.Text)}`,
      method: "GET",
      headers: bearer,
      body: undefined,
    });
  });

  it("deleteDocument sends DELETE to the document's own path, name verbatim", async () => {
    const fetch = answering(json(200, { deleted: true, wasLoaded: false }));
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(client.deleteDocument(ROOM_ID)).resolves.toEqual({
      ok: true,
      value: { deleted: true, wasLoaded: false },
    });
    expect(sent(fetch)).toEqual({
      url: `${CONFIG.url}${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}/${ROOM_ID}`,
      method: "DELETE",
      headers: bearer,
      body: undefined,
    });
  });

  it("listDocuments gets the documents path with after and limit", async () => {
    const page = { names: [ROOM_ID], nextAfter: ROOM_ID };
    const fetch = answering(
      json(200, page),
      json(200, { names: [], nextAfter: null })
    );
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(
      client.listDocuments({ after: "a:artifact:B", limit: 7 })
    ).resolves.toEqual({ ok: true, value: page });
    await client.listDocuments({ limit: 7 });

    expect(sent(fetch, 0)).toEqual({
      url: `${CONFIG.url}${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}?limit=7&after=a%3Aartifact%3AB`,
      method: "GET",
      headers: bearer,
      body: undefined,
    });
    expect(sent(fetch, 1).url).toBe(
      `${CONFIG.url}${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}?limit=7`
    );
  });
});

describe("refusals", () => {
  it("maps a name that cannot be addressed to invalid with no request", async () => {
    const name = "org:artifact:PRD/1";
    const fetch = answering();
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    const results = await Promise.all([
      client.addCommentAnchor(name, ANCHOR),
      client.readText(name),
      client.deleteDocument(name),
    ]);

    expect(results).toEqual(
      Array.from({ length: 3 }, () => ({
        ok: false,
        failure: InternalCallFailure.Invalid,
      }))
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(loggedFailurePaths()).toEqual([
      `${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}/:documentName/${DocSyncDocumentCommand.CommentAnchors}`,
      `${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}/:documentName/${DocSyncDocumentCommand.Text}`,
      `${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}/:documentName`,
    ]);
  });

  it("maps an anchor request the contract refuses to invalid with no request", async () => {
    const fetch = answering();
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(
      client.addCommentAnchor(ROOM_ID, { ...ANCHOR, anchorText: "" })
    ).resolves.toEqual({ ok: false, failure: InternalCallFailure.Invalid });
    expect(fetch).not.toHaveBeenCalled();
    expect(loggedFailurePaths()).toEqual([
      docSyncDocumentPath(ROOM_ID, DocSyncDocumentCommand.CommentAnchors),
    ]);
  });

  it("maps a 422 anchor refusal to its code and match count", async () => {
    const client = createDocSyncInternalClient({
      config: CONFIG,
      fetch: answering(
        json(422, {
          code: DocSyncInternalErrorCode.AnchorAmbiguous,
          matchCount: 3,
        })
      ),
    });

    await expect(client.addCommentAnchor(ROOM_ID, ANCHOR)).resolves.toEqual({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 422,
      code: DocSyncInternalErrorCode.AnchorAmbiguous,
      matchCount: 3,
    });
  });

  it("maps a 410 to document_deleted", async () => {
    const client = createDocSyncInternalClient({
      config: CONFIG,
      fetch: answering(
        json(410, { code: DocSyncInternalErrorCode.DocumentDeleted })
      ),
    });

    await expect(client.readText(ROOM_ID)).resolves.toEqual({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 410,
      code: DocSyncInternalErrorCode.DocumentDeleted,
    });
    expect(vi.mocked(log.error).mock.calls[0]?.[1]).toEqual({
      event: DOC_SYNC_INTERNAL_CALL_FAILED_EVENT,
      path: docSyncDocumentPath(ROOM_ID, DocSyncDocumentCommand.Text),
      failure: InternalCallFailure.Rejected,
      httpStatus: 410,
      cause: undefined,
    });
  });

  it("maps the list route's 400 by status, with the generic invalid_body code", async () => {
    const client = createDocSyncInternalClient({
      config: CONFIG,
      fetch: answering(json(400, { code: HttpServiceErrorCode.InvalidBody })),
    });

    await expect(client.listDocuments({ limit: 0 })).resolves.toEqual({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 400,
      code: HttpServiceErrorCode.InvalidBody,
    });
  });

  it("maps a response missing a field to invalid_response", async () => {
    const client = createDocSyncInternalClient({
      config: CONFIG,
      fetch: answering(json(200, { deleted: true })),
    });

    await expect(client.deleteDocument(ROOM_ID)).resolves.toEqual({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 200,
      code: DocSyncClientErrorCode.InvalidResponse,
    });
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
  });

  it("parses a response carrying an unknown extra field", async () => {
    const client = createDocSyncInternalClient({
      config: CONFIG,
      fetch: answering(json(200, { text: "one", addedLater: 1 })),
    });

    await expect(client.readText(ROOM_ID)).resolves.toEqual({
      ok: true,
      value: { text: "one" },
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

      await expect(client.readText(ROOM_ID)).resolves.toEqual({
        ok: false,
        failure: InternalCallFailure.Unreachable,
      });
    },
    STALL_TEST_TIMEOUT_MS
  );

  it("sends nothing when unconfigured, and logs that once", async () => {
    const fetch = answering();
    const client = createDocSyncInternalClient({ config: undefined, fetch });

    const results = await Promise.all([
      client.deleteDocument(ROOM_ID),
      client.listDocuments({ limit: 1 }),
    ]);

    expect(results).toEqual([
      { ok: false, failure: InternalCallFailure.NotConfigured },
      { ok: false, failure: InternalCallFailure.NotConfigured },
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.mocked(log.warn).mock.calls.map(([, fields]) => fields)).toEqual([
      { event: DOC_SYNC_INTERNAL_NOT_CONFIGURED_EVENT },
    ]);
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe("a delete that answers 503 unload_timeout", () => {
  const unloadTimeout = () =>
    json(503, { code: DocSyncInternalErrorCode.UnloadTimeout });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is retried after the retry delay, and the retry's answer is the result", async () => {
    const fetch = answering(
      unloadTimeout(),
      json(200, { deleted: true, wasLoaded: true })
    );
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    const pending = client.deleteDocument(ROOM_ID);
    await untilTimerPending();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(DOC_SYNC_DELETE_RETRY_DELAY_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({
      ok: true,
      value: { deleted: true, wasLoaded: true },
    });
    expect(
      fetch.mock.calls.map((_, index) => sent(fetch, index).method)
    ).toEqual(["DELETE", "DELETE"]);
  });

  it("stops after the attempt budget and returns the last refusal", async () => {
    const fetch = answering(
      ...Array.from({ length: DOC_SYNC_DELETE_ATTEMPTS + 1 }, unloadTimeout)
    );
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    const pending = client.deleteDocument(ROOM_ID);
    await untilTimerPending();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(DOC_SYNC_DELETE_RETRY_DELAY_MS);

    await expect(pending).resolves.toEqual({
      ok: false,
      failure: InternalCallFailure.Rejected,
      status: 503,
      code: DocSyncInternalErrorCode.UnloadTimeout,
    });
    expect(fetch).toHaveBeenCalledTimes(DOC_SYNC_DELETE_ATTEMPTS);
  });

  it("does not retry a 503 with another code", async () => {
    const fetch = answering(
      json(503, { code: "unavailable" }),
      json(200, { deleted: true, wasLoaded: false })
    );
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    const result = await client.deleteDocument(ROOM_ID);

    expect(result.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("seedVersion", () => {
  const SEED = { markdown: "# Plan\n\nbody", version: 3 };
  const seedPath = docSyncDocumentPath(
    ROOM_ID,
    DocSyncDocumentCommand.SeedVersion
  );

  it("posts the markdown and version as JSON with the bearer, and parses the answer", async () => {
    const answer = { applied: true, stale: false, updateBytes: 256 };
    const fetch = answering(json(200, answer));
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(client.seedVersion(ROOM_ID, SEED)).resolves.toEqual({
      ok: true,
      value: answer,
    });
    expect(sent(fetch)).toEqual({
      url: `${CONFIG.url}${seedPath}`,
      method: "POST",
      headers: {
        authorization: `Bearer ${OIDC_TOKEN}`,
        "content-type": "application/json",
      },
      body: SEED,
    });
  });

  it("maps a request the contract refuses to invalid with no request", async () => {
    const fetch = answering();
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(
      client.seedVersion(ROOM_ID, { ...SEED, version: 0 })
    ).resolves.toEqual({ ok: false, failure: InternalCallFailure.Invalid });
    expect(fetch).not.toHaveBeenCalled();
  });
});
