import {
  TranscriptAvailability,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { describe, expect, it } from "vitest";
import {
  deriveTranscriptAvailability,
  isTranscriptReadable,
  type TranscriptAvailabilityInput,
  toTranscriptAvailabilitySummary,
} from "./transcript-availability";

const UPLOADED_AT = new Date("2026-07-08T12:00:00.000Z");
const NEWER = new Date(UPLOADED_AT.getTime() + 60_000);

function row(
  overrides: Partial<TranscriptAvailabilityInput> = {}
): TranscriptAvailabilityInput {
  return {
    uploadStatus: TranscriptUploadStatus.Uploaded,
    uploadedAt: UPLOADED_AT,
    lastObservedAt: UPLOADED_AT,
    ...overrides,
  };
}

describe("deriveTranscriptAvailability", () => {
  it("uploaded and not superseded (lastObservedAt <= uploadedAt) is available", () => {
    expect(deriveTranscriptAvailability(row())).toBe(
      TranscriptAvailability.Available
    );
  });

  it("uploaded but superseded by a newer desktop fingerprint is stale", () => {
    expect(deriveTranscriptAvailability(row({ lastObservedAt: NEWER }))).toBe(
      TranscriptAvailability.Stale
    );
  });

  it("uploaded with a null uploadedAt is uploadPending (defensive: no upload timestamp, no readable bytes)", () => {
    // A row marked Uploaded but missing uploadedAt is a write-path
    // inconsistency; we must not claim Available (which would mint a GET URL)
    // when there is no confirmed upload timestamp. Guard to UploadPending.
    expect(
      deriveTranscriptAvailability(
        row({ uploadedAt: null, lastObservedAt: NEWER })
      )
    ).toBe(TranscriptAvailability.UploadPending);
  });

  it("pending and uploading are both uploadPending", () => {
    expect(
      deriveTranscriptAvailability(
        row({ uploadStatus: TranscriptUploadStatus.Pending })
      )
    ).toBe(TranscriptAvailability.UploadPending);
    expect(
      deriveTranscriptAvailability(
        row({ uploadStatus: TranscriptUploadStatus.Uploading })
      )
    ).toBe(TranscriptAvailability.UploadPending);
  });

  it("failed is uploadFailed", () => {
    expect(
      deriveTranscriptAvailability(
        row({ uploadStatus: TranscriptUploadStatus.Failed })
      )
    ).toBe(TranscriptAvailability.UploadFailed);
  });
});

describe("isTranscriptReadable", () => {
  it("available and stale are readable (a URL may be minted)", () => {
    expect(isTranscriptReadable(TranscriptAvailability.Available)).toBe(true);
    expect(isTranscriptReadable(TranscriptAvailability.Stale)).toBe(true);
  });

  it("pending, failed, and missing are not readable", () => {
    expect(isTranscriptReadable(TranscriptAvailability.UploadPending)).toBe(
      false
    );
    expect(isTranscriptReadable(TranscriptAvailability.UploadFailed)).toBe(
      false
    );
    expect(isTranscriptReadable(TranscriptAvailability.Missing)).toBe(false);
  });
});

describe("toTranscriptAvailabilitySummary", () => {
  it("maps fileKey, availability, and ISO uploadedAt", () => {
    expect(
      toTranscriptAvailabilitySummary({ ...row(), fileKey: "main" })
    ).toEqual({
      fileKey: "main",
      availability: TranscriptAvailability.Available,
      uploadedAt: UPLOADED_AT.toISOString(),
    });
  });

  it("maps a null uploadedAt to null", () => {
    expect(
      toTranscriptAvailabilitySummary({
        ...row({
          uploadStatus: TranscriptUploadStatus.Pending,
          uploadedAt: null,
        }),
        fileKey: "subagent:abc",
      })
    ).toEqual({
      fileKey: "subagent:abc",
      availability: TranscriptAvailability.UploadPending,
      uploadedAt: null,
    });
  });
});
