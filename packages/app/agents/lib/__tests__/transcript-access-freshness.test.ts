import {
  type TranscriptAccessResponse,
  TranscriptAvailability,
  type TranscriptFileDescriptor,
} from "@repo/api/src/types/desktop-transcripts";
import { describe, expect, it } from "vitest";
import { MAIN_TRANSCRIPT_FILE_KEY } from "../session-transcript-href";
import {
  missingTranscriptRefetchIntervalMs,
  signedUrlExpiresAtMs,
  TRANSCRIPT_MISSING_REFETCH_CAP_MS,
  TRANSCRIPT_MISSING_REFETCH_MAX_INTERVAL_MS,
  TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS,
  TRANSCRIPT_URL_REUSE_MARGIN_MS,
  TranscriptPollState,
  transcriptAccessStaleTimeMs,
  transcriptPollState,
} from "../transcript-access-freshness";

const SIGNED_AT_MS = Date.UTC(2026, 9, 8, 12, 0, 0);
const SIGNED_URL =
  "https://bucket.s3.amazonaws.com/main.jsonl?X-Amz-Date=20261008T120000Z&X-Amz-Expires=300&X-Amz-Signature=abc";
const SUBAGENT_KEY = "subagent:a";

function file(
  fileKey: string,
  overrides: Partial<TranscriptFileDescriptor> = {}
): TranscriptFileDescriptor {
  return {
    fileKey,
    availability: TranscriptAvailability.Available,
    url: null,
    byteSize: 1,
    rawSha256: "a".repeat(64),
    uploadedAt: null,
    lastObservedAt: null,
    permanentFailureReason: null,
    ...overrides,
  };
}

function access(files: TranscriptFileDescriptor[]): TranscriptAccessResponse {
  return { sessionId: "session-1", files };
}

describe("signedUrlExpiresAtMs", () => {
  it("reads the expiry a SigV4 presigned URL carries", () => {
    expect(signedUrlExpiresAtMs(SIGNED_URL)).toBe(SIGNED_AT_MS + 300_000);
  });

  it.each([
    ["no url", null],
    ["an unparseable url", "not a url"],
    ["no signing params", "https://s3.invalid/main.jsonl"],
    [
      "a malformed date",
      "https://s3.invalid/m?X-Amz-Date=yesterday&X-Amz-Expires=300",
    ],
    [
      "a non-numeric expiry",
      "https://s3.invalid/m?X-Amz-Date=20261008T120000Z&X-Amz-Expires=-5",
    ],
  ])("is null for %s", (_label, url) => {
    expect(signedUrlExpiresAtMs(url)).toBeNull();
  });
});

describe("transcriptAccessStaleTimeMs", () => {
  it("stays fresh until the requested file's URL nears expiry", () => {
    const data = access([file(MAIN_TRANSCRIPT_FILE_KEY, { url: SIGNED_URL })]);
    expect(
      transcriptAccessStaleTimeMs(data, MAIN_TRANSCRIPT_FILE_KEY, SIGNED_AT_MS)
    ).toBe(300_000 - TRANSCRIPT_URL_REUSE_MARGIN_MS);
    expect(
      transcriptAccessStaleTimeMs(
        data,
        MAIN_TRANSCRIPT_FILE_KEY,
        SIGNED_AT_MS + 300_000
      )
    ).toBe(0);
  });

  it("reads only the requested file, not another file's URL", () => {
    const data = access([
      file(MAIN_TRANSCRIPT_FILE_KEY),
      file(SUBAGENT_KEY, { url: SIGNED_URL }),
    ]);
    expect(
      transcriptAccessStaleTimeMs(data, MAIN_TRANSCRIPT_FILE_KEY, SIGNED_AT_MS)
    ).toBe(0);
    expect(
      transcriptAccessStaleTimeMs(data, SUBAGENT_KEY, SIGNED_AT_MS)
    ).toBeGreaterThan(0);
  });

  it("is stale at once without data", () => {
    expect(
      transcriptAccessStaleTimeMs(undefined, MAIN_TRANSCRIPT_FILE_KEY, 0)
    ).toBe(0);
  });
});

describe("transcriptPollState", () => {
  it("lets uploadPending win over missing", () => {
    expect(
      transcriptPollState(
        access([
          file(MAIN_TRANSCRIPT_FILE_KEY, {
            availability: TranscriptAvailability.Missing,
          }),
          file(SUBAGENT_KEY, {
            availability: TranscriptAvailability.UploadPending,
          }),
        ])
      )
    ).toBe(TranscriptPollState.Pending);
  });

  it("reports missing, and nothing for readable files", () => {
    expect(
      transcriptPollState(
        access([
          file(MAIN_TRANSCRIPT_FILE_KEY, {
            availability: TranscriptAvailability.Missing,
          }),
        ])
      )
    ).toBe(TranscriptPollState.Missing);
    expect(transcriptPollState(access([file(MAIN_TRANSCRIPT_FILE_KEY)]))).toBe(
      TranscriptPollState.None
    );
  });
});

describe("missingTranscriptRefetchIntervalMs", () => {
  it("starts at the pending cadence and grows with the wait", () => {
    expect(missingTranscriptRefetchIntervalMs(0)).toBe(
      TRANSCRIPT_PENDING_REFETCH_INTERVAL_MS
    );
    expect(missingTranscriptRefetchIntervalMs(16_000)).toBe(16_000);
    expect(missingTranscriptRefetchIntervalMs(200_000)).toBe(
      TRANSCRIPT_MISSING_REFETCH_MAX_INTERVAL_MS
    );
  });

  it("stops at the cap and on a non-finite wait", () => {
    expect(
      missingTranscriptRefetchIntervalMs(TRANSCRIPT_MISSING_REFETCH_CAP_MS)
    ).toBe(false);
    expect(missingTranscriptRefetchIntervalMs(Number.NaN)).toBe(false);
  });
});
