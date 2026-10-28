import { describe, expect, it } from "vitest";
import {
  assumedRoleArnPrefix,
  clearResponseSchema,
  DOC_SYNC_CALLBACK_MAX_BODY_BYTES,
  DOC_SYNC_CALLBACK_MAX_EDITORS,
  DOC_SYNC_CALLBACK_MAX_ID_LENGTH,
  DOC_SYNC_CALLBACK_MAX_MENTIONS,
  DOC_SYNC_LIST_DEFAULT_LIMIT,
  DOC_SYNC_LIST_MAX_LIMIT,
  DocSyncChangeSource,
  DocSyncDocumentCommand,
  DocSyncMentionKind,
  docSyncChangeCallbackSchema,
  docSyncDocumentPath,
  FirstOpenSeedState,
  firstOpenSeedProbeResponseSchema,
  isAddressableDocumentName,
  listDocumentsQuerySchema,
  seedIfNeverStoredRequestSchema,
  seedIfNeverStoredResponseSchema,
} from "../doc-sync-internal";
import { generateDocumentRoomId } from "../document-room";

const ORG = "0190f6a1-5b2c-7d3e-8f40-6a7b8c9d0e1f";
const CANONICAL = generateDocumentRoomId(ORG, "PLN-1");

describe("isAddressableDocumentName", () => {
  it("accepts a canonical room id", () => {
    expect(isAddressableDocumentName(CANONICAL)).toBe(true);
  });

  it.each(["", ".", "..", "a/b", "a%2Fb", "a b", "a?b", "a#b"])(
    "refuses %j, which would need encoding or escape its segment",
    (name) => {
      expect(isAddressableDocumentName(name)).toBe(false);
    }
  );
});

describe("docSyncDocumentPath", () => {
  it("builds the document path and each command path", () => {
    expect(docSyncDocumentPath(CANONICAL)).toBe(
      `/internal/documents/${CANONICAL}`
    );
    expect(docSyncDocumentPath(CANONICAL, DocSyncDocumentCommand.Clear)).toBe(
      `/internal/documents/${CANONICAL}/clear`
    );
  });

  it("is undefined for a name that cannot be addressed", () => {
    expect(
      docSyncDocumentPath("..", DocSyncDocumentCommand.Text)
    ).toBeUndefined();
  });
});

describe("listDocumentsQuerySchema", () => {
  it("defaults the limit and coerces a query-string limit", () => {
    expect(listDocumentsQuerySchema.parse({})).toEqual({
      limit: DOC_SYNC_LIST_DEFAULT_LIMIT,
    });
    expect(listDocumentsQuerySchema.parse({ limit: "7" }).limit).toBe(7);
  });

  it("refuses a limit outside 1 to the maximum", () => {
    expect(listDocumentsQuerySchema.safeParse({ limit: "0" }).success).toBe(
      false
    );
    expect(
      listDocumentsQuerySchema.safeParse({
        limit: String(DOC_SYNC_LIST_MAX_LIMIT + 1),
      }).success
    ).toBe(false);
  });
});

describe("response schemas", () => {
  it("accept a field a newer service adds", () => {
    expect(
      clearResponseSchema.parse({ cleared: true, addedLater: 1 })
    ).toMatchObject({ cleared: true });
    expect(
      seedIfNeverStoredResponseSchema.parse({
        applied: true,
        updateBytes: 12,
        addedLater: 1,
      })
    ).toEqual({ applied: true, updateBytes: 12 });
    expect(
      firstOpenSeedProbeResponseSchema.parse({
        state: FirstOpenSeedState.Stored,
        addedLater: 1,
      })
    ).toEqual({ state: FirstOpenSeedState.Stored });
  });

  it("accept a probe state a newer service adds", () => {
    expect(
      firstOpenSeedProbeResponseSchema.parse({ state: "added-later" })
    ).toEqual({ state: "added-later" });
  });
});

describe("seedIfNeverStoredRequestSchema", () => {
  const request = { markdown: "# Plan", version: 3 };

  it("accepts markdown and a positive integer version", () => {
    expect(seedIfNeverStoredRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    ["empty markdown", { ...request, markdown: "" }],
    ["version 0", { ...request, version: 0 }],
    ["a negative version", { ...request, version: -1 }],
    ["a fractional version", { ...request, version: 1.5 }],
    ["an unknown key", { ...request, mode: "reset" }],
  ])("refuses %s", (_label, body) => {
    expect(seedIfNeverStoredRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe("docSyncChangeCallbackSchema", () => {
  const callback = {
    callbackId: "6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f",
    documentName: CANONICAL,
    sources: [DocSyncChangeSource.Connection],
    editorUserIds: ["user-1"],
    firstChangedAt: "2026-10-22T10:00:00.000Z",
    lastChangedAt: "2026-10-22T10:00:02.000Z",
    mentions: [{ kind: DocSyncMentionKind.User, id: "user-2" }],
    mentionsTruncated: false,
  };

  it("accepts a newer doc-sync's callback: an added field is dropped and an unknown source kept", () => {
    const parsed = docSyncChangeCallbackSchema.parse({
      ...callback,
      sources: [...callback.sources, "added-later"],
      addedLater: { any: "shape" },
    });

    expect(parsed).toEqual({
      ...callback,
      sources: [...callback.sources, "added-later"],
    });
  });

  it("refuses a callback missing a field this API requires", () => {
    const { mentionsTruncated: _omitted, ...older } = callback;

    expect(docSyncChangeCallbackSchema.safeParse(older).success).toBe(false);
  });

  it("refuses editors and mentions past their caps", () => {
    expect(
      docSyncChangeCallbackSchema.safeParse({
        ...callback,
        editorUserIds: Array.from(
          { length: DOC_SYNC_CALLBACK_MAX_EDITORS + 1 },
          (_, index) => `user-${index}`
        ),
      }).success
    ).toBe(false);
    expect(
      docSyncChangeCallbackSchema.safeParse({
        ...callback,
        mentions: Array.from(
          { length: DOC_SYNC_CALLBACK_MAX_MENTIONS + 1 },
          (_, index) => ({ kind: DocSyncMentionKind.User, id: `u${index}` })
        ),
      }).success
    ).toBe(false);
  });

  it("serializes the largest callback it accepts within the API's body cap", () => {
    const id = "~".repeat(DOC_SYNC_CALLBACK_MAX_ID_LENGTH);
    const largest = {
      ...callback,
      sources: Object.values(DocSyncChangeSource),
      editorUserIds: Array.from(
        { length: DOC_SYNC_CALLBACK_MAX_EDITORS },
        () => id
      ),
      mentions: Array.from({ length: DOC_SYNC_CALLBACK_MAX_MENTIONS }, () => ({
        kind: DocSyncMentionKind.Group,
        id,
      })),
      mentionsTruncated: true,
    };

    expect(docSyncChangeCallbackSchema.safeParse(largest).success).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(largest)).length
    ).toBeLessThanOrEqual(DOC_SYNC_CALLBACK_MAX_BODY_BYTES);
  });

  it.each([
    ["longer than the cap", "u".repeat(DOC_SYNC_CALLBACK_MAX_ID_LENGTH + 1)],
    ["empty", ""],
    ["with a quote", 'u"1'],
    ["with a backslash", String.raw`u\1`],
    ["with a space", "u 1"],
    ["with a non-ASCII character", "ué1"],
  ])("refuses an editor or mention id %s", (_label, id) => {
    expect(
      docSyncChangeCallbackSchema.safeParse({
        ...callback,
        editorUserIds: [id],
      }).success
    ).toBe(false);
    expect(
      docSyncChangeCallbackSchema.safeParse({
        ...callback,
        mentions: [{ kind: DocSyncMentionKind.User, id }],
      }).success
    ).toBe(false);
  });
});

describe("assumedRoleArnPrefix", () => {
  it("names the role's STS sessions, without the role's path", () => {
    expect(
      assumedRoleArnPrefix("arn:aws:iam::123456789012:role/service/doc-sync")
    ).toBe("arn:aws:sts::123456789012:assumed-role/doc-sync/");
  });

  it.each([
    "arn:aws:iam::123456789012:role/doc-sync/",
    "arn:aws:iam::123456789012:user/doc-sync",
    "arn:aws:sts::123456789012:assumed-role/doc-sync/session",
  ])("is undefined for %s", (roleArn) => {
    expect(assumedRoleArnPrefix(roleArn)).toBeUndefined();
  });
});
