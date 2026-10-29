import {
  CommentAnchorState,
  type CommentAnchorTextPosition,
  type CommentAnchorTextQuote,
} from "@repo/api/src/types/comment-anchor";
import { HttpServiceErrorCode } from "@repo/http-service/errors";
import { log } from "@repo/observability/log";
import {
  COMMENT_ANCHORS_PLACE_MAX,
  CommentAnchorPlaceMode,
  CommentAnchorPlacementState,
  type CommentAnchorPosition,
  type CommentAnchorQuote,
  DOC_SYNC_INTERNAL_DOCUMENTS_PATH,
  DocSyncDocumentCommand,
} from "@repo/realtime-contract/doc-sync-internal";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { getVercelOidcToken } from "@vercel/oidc";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
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
  DOC_SYNC_COMMENT_ANCHOR_TIMEOUT_MS,
  DocSyncClientErrorCode,
  type DocSyncInternalClient,
} from "../internal-client";

vi.mock("@vercel/oidc", () => ({ getVercelOidcToken: vi.fn() }));

const ORG_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ROOM_ID = generateDocumentRoomId(ORG_ID, "PRD-42");
const UNADDRESSABLE = "org:artifact:PRD/1";
const QUOTE = { exact: "hello", prefix: "say ", suffix: " there" };
const POSITION = { start: 4, end: 9 };
const PLACE = {
  mode: CommentAnchorPlaceMode.Missing,
  anchors: [
    { threadId: "th_1", quote: QUOTE, position: POSITION },
    { threadId: "th_2", quote: QUOTE },
  ],
};
const RENAME = {
  mapping: [
    { from: "lb_1", to: "th_1" },
    { from: "lb_2", to: "th_2" },
  ],
};
const REMOVE = { threadIds: ["th_1", "th_2"] };

const bearer = { authorization: `Bearer ${OIDC_TOKEN}` };
const jsonHeaders = { ...bearer, "content-type": "application/json" };

/** Each comment-anchor method, called with a valid request for `name`. */
const CALLS = {
  readCommentAnchors: (client: DocSyncInternalClient, name: string) =>
    client.readCommentAnchors(name),
  placeCommentAnchors: (client: DocSyncInternalClient, name: string) =>
    client.placeCommentAnchors(name, PLACE),
  renameCommentAnchors: (client: DocSyncInternalClient, name: string) =>
    client.renameCommentAnchors(name, RENAME),
  removeCommentAnchors: (client: DocSyncInternalClient, name: string) =>
    client.removeCommentAnchors(name, REMOVE),
};

const commandUrl = (command: DocSyncDocumentCommand) =>
  `${CONFIG.url}${DOC_SYNC_INTERNAL_DOCUMENTS_PATH}/${ROOM_ID}/${command}`;

beforeEach(() => {
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
  vi.mocked(getVercelOidcToken).mockReset().mockResolvedValue(OIDC_TOKEN);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("each comment-anchor command's request", () => {
  it("readCommentAnchors gets the comment-anchors path and parses the marks", async () => {
    const marks = [
      { threadId: "th_1", quote: QUOTE, position: POSITION, orphan: false },
    ];
    const fetch = answering(json(200, { marks }));
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(client.readCommentAnchors(ROOM_ID)).resolves.toEqual({
      ok: true,
      value: { marks },
    });
    expect(sent(fetch)).toEqual({
      url: commandUrl(DocSyncDocumentCommand.CommentAnchors),
      method: "GET",
      headers: bearer,
      body: undefined,
    });
  });

  it("placeCommentAnchors posts the mode and anchors and parses the results", async () => {
    const results = [
      {
        threadId: "th_1",
        state: CommentAnchorPlacementState.Anchored,
        quote: QUOTE,
        position: POSITION,
      },
      { threadId: "th_2", state: CommentAnchorPlacementState.Orphaned },
    ];
    const fetch = answering(json(200, { results }));
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(client.placeCommentAnchors(ROOM_ID, PLACE)).resolves.toEqual({
      ok: true,
      value: { results },
    });
    expect(sent(fetch)).toEqual({
      url: commandUrl(DocSyncDocumentCommand.CommentAnchorsPlace),
      method: "POST",
      headers: jsonHeaders,
      body: PLACE,
    });
  });

  it("renameCommentAnchors posts the mapping and parses the renamed ids", async () => {
    const fetch = answering(json(200, { renamed: ["lb_1"] }));
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(client.renameCommentAnchors(ROOM_ID, RENAME)).resolves.toEqual(
      { ok: true, value: { renamed: ["lb_1"] } }
    );
    expect(sent(fetch)).toEqual({
      url: commandUrl(DocSyncDocumentCommand.CommentAnchorsRename),
      method: "POST",
      headers: jsonHeaders,
      body: RENAME,
    });
  });

  it("removeCommentAnchors posts the thread ids and parses the removed ids", async () => {
    const fetch = answering(json(200, { removed: ["th_2"] }));
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(client.removeCommentAnchors(ROOM_ID, REMOVE)).resolves.toEqual(
      { ok: true, value: { removed: ["th_2"] } }
    );
    expect(sent(fetch)).toEqual({
      url: commandUrl(DocSyncDocumentCommand.CommentAnchorsRemove),
      method: "POST",
      headers: jsonHeaders,
      body: REMOVE,
    });
  });
});

describe("comment-anchor refusals", () => {
  it("maps a name that cannot be addressed to invalid with no request", async () => {
    const fetch = answering();
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    const results = await Promise.all(
      Object.values(CALLS).map((call) => call(client, UNADDRESSABLE))
    );

    expect(results).toEqual(
      Array.from({ length: 4 }, () => ({
        ok: false,
        failure: InternalCallFailure.Invalid,
      }))
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an empty anchor list",
      (client: DocSyncInternalClient) =>
        client.placeCommentAnchors(ROOM_ID, { ...PLACE, anchors: [] }),
    ],
    [
      "more anchors than the cap",
      (client: DocSyncInternalClient) =>
        client.placeCommentAnchors(ROOM_ID, {
          ...PLACE,
          anchors: Array.from(
            { length: COMMENT_ANCHORS_PLACE_MAX + 1 },
            (_, index) => ({ threadId: `th_${index}`, quote: QUOTE })
          ),
        }),
    ],
    [
      "a position that ends before it starts",
      (client: DocSyncInternalClient) =>
        client.placeCommentAnchors(ROOM_ID, {
          ...PLACE,
          anchors: [
            { threadId: "th_1", quote: QUOTE, position: { start: 9, end: 4 } },
          ],
        }),
    ],
    [
      "one thread placed twice",
      (client: DocSyncInternalClient) =>
        client.placeCommentAnchors(ROOM_ID, {
          ...PLACE,
          anchors: [
            { threadId: "th_1", quote: QUOTE },
            { threadId: "th_1", quote: QUOTE, position: POSITION },
          ],
        }),
    ],
    [
      "one id renamed twice",
      (client: DocSyncInternalClient) =>
        client.renameCommentAnchors(ROOM_ID, {
          mapping: [
            { from: "lb_1", to: "th_1" },
            { from: "lb_1", to: "th_2" },
          ],
        }),
    ],
    [
      "a rename to an empty id",
      (client: DocSyncInternalClient) =>
        client.renameCommentAnchors(ROOM_ID, {
          mapping: [{ from: "lb_1", to: "" }],
        }),
    ],
    [
      "an empty removal",
      (client: DocSyncInternalClient) =>
        client.removeCommentAnchors(ROOM_ID, { threadIds: [] }),
    ],
  ])("maps %s to invalid with no request", async (_, call) => {
    const fetch = answering();
    const client = createDocSyncInternalClient({ config: CONFIG, fetch });

    await expect(call(client)).resolves.toEqual({
      ok: false,
      failure: InternalCallFailure.Invalid,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(Object.entries(CALLS))(
    "%s maps an older doc-sync's 404 to a typed rejection",
    async (_, call) => {
      const client = createDocSyncInternalClient({
        config: CONFIG,
        fetch: answering(json(404, { code: HttpServiceErrorCode.NotFound })),
      });

      await expect(call(client, ROOM_ID)).resolves.toEqual({
        ok: false,
        failure: InternalCallFailure.Rejected,
        status: 404,
        code: HttpServiceErrorCode.NotFound,
      });
    }
  );

  it.each([
    [
      "readCommentAnchors",
      CALLS.readCommentAnchors,
      { marks: [{ threadId: "th_1" }] },
    ],
    [
      "placeCommentAnchors",
      CALLS.placeCommentAnchors,
      { results: [{ threadId: "th_1", state: "SOMEWHERE" }] },
    ],
    ["renameCommentAnchors", CALLS.renameCommentAnchors, { renamed: "lb_1" }],
    ["removeCommentAnchors", CALLS.removeCommentAnchors, {}],
  ])(
    "%s maps a malformed 2xx body to invalid_response",
    async (_, call, body) => {
      const client = createDocSyncInternalClient({
        config: CONFIG,
        fetch: answering(json(200, body)),
      });

      await expect(call(client, ROOM_ID)).resolves.toEqual({
        ok: false,
        failure: InternalCallFailure.Rejected,
        status: 200,
        code: DocSyncClientErrorCode.InvalidResponse,
      });
    }
  );
});

describe("CommentAnchorPlacementState", () => {
  it("stores as CommentAnchorState unchanged", () => {
    expect(Object.values(CommentAnchorState)).toEqual(
      expect.arrayContaining(Object.values(CommentAnchorPlacementState))
    );
  });

  it("carries the stored text anchor's quote and position shapes", () => {
    expectTypeOf<CommentAnchorQuote>().toEqualTypeOf<CommentAnchorTextQuote>();
    expectTypeOf<CommentAnchorPosition>().toEqualTypeOf<CommentAnchorTextPosition>();
  });
});

describe("comment-anchor timeouts", () => {
  it.each(Object.entries(CALLS))(
    "%s waits the 10 s comment-anchor deadline, not the general one",
    async (_, call) => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const client = createDocSyncInternalClient({
        config: CONFIG,
        fetch: answering(json(503, { code: "unavailable" })),
        timeoutMs: 1,
      });

      await call(client, ROOM_ID);

      expect(timeout.mock.calls).toEqual([
        [DOC_SYNC_COMMENT_ANCHOR_TIMEOUT_MS],
      ]);
      expect(DOC_SYNC_COMMENT_ANCHOR_TIMEOUT_MS).toBe(10_000);
    }
  );

  it(
    "maps a stalled service to unreachable at the deadline",
    async () => {
      const client = createDocSyncInternalClient({
        config: CONFIG,
        fetch: stalling(),
        commentAnchorTimeoutMs: STALL_TIMEOUT_MS,
      });

      await expect(client.placeCommentAnchors(ROOM_ID, PLACE)).resolves.toEqual(
        { ok: false, failure: InternalCallFailure.Unreachable }
      );
    },
    STALL_TEST_TIMEOUT_MS
  );
});
