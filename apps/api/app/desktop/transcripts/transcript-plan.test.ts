import {
  S3_MIN_MULTIPART_PART_BYTES,
  TRANSCRIPT_UPLOAD_PART_BYTES,
} from "@repo/api/src/types/desktop-transcripts";
import { describe, expect, it } from "vitest";
import { decideSyncPlan, resolveTranscriptObjectKey } from "./transcript-plan";

const ORG = "org-1";
const CT = "ct-1";
const SID = "session-abc";

describe("resolveTranscriptObjectKey", () => {
  it("builds the main session object key", () => {
    expect(
      resolveTranscriptObjectKey({
        organizationId: ORG,
        computeTargetId: CT,
        externalSessionId: SID,
        fileKey: "main",
      })
    ).toBe("org-1/ct-1/session-abc.jsonl");
  });

  it("builds a subagent object key under the session prefix", () => {
    expect(
      resolveTranscriptObjectKey({
        organizationId: ORG,
        computeTargetId: CT,
        externalSessionId: SID,
        fileKey: "subagent:file-42",
      })
    ).toBe("org-1/ct-1/session-abc/subagent/file-42.jsonl");
  });
});

describe("decideSyncPlan", () => {
  const freshArgs = { syncedOffset: 0, prefixConsistent: false };

  it("uses fullPut when a from-scratch payload fits one part", () => {
    const decision = decideSyncPlan({
      ...freshArgs,
      planEndOffset: TRANSCRIPT_UPLOAD_PART_BYTES,
    });
    expect(decision.mode).toBe("fullPut");
  });

  it("uses multipartFresh once the payload exceeds one part", () => {
    const decision = decideSyncPlan({
      ...freshArgs,
      planEndOffset: TRANSCRIPT_UPLOAD_PART_BYTES + 1,
    });
    expect(decision).toEqual({
      mode: "multipartFresh",
      parts: [
        { partNumber: 1, offset: 0, byteLength: TRANSCRIPT_UPLOAD_PART_BYTES },
        { partNumber: 2, offset: TRANSCRIPT_UPLOAD_PART_BYTES, byteLength: 1 },
      ],
    });
  });

  it("copy-appends when the existing object is at least the S3 minimum and the prefix is consistent", () => {
    const syncedOffset = S3_MIN_MULTIPART_PART_BYTES + 1000;
    const decision = decideSyncPlan({
      syncedOffset,
      prefixConsistent: true,
      planEndOffset: syncedOffset + 100,
    });
    expect(decision).toEqual({
      mode: "multipartAppend",
      copyByteLength: syncedOffset,
      parts: [{ partNumber: 2, offset: syncedOffset, byteLength: 100 }],
    });
  });

  it("splits a large append delta into 5.1 MiB parts (last part smaller)", () => {
    const syncedOffset = S3_MIN_MULTIPART_PART_BYTES + 1000;
    const planEndOffset = syncedOffset + TRANSCRIPT_UPLOAD_PART_BYTES + 50;
    const decision = decideSyncPlan({
      syncedOffset,
      prefixConsistent: true,
      planEndOffset,
    });
    expect(decision).toEqual({
      mode: "multipartAppend",
      copyByteLength: syncedOffset,
      parts: [
        {
          partNumber: 2,
          offset: syncedOffset,
          byteLength: TRANSCRIPT_UPLOAD_PART_BYTES,
        },
        {
          partNumber: 3,
          offset: syncedOffset + TRANSCRIPT_UPLOAD_PART_BYTES,
          byteLength: 50,
        },
      ],
    });
  });

  it("does NOT append when the existing object is below the S3 5 MiB minimum", () => {
    // Copied part 1 would be an illegal sub-5 MiB non-final part, so we
    // re-upload the whole (small) object instead.
    const syncedOffset = 1_000_000;
    const decision = decideSyncPlan({
      syncedOffset,
      prefixConsistent: true,
      planEndOffset: 2_000_000,
    });
    expect(decision.mode).toBe("fullPut");
  });

  it("does NOT append when the prefix is inconsistent (compaction/rewrite)", () => {
    const syncedOffset = S3_MIN_MULTIPART_PART_BYTES + 1000;
    const decision = decideSyncPlan({
      syncedOffset,
      prefixConsistent: false,
      planEndOffset: syncedOffset + TRANSCRIPT_UPLOAD_PART_BYTES + 50,
    });
    expect(decision.mode).toBe("multipartFresh");
    if (decision.mode === "multipartFresh") {
      // Full re-upload from byte 0, not an append.
      expect(decision.parts[0]).toEqual({
        partNumber: 1,
        offset: 0,
        byteLength: TRANSCRIPT_UPLOAD_PART_BYTES,
      });
    }
  });

  it("keeps the part size above the S3 minimum so copied part 1 is always legal", () => {
    // Guards the documented gotcha: a decimal 5.1 MB would sit below the floor.
    expect(TRANSCRIPT_UPLOAD_PART_BYTES).toBeGreaterThan(
      S3_MIN_MULTIPART_PART_BYTES
    );
  });
});
