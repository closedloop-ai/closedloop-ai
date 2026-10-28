/**
 * ISS-8256 — the over-long transcript identity at the SYNC-PLAN ROUTE boundary,
 * against real Postgres.
 *
 * WHY THIS EXISTS BESIDE THE ISS-8125 SUITE. That suite drives
 * `transcriptSyncService.planSync` DIRECTLY with 4096-byte identity strings, and
 * the route caps the serialized body at {@link TRANSCRIPT_SYNC_PLAN_MAX_BYTES}.
 * A 4 KB pair does not fit, so that fixture can never reach the production
 * route: its green says the SERVICE accepts an over-budget identity and says
 * nothing about whether the route does. The realistic shape — an identity past
 * the projection budget inside a body the route still admits — was untested.
 *
 * SIZED AGAINST THE BUDGETS THAT ACTUALLY BIND, imported rather than retyped:
 * `externalSessionId` past {@link INDEX_KEY_MAX_BYTES} (the shared session
 * identity budget `SessionDetail` also holds) and `fileKey` past
 * {@link TRANSCRIPT_FILE_KEY_MAX_BYTES} (solved from S3's 1024-byte object-key
 * limit, so it is the tighter of the two and is NOT 512). The body is asserted
 * under the route cap in the same act, so the fixture cannot silently drift back
 * into the shape that could not reach the route.
 *
 * REAL ROUTE, MOCKED EDGES. `withAnyAuth` and the S3 port are mocked — the
 * channel and the object store are not what this pins — but the route handler,
 * its Zod parse, its body cap, the service, the projection and the write are all
 * production code on a real database.
 */

import { TranscriptForbiddenCode } from "@repo/api/src/types/desktop-transcripts";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The seeded principal, shaped as the route actually reads it (#7213 review,
 * whitlockk). The handler takes `user.id`, so a mock carrying only `userId` handed
 * the ownership lookup `userId: undefined` — and Prisma DROPS an undefined
 * filter rather than matching nothing, so `findOwnedById` silently degraded to
 * an org-only lookup. The suite stayed green while never exercising the
 * per-user half of the ownership check at all.
 */
const mocks = vi.hoisted(() => ({
  auth: { id: "", organizationId: "" } as {
    id: string;
    organizationId: string;
  },
  presignPutObject: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) => {
      if (!(mocks.auth.organizationId && mocks.auth.id)) {
        throw new Error("seeded auth must be set before invoking the route");
      }
      return handler({ user: mocks.auth, clerkUserId: null }, request);
    },
}));

vi.mock("@/app/desktop/transcripts/transcript-s3-port", () => ({
  defaultS3Port: {
    createMultipartUpload: vi.fn().mockResolvedValue({ uploadId: "up-new" }),
    copyPart: vi.fn().mockResolvedValue({ partNumber: 1, etag: "copy-etag" }),
    presignUploadPart: vi.fn().mockResolvedValue("https://s3/part"),
    presignPutObject: mocks.presignPutObject,
    listParts: vi.fn().mockResolvedValue([]),
    completeMultipartUpload: vi
      .fn()
      .mockResolvedValue({ etag: "final-etag", checksumCrc64Nvme: "crc-1" }),
    headObject: vi.fn().mockResolvedValue(null),
    abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  createSyncFixture,
  overLimitValue,
  S3_OBJECT_KEY_MAX_BYTES,
} from "@/__tests__/support/index-key-poison.test-fixtures";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { TRANSCRIPT_SYNC_PLAN_MAX_BYTES } from "@/app/desktop/transcripts/sync-plan/max-bytes";
import { POST as syncPlanPost } from "@/app/desktop/transcripts/sync-plan/route";
import { TRANSCRIPT_FILE_KEY_MAX_BYTES } from "@/app/desktop/transcripts/transcript-index-keys";
import { INDEX_KEY_MAX_BYTES } from "@/lib/index-key-projection";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const organizations = createCommittedTestOrganizationTracker();
const ROUTE_URL = "https://api.closedloop.ai/desktop/transcripts/sync-plan";
const PLAN_END_OFFSET = 1000;
const ROUTE_CONTEXT = { params: Promise.resolve({}) };

/**
 * Past a budget by a comfortable margin and HIGH-ENTROPY, because an index tuple
 * can be compressed inline: a low-entropy filler is accepted by the engine even
 * over the limit, which would make this suite pass on unfixed code.
 */
function overBudget(seed: string, budget: number): string {
  return overLimitValue(seed).slice(0, budget + 64);
}

function planBody(input: {
  computeTargetId: string;
  externalSessionId: string;
  fileKey: string;
}) {
  return {
    ...input,
    sourceHarness: "claude_code",
    sourcePathHash: "path-hash",
    planEndOffset: PLAN_END_OFFSET,
    sha256: "a".repeat(64),
    crc64nvme: "crc-1",
    sourceMtime: new Date(1_700_000_000_000).toISOString(),
  };
}

function readTranscripts(computeTargetId: string) {
  return withDb((db) =>
    db.sessionTranscript.findMany({
      where: { computeTargetId },
      select: {
        externalSessionId: true,
        fileKey: true,
        objectStorageKey: true,
        uploadStatus: true,
        syncedByteOffset: true,
      },
    })
  );
}

describeIfDb("POST /desktop/transcripts/sync-plan — over-long identity", () => {
  beforeEach(() => {
    // RESET, not just re-stub. `presignPutObject` is file-scoped, so its call
    // record outlives a case: the denial case below asserts it was never
    // called, and the 200 case above it mints one — leaving that history in
    // place made the denial case fail on the PREVIOUS case's call rather than
    // on anything the denied request did.
    mocks.presignPutObject.mockReset();
    mocks.presignPutObject.mockResolvedValue("https://s3/put");
  });

  afterEach(async () => {
    mocks.auth.organizationId = "";
    mocks.auth.id = "";
    await organizations.cleanup();
  });

  it("accepts an identity over both projection budgets in a body under the route cap, and persists the projected row", async () => {
    const organizationId = await organizations.create();
    const fixture = await createSyncFixture(organizationId, "iss-8256-route");
    mocks.auth.organizationId = organizationId;
    mocks.auth.id = fixture.userId;

    const externalSessionId = overBudget("iss-8256-sid", INDEX_KEY_MAX_BYTES);
    const fileKey = `subagent:${overBudget(
      "iss-8256-file",
      TRANSCRIPT_FILE_KEY_MAX_BYTES
    )}`;
    const body = planBody({
      computeTargetId: fixture.computeTargetId,
      externalSessionId,
      fileKey,
    });
    const serialized = JSON.stringify(body);

    // The whole point of this case: both strings are past the budget that binds
    // them, and the request STILL fits the control-plane cap. The ISS-8125
    // fixture fails this assertion, which is why it never reached the route.
    expect(Buffer.byteLength(externalSessionId, "utf8")).toBeGreaterThan(
      INDEX_KEY_MAX_BYTES
    );
    expect(Buffer.byteLength(fileKey, "utf8")).toBeGreaterThan(
      TRANSCRIPT_FILE_KEY_MAX_BYTES
    );
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(
      TRANSCRIPT_SYNC_PLAN_MAX_BYTES
    );

    const response = await syncPlanPost(
      new NextRequest(ROUTE_URL, { method: "POST", body: serialized }),
      ROUTE_CONTEXT
    );

    // The CONSUMER-VISIBLE result: the desktop is handed a real upload plan, not
    // a 4xx it would classify and back off on.
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success: boolean;
      data: { mode: string; url: string; planEndOffset: number };
    };
    expect(payload.success).toBe(true);
    expect(payload.data.mode).toBe("fullPut");
    expect(payload.data.planEndOffset).toBe(PLAN_END_OFFSET);

    // The PERSISTED row: one row, keyed on the projected identity rather than
    // the raw wire pair, and its derived object key agrees with the columns.
    const rows = await readTranscripts(fixture.computeTargetId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.uploadStatus).toBe("uploading");
    expect(row?.externalSessionId).not.toBe(externalSessionId);
    expect(row?.fileKey).not.toBe(fileKey);
    expect(
      Buffer.byteLength(row?.externalSessionId ?? "", "utf8")
    ).toBeLessThanOrEqual(INDEX_KEY_MAX_BYTES);
    expect(Buffer.byteLength(row?.fileKey ?? "", "utf8")).toBeLessThanOrEqual(
      TRANSCRIPT_FILE_KEY_MAX_BYTES + "subagent:".length
    );
    expect(row?.objectStorageKey).toContain(row?.externalSessionId ?? "");
    expect(row?.objectStorageKey).not.toContain(externalSessionId);
    // Asserted against S3's own number, never against the constant under test:
    // a regression in the budget fails here instead of moving with the bug.
    expect(
      Buffer.byteLength(row?.objectStorageKey ?? "", "utf8")
    ).toBeLessThanOrEqual(S3_OBJECT_KEY_MAX_BYTES);
    // The subagent namespace survives the bound: a projected file key that lost
    // its prefix would reshape the S3 key into the main-transcript namespace.
    expect(row?.fileKey.startsWith("subagent:")).toBe(true);
    // The presigned PUT is minted for the SAME key the row holds — a raw-pair
    // key here would be a row that landed while its bytes never could.
    expect(mocks.presignPutObject).toHaveBeenCalledWith(
      expect.objectContaining({ key: row?.objectStorageKey })
    );
  });

  it("denies a same-org caller who does not own the compute target, and writes nothing", async () => {
    const organizationId = await organizations.create();
    const fixture = await createSyncFixture(organizationId, "iss-8256-denied");
    // Same tenant, different person: `findOwnedById` scopes on BOTH, so an
    // org-only lookup would admit this caller.
    const intruder = await createTestUser(organizationId);
    mocks.auth.organizationId = organizationId;
    mocks.auth.id = intruder.id;

    const response = await syncPlanPost(
      new NextRequest(ROUTE_URL, {
        method: "POST",
        body: JSON.stringify(
          planBody({
            computeTargetId: fixture.computeTargetId,
            externalSessionId: overBudget(
              "iss-8256-denied",
              INDEX_KEY_MAX_BYTES
            ),
            fileKey: "main",
          })
        ),
      }),
      ROUTE_CONTEXT
    );

    // The NEGATIVE control the 200 cases above cannot supply on their own: they
    // pass whether or not the per-user half of the ownership check runs, which
    // is exactly how the `userId: undefined` mock went unnoticed. Dropping
    // `userId` from `findOwnedById`'s `where` turns this 403 into a 200.
    expect(response.status).toBe(403);
    // The CODE, not just the status: an org policy denial is also a 403, so a
    // status-only assertion would pass on a case that never reached the
    // ownership check at all.
    expect(await response.json()).toEqual(
      expect.objectContaining({
        success: false,
        code: TranscriptForbiddenCode.NotOwned,
      })
    );
    expect(await readTranscripts(fixture.computeTargetId)).toHaveLength(0);
    expect(mocks.presignPutObject).not.toHaveBeenCalled();
  });

  it("re-planning the same over-long identity through the route resolves to the same row", async () => {
    const organizationId = await organizations.create();
    const fixture = await createSyncFixture(organizationId, "iss-8256-replan");
    mocks.auth.organizationId = organizationId;
    mocks.auth.id = fixture.userId;

    const body = planBody({
      computeTargetId: fixture.computeTargetId,
      externalSessionId: overBudget("iss-8256-replan", INDEX_KEY_MAX_BYTES),
      fileKey: "main",
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await syncPlanPost(
        new NextRequest(ROUTE_URL, {
          method: "POST",
          body: JSON.stringify(body),
        }),
        ROUTE_CONTEXT
      );
      expect(response.status).toBe(200);
    }

    // The projection is deterministic, so the second plan must find the row the
    // first wrote rather than mint a second one under a different key.
    expect(await readTranscripts(fixture.computeTargetId)).toHaveLength(1);
  });
});
