import { describe, expect, it } from "vitest";
import {
  isMaterializedTranscriptHarness,
  isRecoverableTranscriptSkipReason,
  TranscriptAvailability,
  TranscriptSkipReason,
  toKnownTranscriptSkipReason,
  transcriptAccessResponseSchema,
  transcriptAvailabilitySummarySchema,
  transcriptSkipRequestSchema,
} from "./desktop-transcripts";

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

  it("classifies exactly one reason as recoverable; every other is hard", () => {
    expect(
      isRecoverableTranscriptSkipReason(
        TranscriptSkipReason.MaterializedSourceUnavailable
      )
    ).toBe(true);
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

  it("REJECTS a recoverable reason paired with a raw (non-materialized) harness", () => {
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
