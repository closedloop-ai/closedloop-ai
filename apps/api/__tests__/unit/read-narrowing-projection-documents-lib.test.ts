import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: { DOCUMENT: "DOCUMENT" },
  LinkType: { PRODUCES: "PRODUCES" },
  Prisma: { JsonNull: Symbol("Prisma.JsonNull") },
}));

vi.mock("@repo/aws", () => ({
  deleteArtifact: vi.fn(),
  getSignedDownloadUrl: vi.fn(),
  getSignedDownloadUrlWithDisposition: vi.fn(),
  getSignedUploadUrl: vi.fn(),
  putAttachmentObject: vi.fn(),
}));

vi.mock("@repo/aws/keys", () => ({
  keys: () => ({ FILE_ATTACHMENTS_BUCKET: "attachment-bucket" }),
}));

import { ArtifactActivityActorType } from "@repo/api/src/types/artifact-activity";
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
} from "@repo/api/src/types/artifact-activity-feed";
import { DesktopCommandStatus } from "@repo/api/src/types/compute-target";
import { getSignedDownloadUrlWithDisposition } from "@repo/aws";
import {
  createModelDouble,
  type Row,
} from "@/__tests__/support/read-narrowing-projection.test-db";
import { artifactActivityFeedService } from "@/app/documents/artifact-activity-feed-service";
import { attachmentsService } from "@/app/documents/attachments-service";
import { GET as getDocumentMeta } from "@/app/documents/by-slug/[slug]/meta/route";
import { documentEvaluationService } from "@/app/documents/evaluation-service";
import {
  fingerprintCommand,
  stripTransientCommandFields,
} from "@/lib/desktop-command-fingerprint";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { mockWithDbAll } from "../utils/db-helpers";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const COMMAND_ID = "33333333-3333-4333-8333-333333333333";
const DOC_ID = "44444444-4444-4444-8444-444444444444";
const ATTACHMENT_ID = "55555555-5555-4555-8555-555555555555";

const mockSignedDownloadUrl = getSignedDownloadUrlWithDisposition as Mock;

/**
 * Every column `desktop_commands` has. The two timeout columns exist only here:
 * nothing in `apps/api` reads them, which is the point of the assertions below.
 */
function commandRow(overrides: Row = {}): Row {
  return {
    id: COMMAND_ID,
    computeTargetId: TARGET_ID,
    idempotencyKey: "idem-1",
    requestFingerprint: "fingerprint-1",
    operationId: "op-1",
    requestPayload: {
      operationId: "op-1",
      method: "POST",
      path: "/api/gateway/run",
      headers: { "x-trace": "abc" },
      body: { command: "status" },
      timeoutMs: 5000,
      streaming: true,
    },
    status: DesktopCommandStatus.Running,
    error: null,
    lastSequenceAcked: 7,
    queuedTimeoutMs: 30_000,
    runningTimeoutMs: 60_000,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    // ISS-9630: the entry the current delivery was queued on. `acknowledgeCommand`
    // stamps `ackedAt` with it rather than with wall-clock now, so the read that
    // feeds that write has to project it.
    queuedAt: new Date("2026-02-01T00:00:00.000Z"),
    startedAt: new Date("2026-02-01T00:00:05.000Z"),
    finishedAt: null,
    ...overrides,
  };
}

const STORED_COMMAND_COLUMNS = [
  "id",
  "computeTargetId",
  "operationId",
  "status",
  "requestPayload",
  "error",
  "createdAt",
  "queuedAt",
  "startedAt",
  "finishedAt",
  "lastSequenceAcked",
  "idempotencyKey",
  "requestFingerprint",
];

function rateLimitRow(overrides: Row = {}): Row {
  return {
    id: "limit-1",
    bucket: "document_attachment_upload_request",
    subject: `${ORG_ID}:${DOC_ID}`,
    requestCount: 60,
    windowStartedAt: new Date("2026-02-01T00:00:00.000Z"),
    windowExpiresAt: new Date("2026-02-01T00:30:00.000Z"),
    updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    ...overrides,
  };
}

/** The `requireDocument` guard's row: org-scoped, DOCUMENT-typed. */
function documentArtifactRow(): Row {
  return { id: DOC_ID, organizationId: ORG_ID, type: "DOCUMENT" };
}

function organizationRow(overrides: Row = {}): Row {
  return {
    id: ORG_ID,
    clerkId: "org_clerk_1",
    active: true,
    name: "Acme",
    slug: "acme",
    claudeApiKeyEncrypted: "enc-claude-key",
    claudeApiKeyLastFour: "9999",
    claudeApiKeySetAt: new Date("2026-01-01T00:00:00.000Z"),
    settings: { computeMode: "cloud" },
    searchIncludeTranscripts: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("desktop command reads through the narrowed row", () => {
  it("still returns the full command summary a gateway client reads", async () => {
    const desktopCommand = createModelDouble([commandRow()]);
    mockWithDbAll({ desktopCommand });

    const summary = await desktopCommandStore.getCommand(TARGET_ID, COMMAND_ID);

    // The `desktop_commands` → `DesktopCommandSummary` wire shape, field by
    // field. Reddens if the select drops any column `toSummary` surfaces.
    // `requestFingerprint` is deliberately NOT one of them — it drives the
    // idempotency comparison instead, and has its own test below.
    expect(summary).toEqual({
      commandId: COMMAND_ID,
      computeTargetId: TARGET_ID,
      operationId: "op-1",
      status: DesktopCommandStatus.Running,
      error: undefined,
      createdAt: "2026-02-01T00:00:00.000Z",
      startedAt: "2026-02-01T00:00:05.000Z",
      finishedAt: undefined,
      lastSequenceAcked: 7,
      idempotencyKey: "idem-1",
    });
  });

  it("reads exactly the thirteen columns a stored command is made of", async () => {
    const desktopCommand = createModelDouble([commandRow()]);
    mockWithDbAll({ desktopCommand });

    await desktopCommandStore.getCommand(TARGET_ID, COMMAND_ID);

    // Exact, so it reddens on a dropped column AND on a widened select — the
    // latter is the failure `tsc` can never catch, because adding a column to
    // a `select` only ever widens the result type.
    expect(desktopCommand.returnedColumns).toEqual([STORED_COMMAND_COLUMNS]);
  });

  it("builds the dispatchable operation from the narrowed row's JSON payload", async () => {
    const desktopCommand = createModelDouble([
      commandRow(),
      commandRow({ id: "done-1", status: DesktopCommandStatus.Done }),
    ]);
    mockWithDbAll({ desktopCommand });

    const dispatchable =
      await desktopCommandStore.listNonTerminalDispatchCommands(TARGET_ID);

    // The relay redispatch payload: the request JSON column survives the
    // narrowing intact, and the terminal row stays filtered out.
    expect(dispatchable).toEqual([
      {
        commandId: COMMAND_ID,
        computeTargetId: TARGET_ID,
        operationId: "op-1",
        status: DesktopCommandStatus.Running,
        lastSequenceAcked: 7,
        method: "POST",
        path: "/api/gateway/run",
        headers: { "x-trace": "abc" },
        query: undefined,
        body: { command: "status" },
        timeoutMs: 5000,
        lockKey: undefined,
        requiresApproval: undefined,
        approvalReason: undefined,
        streaming: true,
        createdAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    expect(desktopCommand.returnedColumns).toEqual([STORED_COMMAND_COLUMNS]);
  });
});

describe("idempotent retry through the narrowed row", () => {
  it("dedupes a same-payload retry instead of raising a conflict", async () => {
    const input = {
      operationId: "op-1",
      method: "POST" as const,
      path: "/api/gateway/run",
      idempotencyKey: "idem-1",
    };
    const fingerprint = fingerprintCommand({
      ...stripTransientCommandFields(input),
      idempotencyKey: "idem-1",
    });
    const desktopCommand = createModelDouble([
      commandRow({ requestFingerprint: fingerprint, requestPayload: input }),
    ]);
    mockWithDbAll({ desktopCommand });

    const result = await desktopCommandStore.createCommand(TARGET_ID, input);

    // `requestFingerprint` is the ONLY column this path compares, and it never
    // reaches a wire shape — so dropping it from the select turns
    // `undefined !== fingerprint` into a permanent true and every legitimate
    // retry throws IdempotencyConflictError instead of deduping.
    expect(result.deduped).toBe(true);
    expect(result.command.commandId).toBe(COMMAND_ID);
  });
});

describe("attachment upload limiter read", () => {
  it("derives retryAfterSeconds from the narrowed limiter row", async () => {
    vi.setSystemTime(new Date("2026-02-01T00:29:31.000Z"));
    const oAuthRateLimit = createModelDouble([rateLimitRow()]);
    mockWithDbAll({
      oAuthRateLimit,
      artifact: createModelDouble([documentArtifactRow()]),
    });

    const result = await attachmentsService.requestDirectUpload(
      DOC_ID,
      ORG_ID,
      "user-1",
      "notes.pdf",
      "application/pdf",
      1024
    );

    // 29s of window left, rounded up. Reddens if `windowExpiresAt` leaves the
    // select: the limiter would read `undefined` and never produce a retry
    // hint at all.
    expect(result).toEqual({
      ok: false,
      error: { type: "rate_limited", retryAfterSeconds: 29 },
    });
    vi.useRealTimers();
  });

  it("reads only the three limiter columns, never the window bookkeeping", async () => {
    vi.setSystemTime(new Date("2026-02-01T00:29:31.000Z"));
    const oAuthRateLimit = createModelDouble([rateLimitRow()]);
    mockWithDbAll({
      oAuthRateLimit,
      artifact: createModelDouble([documentArtifactRow()]),
    });

    await attachmentsService.requestDirectUpload(
      DOC_ID,
      ORG_ID,
      "user-1",
      "notes.pdf",
      "application/pdf",
      1024
    );

    // Two reads: the in-transaction lookup, then the re-read after the gated
    // `updateMany` matched nothing. Both are narrowed, and neither returns
    // `windowStartedAt`/`updatedAt`, which the limiter only ever writes.
    expect(oAuthRateLimit.returnedColumns).toEqual([
      ["id", "requestCount", "windowExpiresAt"],
      ["id", "requestCount", "windowExpiresAt"],
    ]);
    vi.useRealTimers();
  });
});

describe("attachment download read", () => {
  it("presigns with the three columns the narrowed row carries", async () => {
    mockSignedDownloadUrl.mockResolvedValue("https://s3.example/signed");
    const fileAttachment = createModelDouble([
      {
        id: ATTACHMENT_ID,
        artifactId: DOC_ID,
        bucket: "attachment-bucket",
        key: "orgs/acme/notes.pdf",
        filename: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        purpose: "context",
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        createdById: "user-1",
        reconciledAt: new Date("2026-02-01T00:00:00.000Z"),
        reconcileAbsent: false,
      },
    ]);
    mockWithDbAll({
      artifact: createModelDouble([documentArtifactRow()]),
      fileAttachment,
    });

    const result = await attachmentsService.getDownloadUrl(
      DOC_ID,
      ORG_ID,
      ATTACHMENT_ID
    );

    // The outbound presign is the observable consumer: each of the three
    // narrowed columns is a positional argument, so dropping any one of them
    // signs the wrong object, names the wrong file, or targets no bucket.
    expect(mockSignedDownloadUrl).toHaveBeenCalledWith(
      "orgs/acme/notes.pdf",
      "notes.pdf",
      3600,
      "attachment-bucket"
    );
    expect(result).toEqual({ downloadUrl: "https://s3.example/signed" });
    expect(fileAttachment.returnedColumns).toEqual([
      ["bucket", "filename", "key"],
    ]);
  });
});

describe("document rating summary read", () => {
  it("renders the caller's own rating from the narrowed row", async () => {
    const artifactRating = createModelDouble([
      {
        id: "rating-1",
        artifactId: DOC_ID,
        userId: "user-1",
        organizationId: ORG_ID,
        score: 4,
        comment: "reads well",
        artifactVersion: 3,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date("2026-02-02T00:00:00.000Z"),
      },
    ]);
    mockWithDbAll({
      artifactRating: {
        ...artifactRating,
        aggregate: vi.fn(() => Promise.resolve({ _avg: { score: 4 } })),
        count: vi.fn(() => Promise.resolve(1)),
      },
    });

    const summary = await documentEvaluationService.getRating(
      DOC_ID,
      "user-1",
      ORG_ID
    );

    // Every nullable column carries a NON-null fixture value on purpose: with
    // `comment: null` / `artifactVersion: null` the mapper's `?? undefined` and
    // `?? 0` fallbacks make an ABSENT column and a null one indistinguishable,
    // and the behaviour assertion could not redden on a dropped column at all.
    expect(summary).toEqual({
      average: 4,
      count: 1,
      userRating: {
        id: "rating-1",
        userId: "user-1",
        score: 4,
        comment: "reads well",
        documentVersion: 3,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        updatedAt: new Date("2026-02-02T00:00:00.000Z"),
      },
    });
    // The lookup key columns are not part of the summary and stay unread.
    expect(artifactRating.returnedColumns).toEqual([
      [
        "id",
        "userId",
        "score",
        "comment",
        "artifactVersion",
        "createdAt",
        "updatedAt",
      ],
    ]);
  });
});

describe("artifact activity feed event projection", () => {
  it("projects a stored event without restating the feed's own scope", async () => {
    const artifactActivityEvent = createModelDouble([
      {
        id: "event-1",
        organizationId: ORG_ID,
        artifactId: DOC_ID,
        actorType: ArtifactActivityActorType.User,
        actorId: "user-1",
        action: "status_changed",
        before: { status: "TODO" },
        after: { status: "IN_PROGRESS" },
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);
    mockWithDbAll({
      artifactActivityEvent,
      documentVersion: createModelDouble([]),
      artifactLink: createModelDouble([]),
      loop: createModelDouble([]),
      artifactEvaluation: createModelDouble([]),
    });

    const feed = await artifactActivityFeedService.listActivityFeed({
      organizationId: ORG_ID,
      artifactId: DOC_ID,
    });

    expect(feed.items).toEqual([
      {
        id: `${ActivityFeedItemSource.Event}:event-1`,
        source: ActivityFeedItemSource.Event,
        action: "status_changed",
        actor: { kind: ActivityFeedActorKind.Human, id: "user-1" },
        before: { status: "TODO" },
        after: { status: "IN_PROGRESS" },
        payload: null,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      },
    ]);
    expect(artifactActivityEvent.returnedColumns).toEqual([
      ["id", "action", "actorType", "actorId", "before", "after", "createdAt"],
    ]);
  });
});

describe("public document-meta org lookup", () => {
  it("unfurls the document without reading an org credential column", async () => {
    const organization = createModelDouble([organizationRow()]);
    mockWithDbAll({
      organization,
      artifact: createModelDouble([
        {
          organizationId: ORG_ID,
          slug: "ISS-1",
          type: "DOCUMENT",
          name: "Reads audit",
          subtype: "FEATURE",
          status: "IN_PROGRESS",
        },
      ]),
    });

    const response = await getDocumentMeta(
      new Request("https://api.test/documents/by-slug/ISS-1/meta?org=acme"),
      { params: Promise.resolve({ slug: "ISS-1" }) }
    );

    expect(await response.json()).toEqual({
      title: "Reads audit",
      type: "FEATURE",
      status: "IN_PROGRESS",
    });
    // This endpoint takes no auth. The org row it resolves is a lookup, not a
    // payload, so `claudeApiKeyEncrypted` and the settings blob must never
    // enter the process — exact, so re-widening the select reddens here.
    expect(organization.returnedColumns).toEqual([["id"]]);
  });
});
