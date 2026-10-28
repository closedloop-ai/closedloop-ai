import { createHash } from "node:crypto";
import { ArtifactType } from "@repo/database";
import { log } from "@repo/observability/log";
import {
  DOC_SYNC_CALLBACK_AUDIENCE,
  DOC_SYNC_CALLBACK_SIGNATURE_TTL_SECONDS,
  DocSyncCallbackHeader,
  type DocSyncChangeCallback,
  DocSyncChangeSource,
  DocSyncMentionKind,
  STS_GET_CALLER_IDENTITY_QUERY,
} from "@repo/realtime-contract/doc-sync-internal";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "@/__tests__/utils/db-helpers";

const mocks = vi.hoisted(() => ({
  env: { DOC_SYNC_CALLBACK_ROLE_ARN: undefined as string | undefined },
}));

vi.mock("@/env", () => ({ env: mocks.env }));
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: vi.fn(),
}));
vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(() => Promise.resolve()),
  },
}));

const { POST } = await import("../route");
const { DOC_SYNC_CHANGE_RECEIVED_EVENT } = await import("../change-service");
const { DOC_SYNC_CHANGE_CALLER_REFUSED_EVENT, docSyncCallerRefusalThrottle } =
  await import("../caller-refusal-telemetry");
const { DocSyncCallerRefusal } = await import("../verify-caller");

const ROLE_ARN = "arn:aws:iam::123456789012:role/service/doc-sync-task";
const CALLER_ARN =
  "arn:aws:sts::123456789012:assumed-role/doc-sync-task/0a1b2c3d4e5f";
const OTHER_ROLE_CALLER_ARN =
  "arn:aws:sts::123456789012:assumed-role/realtime-task/0a1b2c3d4e5f";
const ORG_A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ORG_B = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const DOCUMENT_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60";
const SLUG = "PLN-1";
const BRANCH_SLUG = "PLN-2";
const SIGNED_HEADERS = [
  "host",
  DocSyncCallbackHeader.Audience,
  DocSyncCallbackHeader.BodySha256,
].join(";");

type Row = {
  id: string;
  organizationId: string;
  slug: string;
  type: ArtifactType;
};

/** Evaluates `findFirst`'s `where` as Prisma does: a field it leaves out matches any value. */
function artifactsTable(rows: Row[]) {
  const findFirst = vi.fn(({ where }: { where: Partial<Row> }) =>
    Promise.resolve(
      rows
        .filter((row) =>
          Object.entries(where).every(
            ([field, value]) => row[field as keyof Row] === value
          )
        )
        .map(({ id }) => ({ id }))[0] ?? null
    )
  );
  mockWithDbCall({ artifact: { findFirst } });
  return findFirst;
}

function change(overrides: Record<string, unknown> = {}) {
  const callback: DocSyncChangeCallback = {
    callbackId: "6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f",
    documentName: generateDocumentRoomId(ORG_A, SLUG),
    sources: [DocSyncChangeSource.Connection],
    editorUserIds: ["user-1"],
    firstChangedAt: "2026-10-22T10:00:00.000Z",
    lastChangedAt: "2026-10-22T10:00:02.000Z",
    mentions: [{ kind: DocSyncMentionKind.User, id: "user-2" }],
    mentionsTruncated: false,
  };
  return { ...callback, ...overrides };
}

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * A presigned STS URL as doc-sync's signer builds it. The stub STS below
 * stands in for SigV4 by reading the signed body hash out of
 * `X-Amz-Signature`.
 */
function stsUrl(
  signedBodySha256: string,
  host = "sts.us-east-1.amazonaws.com"
) {
  const url = new URL(`https://${host}/`);
  for (const [key, value] of Object.entries({
    ...STS_GET_CALLER_IDENTITY_QUERY,
    "X-Amz-Expires": String(DOC_SYNC_CALLBACK_SIGNATURE_TTL_SECONDS),
    "X-Amz-SignedHeaders": SIGNED_HEADERS,
    "X-Amz-Signature": signedBodySha256,
  })) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function request(
  body: string,
  headers: Record<string, string | undefined> = {}
): Request {
  const sent: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    "content-type": "application/json",
    [DocSyncCallbackHeader.Audience]: DOC_SYNC_CALLBACK_AUDIENCE,
    [DocSyncCallbackHeader.BodySha256]: sha256(body),
    [DocSyncCallbackHeader.StsUrl]: stsUrl(sha256(body)),
    ...headers,
  })) {
    if (value !== undefined) {
      sent[key] = value;
    }
  }
  return new Request("https://api.test/doc-sync/changes", {
    method: "POST",
    headers: sent,
    body,
  });
}

/** STS: 403 unless the replayed headers match what was signed, else the caller's ARN. */
function stubSts(callerArn: string) {
  const sts = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const signed =
      headers.get(DocSyncCallbackHeader.Audience) ===
        DOC_SYNC_CALLBACK_AUDIENCE &&
      headers.get(DocSyncCallbackHeader.BodySha256) ===
        url.searchParams.get("X-Amz-Signature");
    return Promise.resolve(
      signed
        ? Response.json({
            GetCallerIdentityResponse: {
              GetCallerIdentityResult: {
                Arn: callerArn,
                Account: "123456789012",
                UserId: "AROAEXAMPLE:0a1b2c3d4e5f",
              },
            },
          })
        : new Response("", { status: 403 })
    );
  });
  vi.stubGlobal("fetch", sts);
  return sts;
}

beforeEach(() => {
  mocks.env.DOC_SYNC_CALLBACK_ROLE_ARN = ROLE_ARN;
  artifactsTable([
    {
      id: DOCUMENT_ID,
      organizationId: ORG_A,
      slug: SLUG,
      type: ArtifactType.DOCUMENT,
    },
    {
      id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a61",
      organizationId: ORG_A,
      slug: BRANCH_SLUG,
      type: ArtifactType.BRANCH,
    },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  docSyncCallerRefusalThrottle.clear();
});

describe("POST /doc-sync/changes", () => {
  it("accepts a verified caller's callback 202 and hands it to receive", async () => {
    const sts = stubSts(CALLER_ARN);

    const response = await POST(request(JSON.stringify(change())));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      data: { callbackId: change().callbackId },
    });
    expect(sts).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(DOC_SYNC_CHANGE_RECEIVED_EVENT, {
      event: DOC_SYNC_CHANGE_RECEIVED_EVENT,
      documentId: DOCUMENT_ID,
      organizationId: ORG_A,
      callbackId: change().callbackId,
      sources: [DocSyncChangeSource.Connection],
      editorCount: 1,
      mentionCount: 1,
      mentionsTruncated: false,
    });
  });

  it("accepts a callback carrying a source and a field this API does not know", async () => {
    stubSts(CALLER_ARN);

    const response = await POST(
      request(
        JSON.stringify(
          change({
            sources: [DocSyncChangeSource.Connection, "added-later"],
            addedLater: true,
          })
        )
      )
    );

    expect(response.status).toBe(202);
  });

  it("answers 401 when STS names another role, logging the reason and not answering it", async () => {
    stubSts(OTHER_ROLE_CALLER_ARN);

    const response = await POST(request(JSON.stringify(change())));

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(DocSyncCallerRefusal.WrongRole);
    expect(log.error).toHaveBeenCalledWith(
      DOC_SYNC_CHANGE_CALLER_REFUSED_EVENT,
      expect.objectContaining({ reason: DocSyncCallerRefusal.WrongRole })
    );
  });

  it("answers 401 when STS cannot be reached, logging it as sts_unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed")))
    );

    const response = await POST(request(JSON.stringify(change())));

    expect(response.status).toBe(401);
    expect(log.error).toHaveBeenCalledWith(
      DOC_SYNC_CHANGE_CALLER_REFUSED_EVENT,
      expect.objectContaining({ reason: DocSyncCallerRefusal.StsUnavailable })
    );
  });

  it.each([
    ["the audience", DocSyncCallbackHeader.Audience],
    ["the body hash", DocSyncCallbackHeader.BodySha256],
  ])(
    "answers 401 without fetching to a presign that does not sign %s",
    async (_label, header) => {
      const sts = stubSts(CALLER_ARN);
      const body = JSON.stringify(change());
      const unsigned = new URL(stsUrl(sha256(body)));
      unsigned.searchParams.set(
        "X-Amz-SignedHeaders",
        SIGNED_HEADERS.split(";")
          .filter((signed) => signed !== header)
          .join(";")
      );

      const response = await POST(
        request(body, { [DocSyncCallbackHeader.StsUrl]: unsigned.toString() })
      );

      expect(response.status).toBe(401);
      expect(sts).not.toHaveBeenCalled();
    }
  );

  it("answers 401 without fetching to a presign with a second Action", async () => {
    const sts = stubSts(CALLER_ARN);
    const body = JSON.stringify(change());
    const doubled = new URL(stsUrl(sha256(body)));
    doubled.searchParams.append("Action", "AssumeRole");

    const response = await POST(
      request(body, { [DocSyncCallbackHeader.StsUrl]: doubled.toString() })
    );

    expect(response.status).toBe(401);
    expect(sts).not.toHaveBeenCalled();
  });

  it("answers 401 when the body hash header does not match the body, before asking STS", async () => {
    const sts = stubSts(CALLER_ARN);
    const body = JSON.stringify(change());

    const response = await POST(
      request(body, {
        [DocSyncCallbackHeader.BodySha256]: sha256("another body"),
      })
    );

    expect(response.status).toBe(401);
    expect(sts).not.toHaveBeenCalled();
  });

  it("answers 401 when the signature covers another body", async () => {
    stubSts(CALLER_ARN);
    const body = JSON.stringify(change());

    const response = await POST(
      request(body, {
        [DocSyncCallbackHeader.StsUrl]: stsUrl(sha256("the signed body")),
      })
    );

    expect(response.status).toBe(401);
  });

  it("answers 401 when the audience header is missing", async () => {
    stubSts(CALLER_ARN);

    const response = await POST(
      request(JSON.stringify(change()), {
        [DocSyncCallbackHeader.Audience]: undefined,
      })
    );

    expect(response.status).toBe(401);
  });

  it.each([
    "sts.attacker.example",
    "sts.s3.amazonaws.com",
    "sts.s3-external-1.amazonaws.com",
    "sts.s3-accelerate.amazonaws.com",
  ])("answers 401 without fetching when the STS URL names %s", async (host) => {
    const sts = stubSts(CALLER_ARN);
    const body = JSON.stringify(change());

    const response = await POST(
      request(body, {
        [DocSyncCallbackHeader.StsUrl]: stsUrl(sha256(body), host),
      })
    );

    expect(response.status).toBe(401);
    expect(sts).not.toHaveBeenCalled();
  });

  it("accepts a presign for a GovCloud region's STS", async () => {
    stubSts(CALLER_ARN);
    const body = JSON.stringify(change());

    const response = await POST(
      request(body, {
        [DocSyncCallbackHeader.StsUrl]: stsUrl(
          sha256(body),
          "sts.us-gov-west-1.amazonaws.com"
        ),
      })
    );

    expect(response.status).toBe(202);
  });

  it("logs a refusal once per reason per window, each reason on its own", async () => {
    stubSts(OTHER_ROLE_CALLER_ARN);
    await POST(request(JSON.stringify(change())));
    await POST(request(JSON.stringify(change())));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed")))
    );
    await POST(request(JSON.stringify(change())));
    await POST(request(JSON.stringify(change())));

    const refusals = vi
      .mocked(log.error)
      .mock.calls.filter(
        ([message]) => message === DOC_SYNC_CHANGE_CALLER_REFUSED_EVENT
      );
    expect(refusals).toEqual([
      [
        DOC_SYNC_CHANGE_CALLER_REFUSED_EVENT,
        expect.objectContaining({ reason: DocSyncCallerRefusal.WrongRole }),
      ],
      [
        DOC_SYNC_CHANGE_CALLER_REFUSED_EVENT,
        expect.objectContaining({
          reason: DocSyncCallerRefusal.StsUnavailable,
        }),
      ],
    ]);
  });

  it("answers 401 without fetching to a presign that outlives 60 s", async () => {
    const sts = stubSts(CALLER_ARN);
    const body = JSON.stringify(change());
    const longLived = new URL(stsUrl(sha256(body)));
    longLived.searchParams.set(
      "X-Amz-Expires",
      String(DOC_SYNC_CALLBACK_SIGNATURE_TTL_SECONDS + 1)
    );

    const response = await POST(
      request(body, { [DocSyncCallbackHeader.StsUrl]: longLived.toString() })
    );

    expect(response.status).toBe(401);
    expect(sts).not.toHaveBeenCalled();
  });

  it("answers 503 while DOC_SYNC_CALLBACK_ROLE_ARN is unset", async () => {
    const sts = stubSts(CALLER_ARN);
    mocks.env.DOC_SYNC_CALLBACK_ROLE_ARN = undefined;

    const response = await POST(request(JSON.stringify(change())));

    expect(response.status).toBe(503);
    expect(sts).not.toHaveBeenCalled();
  });

  it("answers 400 to a verified caller's malformed body", async () => {
    stubSts(CALLER_ARN);

    const malformed = await POST(
      request(JSON.stringify(change({ callbackId: "not-a-uuid" })))
    );
    const notJson = await POST(request("{"));

    expect(malformed.status).toBe(400);
    expect(notJson.status).toBe(400);
    expect(log.debug).not.toHaveBeenCalledWith(
      DOC_SYNC_CHANGE_RECEIVED_EVENT,
      expect.anything()
    );
  });

  it("answers 400 to a document name that is not a canonical room id", async () => {
    stubSts(CALLER_ARN);

    const response = await POST(
      request(JSON.stringify(change({ documentName: "doc-1" })))
    );

    expect(response.status).toBe(400);
  });

  it("answers 404 for an artifact in the organization that is not a document", async () => {
    stubSts(CALLER_ARN);

    const response = await POST(
      request(
        JSON.stringify(
          change({ documentName: generateDocumentRoomId(ORG_A, BRANCH_SLUG) })
        )
      )
    );

    expect(response.status).toBe(404);
  });

  it("answers 404 for an unknown document, and for one in another organization", async () => {
    stubSts(CALLER_ARN);

    const unknown = await POST(
      request(
        JSON.stringify(
          change({ documentName: generateDocumentRoomId(ORG_A, "PLN-404") })
        )
      )
    );
    const otherOrg = await POST(
      request(
        JSON.stringify(
          change({ documentName: generateDocumentRoomId(ORG_B, SLUG) })
        )
      )
    );

    expect(unknown.status).toBe(404);
    expect(otherOrg.status).toBe(404);
  });
});
