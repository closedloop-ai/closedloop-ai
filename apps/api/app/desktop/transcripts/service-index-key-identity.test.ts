/**
 * ISS-8286: the transcript lane resolving its session under ANY key that
 * session could be stored under.
 *
 * The ingest deliberately preserves an existing legacy raw key
 * (`findSessionDetailByAnyIndexKey` / `resolveStoredIndexKey`), so a session
 * whose `externalSessionId` was over the byte budget but inside the 2704-byte
 * btree tuple is sitting under its RAW value. Resolving only the PROJECTED key
 * left plan, complete and skip unable to link that session's transcript, and the
 * orphan backfill repeated the same miss — a permanently unlinked file with no
 * error anywhere.
 *
 * Its own `vi.mock` header rather than a case inside `service.test.ts`: vitest
 * hoists mocks per module, and that file is at the size ceiling.
 */
import type { TranscriptSyncPlanRequest } from "@repo/api/src/types/desktop-transcripts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = {
    sessionTranscript: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    sessionDetail: { findUnique: vi.fn() },
    $executeRaw: vi.fn(),
  };
  const withDb = Object.assign(
    vi.fn((fn: (client: typeof db) => unknown) => fn(db)),
    { tx: vi.fn((fn: (client: typeof db) => unknown) => fn(db)) }
  );
  const Prisma = {
    sql: (strings: TemplateStringsArray, ..._values: unknown[]) => ({
      text: strings.join(""),
    }),
  };
  return { db, withDb, Prisma, findOwnedById: vi.fn() };
});

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));
vi.mock("@repo/aws/transcript-storage", () => ({
  createTranscriptMultipartUpload: vi.fn(),
  copyTranscriptPart: vi.fn(),
  presignTranscriptUploadPart: vi.fn(),
  presignTranscriptPutObject: vi.fn(),
  listTranscriptParts: vi.fn(),
  completeTranscriptMultipartUpload: vi.fn(),
  headTranscriptObject: vi.fn(),
  abortTranscriptMultipartUpload: vi.fn(),
}));
vi.mock("@repo/observability/log", () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: { findOwnedById: mocks.findOwnedById },
}));

import {
  auth,
  baseDeps,
  CT,
  s3Port,
} from "@/__tests__/support/desktop/transcripts/service.test-fixtures";
import {
  INDEX_KEY_MAX_BYTES,
  projectIndexKey,
} from "@/lib/index-key-projection";
import { transcriptSyncService } from "./service";

/** Over the budget, so the ingest re-keyed it — the session this ticket is about. */
const LEGACY_RAW_SESSION_ID = "s".repeat(INDEX_KEY_MAX_BYTES + 1);
const PROJECTED_SESSION_ID = projectIndexKey(LEGACY_RAW_SESSION_ID).value;
const LEGACY_ARTIFACT_ID = "artifact-stored-under-raw-key";

function planRequest(): TranscriptSyncPlanRequest {
  return {
    computeTargetId: CT,
    externalSessionId: LEGACY_RAW_SESSION_ID,
    fileKey: "main",
    sourceHarness: "claude_code",
    sourcePathHash: "path-hash",
    planEndOffset: 1000,
    sha256: "b".repeat(64),
    crc64nvme: "crc-1",
  } as TranscriptSyncPlanRequest;
}

/** The `externalSessionId` of each `sessionDetail.findUnique` probe, in order. */
function probedSessionIds(): string[] {
  return mocks.db.sessionDetail.findUnique.mock.calls.map(
    (call) => call[0].where.computeTargetId_externalSessionId.externalSessionId
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOwnedById.mockResolvedValue({ id: CT });
  mocks.db.sessionTranscript.findUnique.mockResolvedValue(null);
  mocks.db.sessionTranscript.upsert.mockImplementation((args: never) => {
    const created = (args as { create: Record<string, unknown> }).create;
    return Promise.resolve({ id: "row-1", ...created });
  });
  mocks.db.sessionTranscript.update.mockResolvedValue({ id: "row-1" });
});

describe("transcript session identity (ISS-8286)", () => {
  it("links the transcript to a session still stored under its legacy RAW key", async () => {
    // The store holds the session under the raw id only — the projected probe
    // misses, and before this change the lane gave up there and left the
    // transcript unlinked forever.
    mocks.db.sessionDetail.findUnique.mockImplementation((args: never) => {
      const asked = (
        args as {
          where: {
            computeTargetId_externalSessionId: { externalSessionId: string };
          };
        }
      ).where.computeTargetId_externalSessionId.externalSessionId;
      return Promise.resolve(
        asked === LEGACY_RAW_SESSION_ID
          ? { artifactId: LEGACY_ARTIFACT_ID }
          : null
      );
    });

    await transcriptSyncService.planSync({
      ...auth,
      request: planRequest(),
      deps: baseDeps(s3Port()),
    });

    // Both candidates were genuinely probed, projected first.
    expect(probedSessionIds()).toEqual([
      PROJECTED_SESSION_ID,
      LEGACY_RAW_SESSION_ID,
    ]);
    // And the link actually landed on the legacy session, which is the point:
    // asserting only the probe would leave the association unpinned.
    const upsertArgs = mocks.db.sessionTranscript.upsert.mock.calls[0]?.[0] as {
      create: { sessionDetailId: string | null };
    };
    expect(upsertArgs.create.sessionDetailId).toBe(LEGACY_ARTIFACT_ID);
  });

  it("stops at the PROJECTED key when the session was written under it", async () => {
    // The ordinary post-ISS-8069 session: one probe, no extra round trip.
    mocks.db.sessionDetail.findUnique.mockImplementation((args: never) => {
      const asked = (
        args as {
          where: {
            computeTargetId_externalSessionId: { externalSessionId: string };
          };
        }
      ).where.computeTargetId_externalSessionId.externalSessionId;
      return Promise.resolve(
        asked === PROJECTED_SESSION_ID
          ? { artifactId: "artifact-current" }
          : null
      );
    });

    await transcriptSyncService.planSync({
      ...auth,
      request: planRequest(),
      deps: baseDeps(s3Port()),
    });

    expect(probedSessionIds()).toEqual([PROJECTED_SESSION_ID]);
  });
});
