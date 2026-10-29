import { describe, expect, it } from "vitest";
import {
  asTranscriptForbiddenCode,
  isMaterializedTranscriptHarness,
  TranscriptAvailability,
  TranscriptForbiddenCode,
  transcriptAccessResponseSchema,
  transcriptAvailabilitySummarySchema,
  transcriptCompleteRequestSchema,
  transcriptSkipRequestSchema,
} from "./desktop-transcripts";
import {
  isRecoverableTranscriptSkipReason,
  TranscriptSkipReason,
  toKnownTranscriptSkipReason,
} from "./transcript-skip-reason-constants.ts";

/**
 * ISS-4621 review: version-skew tolerance on the transcript READ contracts.
 * Skip reasons are grow-only (`retries_exhausted` shipped after
 * `too_large`/`source_gone`), so a client with an older bundled schema can meet
 * a reason its enum does not know. The read schemas must degrade that value to
 * `null` — never reject the descriptor, which would fail the whole `files`
 * array and break the transcript panel for the session. The WRITE schema stays
 * a closed enum on purpose (the server must not persist labels it cannot serve
 * back), which the skip route's 400 test already pins.
 */

const KNOWN_FILE = {
  fileKey: "main",
  availability: TranscriptAvailability.PermanentlyUnavailable,
  url: null,
  byteSize: null,
  rawSha256: null,
  uploadedAt: null,
  lastObservedAt: null,
  permanentFailureReason: TranscriptSkipReason.RetriesExhausted,
};

describe("transcript read schemas vs unknown skip reasons (ISS-4621)", () => {
  it("parses a descriptor with an UNKNOWN reason, degrading the reason to null (prior-client shape)", () => {
    const parsed = transcriptAccessResponseSchema.safeParse({
      sessionId: "session-1",
      files: [
        { ...KNOWN_FILE, permanentFailureReason: "some_future_reason" },
        KNOWN_FILE,
      ],
    });
    // The whole files array survives: one unknown label must not blank the
    // panel for every file of the session.
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.files[0]?.permanentFailureReason).toBeNull();
      expect(parsed.data.files[1]?.permanentFailureReason).toBe(
        TranscriptSkipReason.RetriesExhausted
      );
    }
  });

  it("keeps every known reason intact on the availability summary schema", () => {
    for (const reason of Object.values(TranscriptSkipReason)) {
      const parsed = transcriptAvailabilitySummarySchema.safeParse({
        fileKey: "main",
        availability: TranscriptAvailability.PermanentlyUnavailable,
        uploadedAt: null,
        permanentFailureReason: reason,
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.permanentFailureReason).toBe(reason);
      }
    }
  });

  it("degrades an unknown reason to null on the availability summary schema", () => {
    const parsed = transcriptAvailabilitySummarySchema.safeParse({
      fileKey: "main",
      availability: TranscriptAvailability.PermanentlyUnavailable,
      uploadedAt: null,
      permanentFailureReason: "some_future_reason",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.permanentFailureReason).toBeNull();
    }
  });

  it("toKnownTranscriptSkipReason narrows known values and nulls everything else", () => {
    expect(toKnownTranscriptSkipReason(TranscriptSkipReason.TooLarge)).toBe(
      TranscriptSkipReason.TooLarge
    );
    expect(toKnownTranscriptSkipReason("some_future_reason")).toBeNull();
    expect(toKnownTranscriptSkipReason(null)).toBeNull();
    expect(toKnownTranscriptSkipReason(undefined)).toBeNull();
  });

  it("the WRITE schema still rejects unknown reasons (server never persists labels it cannot serve)", () => {
    const parsed = transcriptSkipRequestSchema.safeParse({
      computeTargetId: "11111111-1111-7111-8111-111111111111",
      externalSessionId: "session-1",
      fileKey: "main",
      sourceHarness: "claude",
      reason: "some_future_reason",
    });
    expect(parsed.success).toBe(false);
  });

  // ISS-4695 item 3 (Option A): the new `materialized_source_unavailable` reason
  // is grow-only and server-leads the deploy — the closed WRITE enum must ACCEPT
  // it BEFORE the desktop starts emitting it, and an OLDER client reading it back
  // must still degrade an unknown reason to null (server-ready, skew-safe).
  it("the WRITE schema ACCEPTS materialized_source_unavailable (server-ready before desktop emits it)", () => {
    const parsed = transcriptSkipRequestSchema.safeParse({
      computeTargetId: "11111111-1111-7111-8111-111111111111",
      externalSessionId: "session-1",
      fileKey: "main",
      sourceHarness: "opencode",
      reason: TranscriptSkipReason.MaterializedSourceUnavailable,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.reason).toBe(
        TranscriptSkipReason.MaterializedSourceUnavailable
      );
    }
  });

  it("this build's reader narrows materialized_source_unavailable to itself, and an OLD client degrades the same wire value to null", () => {
    // On the current build the reason is KNOWN — narrowed to itself.
    expect(
      toKnownTranscriptSkipReason(
        TranscriptSkipReason.MaterializedSourceUnavailable
      )
    ).toBe(TranscriptSkipReason.MaterializedSourceUnavailable);
    // An OLD client (whose bundled enum predates this reason) meets the SAME wire
    // string as unknown and degrades it to null instead of rejecting the whole
    // descriptor. Modeled here by the raw literal an older enum would not contain.
    const olderClientView = transcriptAccessResponseSchema.safeParse({
      sessionId: "session-1",
      files: [
        {
          ...KNOWN_FILE,
          // Simulate a value an OLD client's grow-only Set does not include.
          permanentFailureReason: "materialized_source_unavailable_future_only",
        },
      ],
    });
    expect(olderClientView.success).toBe(true);
    if (olderClientView.success) {
      expect(olderClientView.data.files[0]?.permanentFailureReason).toBeNull();
    }
  });
});

/**
 * ISS-4820 — the reason/harness pairing and the recoverable-vs-hard split are
 * now WIRE-contract concerns, not two private opinions on either side.
 */
describe("ISS-4820: skip reason classification + reason/harness pairing", () => {
  const IDENTITY = {
    computeTargetId: "11111111-1111-7111-8111-111111111111",
    externalSessionId: "session-1",
    fileKey: "main",
  };

  it("classifies the two regenerable/resumable reasons as recoverable; every other is hard", () => {
    // ISS-9884 added the second recoverable member. The two are recoverable for
    // different reasons — one's SOURCE can come back, the other's TRANSPORT can
    // — and this predicate deliberately does not distinguish them; the verdict
    // they map to does (`TERMINAL_SKIP_DISPOSITIONS`).
    for (const reason of [
      TranscriptSkipReason.MaterializedSourceUnavailable,
      TranscriptSkipReason.EnvironmentUnavailable,
    ]) {
      expect(isRecoverableTranscriptSkipReason(reason)).toBe(true);
    }
    for (const reason of [
      TranscriptSkipReason.TooLarge,
      TranscriptSkipReason.SourceGone,
      TranscriptSkipReason.RetriesExhausted,
    ]) {
      expect(isRecoverableTranscriptSkipReason(reason)).toBe(false);
    }
  });

  it("treats only a materialized harness as regenerable (unknown harness is NOT)", () => {
    expect(isMaterializedTranscriptHarness("opencode")).toBe(true);
    expect(isMaterializedTranscriptHarness("claude")).toBe(false);
    expect(isMaterializedTranscriptHarness("codex")).toBe(false);
    // Conservative: a harness this build has never heard of cannot claim a
    // recoverable disposition.
    expect(isMaterializedTranscriptHarness("some_future_harness")).toBe(false);
  });

  it("REJECTS materialized_source_unavailable paired with a raw (non-materialized) harness", () => {
    // Without this the reason-only cloud branch reports `Syncing` forever for a
    // source that can never regenerate.
    for (const sourceHarness of ["claude", "codex", "some_future_harness"]) {
      const parsed = transcriptSkipRequestSchema.safeParse({
        ...IDENTITY,
        sourceHarness,
        reason: TranscriptSkipReason.MaterializedSourceUnavailable,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("ACCEPTS environment_unavailable on a RAW harness — the pairing rule is one reason wide, not all recoverable ones", () => {
    // ISS-9884. An environmental give-up says nothing about the shape of the
    // source, so raw Claude/Codex rows are the whole population it exists for.
    // This is the case that goes red if anyone generalizes the `.refine` from
    // the `materialized_source_unavailable` literal to
    // `isRecoverableTranscriptSkipReason` — a tidy-up that reads correct and
    // would silently reject the new reason for every non-materialized harness.
    for (const sourceHarness of [
      "claude",
      "codex",
      "opencode",
      "some_future_harness",
    ]) {
      const parsed = transcriptSkipRequestSchema.safeParse({
        ...IDENTITY,
        sourceHarness,
        reason: TranscriptSkipReason.EnvironmentUnavailable,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("still ACCEPTS every OLD payload shape (hard reason + raw harness)", () => {
    // Version skew both ways: the added pairing rule must not reject anything a
    // previously-shipping desktop legitimately sends.
    for (const reason of [
      TranscriptSkipReason.TooLarge,
      TranscriptSkipReason.SourceGone,
      TranscriptSkipReason.RetriesExhausted,
    ]) {
      for (const sourceHarness of ["claude", "codex", "opencode"]) {
        const parsed = transcriptSkipRequestSchema.safeParse({
          ...IDENTITY,
          sourceHarness,
          reason,
        });
        expect(parsed.success).toBe(true);
      }
    }
  });

  it("reports the rejected pairing against the `reason` field", () => {
    const parsed = transcriptSkipRequestSchema.safeParse({
      ...IDENTITY,
      sourceHarness: "claude",
      reason: TranscriptSkipReason.MaterializedSourceUnavailable,
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["reason"]);
    }
  });
});

describe("transcriptCompleteRequestSchema", () => {
  const base = {
    computeTargetId: "11111111-1111-7111-8111-111111111111",
    externalSessionId: "session-1",
    fileKey: "main",
    planEndOffset: 0,
    sha256: "a".repeat(64),
    crc64nvme: "checksum",
  };

  it("accepts a fullPut completion with no uploadId", () => {
    expect(
      transcriptCompleteRequestSchema.safeParse({
        ...base,
        mode: "fullPut",
      }).success
    ).toBe(true);
  });

  it("accepts a multipart completion that carries an uploadId", () => {
    expect(
      transcriptCompleteRequestSchema.safeParse({
        ...base,
        mode: "multipart",
        uploadId: "upload-1",
      }).success
    ).toBe(true);
  });

  it("rejects a multipart completion missing its uploadId, against the `uploadId` field", () => {
    const parsed = transcriptCompleteRequestSchema.safeParse({
      ...base,
      mode: "multipart",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["uploadId"]);
    }
  });
});

describe("asTranscriptForbiddenCode", () => {
  it("resolves a known forbidden code to its typed member", () => {
    expect(asTranscriptForbiddenCode(TranscriptForbiddenCode.NotOwned)).toBe(
      TranscriptForbiddenCode.NotOwned
    );
  });

  it.each([null, undefined, "", "future_forbidden_code"])(
    "folds %j to undefined, the same bare-403 path as absence",
    (value) => {
      expect(asTranscriptForbiddenCode(value)).toBeUndefined();
    }
  );
});
