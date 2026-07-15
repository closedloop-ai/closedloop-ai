import {
  TranscriptAvailability,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const db = {
    sessionDetail: { findFirst: vi.fn() },
    sessionTranscript: { findMany: vi.fn() },
  };
  const withDb = vi.fn((fn: (client: typeof db) => unknown) => fn(db));
  return { db, withDb };
});

vi.mock("@repo/database", () => ({ withDb: mocks.withDb }));
// The service imports the real minting helper; tests inject a fake via deps, so
// this mock only prevents the AWS SDK from loading at import time.
vi.mock("@repo/aws", () => ({ getSignedTranscriptDownloadUrl: vi.fn() }));

import { getSignedTranscriptDownloadUrl } from "@repo/aws";
import {
  transcriptReadService,
  transcriptReadServiceInternalsForTesting,
} from "./transcript-read-service";

const mintSpy = vi.mocked(getSignedTranscriptDownloadUrl);

const ORG = "org-1";
const SESSION_ID = "artifact-1";
const CT = "target-1";
const EXT = "ext-session-1";
const MAIN_KEY = `${ORG}/${CT}/${EXT}.jsonl`;
const UPLOADED_AT = new Date("2026-07-08T12:00:00.000Z");

type TranscriptRow = {
  fileKey: string;
  objectStorageKey: string;
  uploadStatus: string;
  uploadedAt: Date | null;
  lastObservedAt: Date;
  rawByteSize: bigint | null;
  rawSha256: string | null;
  storedEtag: string | null;
};

const MAIN_ETAG = "etag-main";

function transcriptRow(overrides: Partial<TranscriptRow> = {}): TranscriptRow {
  return {
    fileKey: "main",
    objectStorageKey: MAIN_KEY,
    uploadStatus: TranscriptUploadStatus.Uploaded,
    uploadedAt: UPLOADED_AT,
    lastObservedAt: UPLOADED_AT,
    rawByteSize: 2048n,
    rawSha256: "a".repeat(64),
    storedEtag: MAIN_ETAG,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.sessionDetail.findFirst.mockResolvedValue({
    computeTargetId: CT,
    externalSessionId: EXT,
  });
  mocks.db.sessionTranscript.findMany.mockResolvedValue([]);
});

describe("transcriptReadService.findTranscriptAccess", () => {
  it("returns null when the session is outside the caller's org scope (AC10)", async () => {
    mocks.db.sessionDetail.findFirst.mockResolvedValue(null);

    const result = await transcriptReadService.findTranscriptAccess({
      id: SESSION_ID,
      organizationId: ORG,
    });

    expect(result).toBeNull();
    // No transcript rows are read and no URL is minted for an unauthorized caller.
    expect(mocks.db.sessionTranscript.findMany).not.toHaveBeenCalled();
  });

  it("scopes the session lookup to the artifact id + organization", async () => {
    await transcriptReadService.findTranscriptAccess({
      id: SESSION_ID,
      organizationId: ORG,
    });

    expect(mocks.db.sessionDetail.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          artifactId: SESSION_ID,
          artifact: { is: { organizationId: ORG } },
        },
      })
    );
  });

  it("looks up transcripts by session identity, not the nullable sessionDetailId", async () => {
    await transcriptReadService.findTranscriptAccess({
      id: SESSION_ID,
      organizationId: ORG,
    });

    expect(mocks.db.sessionTranscript.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          computeTargetId: CT,
          externalSessionId: EXT,
        },
      })
    );
  });

  it("surfaces a synthetic missing main file when no transcript rows exist (AC6)", async () => {
    const mintDownloadUrl = vi.fn();

    const result = await transcriptReadService.findTranscriptAccess({
      id: SESSION_ID,
      organizationId: ORG,
      deps: { mintDownloadUrl },
    });

    expect(result).toEqual({
      sessionId: SESSION_ID,
      files: [
        {
          fileKey: "main",
          availability: TranscriptAvailability.Missing,
          url: null,
          byteSize: null,
          rawSha256: null,
          uploadedAt: null,
          lastObservedAt: null,
        },
      ],
    });
    expect(mintDownloadUrl).not.toHaveBeenCalled();
  });

  it("synthesizes a missing main file when only subagent rows exist", async () => {
    mocks.db.sessionTranscript.findMany.mockResolvedValue([
      transcriptRow({
        fileKey: "subagent:a",
        objectStorageKey: "subagent-a-key",
        storedEtag: "etag-subagent-a",
      }),
    ]);
    const mintDownloadUrl = vi.fn().mockResolvedValue("https://s3/subagent");

    const result = await transcriptReadService.findTranscriptAccess({
      id: SESSION_ID,
      organizationId: ORG,
      deps: { mintDownloadUrl },
    });

    // Main is always represented — surfaced as missing (no URL) — while the
    // present subagent row maps and signs normally (regression: the old
    // rows.length === 0 gate dropped main entirely here).
    expect(result?.files).toEqual([
      {
        fileKey: "main",
        availability: TranscriptAvailability.Missing,
        url: null,
        byteSize: null,
        rawSha256: null,
        uploadedAt: null,
        lastObservedAt: null,
      },
      expect.objectContaining({
        fileKey: "subagent:a",
        availability: TranscriptAvailability.Available,
        url: "https://s3/subagent",
      }),
    ]);
    expect(mintDownloadUrl).toHaveBeenCalledTimes(1);
    expect(mintDownloadUrl).toHaveBeenCalledWith(
      "subagent-a-key",
      "etag-subagent-a"
    );
  });

  it("mints a signed URL for an available file and maps its fields", async () => {
    mocks.db.sessionTranscript.findMany.mockResolvedValue([transcriptRow()]);
    const mintDownloadUrl = vi.fn().mockResolvedValue("https://s3/signed-main");

    const result = await transcriptReadService.findTranscriptAccess({
      id: SESSION_ID,
      organizationId: ORG,
      deps: { mintDownloadUrl },
    });

    expect(mintDownloadUrl).toHaveBeenCalledTimes(1);
    expect(mintDownloadUrl).toHaveBeenCalledWith(MAIN_KEY, MAIN_ETAG);
    expect(result?.files).toEqual([
      {
        fileKey: "main",
        availability: TranscriptAvailability.Available,
        url: "https://s3/signed-main",
        byteSize: 2048,
        rawSha256: "a".repeat(64),
        uploadedAt: UPLOADED_AT.toISOString(),
        lastObservedAt: UPLOADED_AT.toISOString(),
      },
    ]);
  });

  it("never mints a URL for pending or failed files", async () => {
    mocks.db.sessionTranscript.findMany.mockResolvedValue([
      transcriptRow({
        fileKey: "main",
        uploadStatus: TranscriptUploadStatus.Uploading,
        uploadedAt: null,
        rawByteSize: null,
        rawSha256: null,
      }),
      transcriptRow({
        fileKey: "subagent:x",
        uploadStatus: TranscriptUploadStatus.Failed,
        uploadedAt: null,
        rawByteSize: null,
        rawSha256: null,
      }),
    ]);
    const mintDownloadUrl = vi.fn();

    const result = await transcriptReadService.findTranscriptAccess({
      id: SESSION_ID,
      organizationId: ORG,
      deps: { mintDownloadUrl },
    });

    expect(mintDownloadUrl).not.toHaveBeenCalled();
    expect(
      result?.files.map((f) => [f.fileKey, f.availability, f.url])
    ).toEqual([
      ["main", TranscriptAvailability.UploadPending, null],
      ["subagent:x", TranscriptAvailability.UploadFailed, null],
    ]);
  });

  it("mints URLs only for readable files in a mixed multi-file session", async () => {
    mocks.db.sessionTranscript.findMany.mockResolvedValue([
      transcriptRow({ fileKey: "main" }),
      transcriptRow({
        fileKey: "subagent:a",
        uploadStatus: TranscriptUploadStatus.Pending,
        uploadedAt: null,
        rawByteSize: null,
        rawSha256: null,
      }),
    ]);
    const mintDownloadUrl = vi.fn().mockResolvedValue("https://s3/main");

    const result = await transcriptReadService.findTranscriptAccess({
      id: SESSION_ID,
      organizationId: ORG,
      deps: { mintDownloadUrl },
    });

    expect(mintDownloadUrl).toHaveBeenCalledTimes(1);
    expect(mintDownloadUrl).toHaveBeenCalledWith(MAIN_KEY, MAIN_ETAG);
    expect(result?.files.map((f) => [f.fileKey, f.availability])).toEqual([
      ["main", TranscriptAvailability.Available],
      ["subagent:a", TranscriptAvailability.UploadPending],
    ]);
  });
});

describe("default signed-URL caching (FEA-2882)", () => {
  // Exercises the real `defaultMintDownloadUrl` (no injected `deps`) so the
  // module-level bounded cache is under test. Each case uses a unique
  // (objectStorageKey, etag) so entries never collide with a sibling case — the
  // process-wide cache is not reset between tests.
  // The signed-URL cache and the mint spy both persist across tests; reset each
  // case so an entry or a queued implementation can't leak into the next.
  beforeEach(() => {
    mintSpy.mockReset();
    transcriptReadServiceInternalsForTesting.clearDownloadUrlCache();
  });

  async function access(row: Partial<TranscriptRow>): Promise<string | null> {
    const built = transcriptRow(row);
    mocks.db.sessionTranscript.findMany.mockResolvedValue([built]);
    const result = await transcriptReadService.findTranscriptAccess({
      id: SESSION_ID,
      organizationId: ORG,
    });
    return result?.files.find((f) => f.fileKey === built.fileKey)?.url ?? null;
  }

  it("reuses a cached URL for the same (key, etag) across repeated polls", async () => {
    mintSpy.mockResolvedValue("https://s3/cache-hit");

    const first = await access({ objectStorageKey: "k-hit", storedEtag: "e1" });
    const second = await access({
      objectStorageKey: "k-hit",
      storedEtag: "e1",
    });

    // Only one signature is minted; the second poll returns the same URL so the
    // browser can serve the transcript bytes from its own HTTP cache.
    expect(mintSpy).toHaveBeenCalledTimes(1);
    expect(mintSpy).toHaveBeenCalledWith("k-hit", {
      expiresIn: expect.any(Number),
    });
    expect(first).toBe("https://s3/cache-hit");
    expect(second).toBe("https://s3/cache-hit");
  });

  it("mints a fresh URL when the object's etag changes (copy-append)", async () => {
    mintSpy.mockResolvedValueOnce("https://s3/etag-old");
    mintSpy.mockResolvedValueOnce("https://s3/etag-new");

    const before = await access({
      objectStorageKey: "k-etag",
      storedEtag: "v1",
    });
    const after = await access({
      objectStorageKey: "k-etag",
      storedEtag: "v2",
    });

    expect(mintSpy).toHaveBeenCalledTimes(2);
    expect(before).toBe("https://s3/etag-old");
    expect(after).toBe("https://s3/etag-new");
  });

  it("never caches when the etag is unknown (null)", async () => {
    mintSpy.mockResolvedValueOnce("https://s3/null-1");
    mintSpy.mockResolvedValueOnce("https://s3/null-2");

    const first = await access({
      objectStorageKey: "k-null",
      storedEtag: null,
    });
    const second = await access({
      objectStorageKey: "k-null",
      storedEtag: null,
    });

    expect(mintSpy).toHaveBeenCalledTimes(2);
    expect(first).toBe("https://s3/null-1");
    expect(second).toBe("https://s3/null-2");
  });
});
