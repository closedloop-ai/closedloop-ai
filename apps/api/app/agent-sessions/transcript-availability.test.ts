import { reconcileCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-reconcile";
import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import {
  TranscriptAvailability,
  type TranscriptAvailabilitySummary,
  TranscriptSkipReason,
  TranscriptUploadStatus,
} from "@repo/api/src/types/desktop-transcripts";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { describe, expect, it } from "vitest";
import {
  deriveTranscriptAvailability,
  deriveTranscriptDisposition,
  deriveTranscriptDispositionsBySession,
  isTranscriptReadable,
  MAIN_FILE_KEY,
  sessionTranscriptGroupKey,
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

  it("skipped is permanentlyUnavailable (FEA-3476: terminal, non-retryable)", () => {
    expect(
      deriveTranscriptAvailability(
        row({ uploadStatus: TranscriptUploadStatus.Skipped, uploadedAt: null })
      )
    ).toBe(TranscriptAvailability.PermanentlyUnavailable);
  });
});

describe("isTranscriptReadable", () => {
  it("available and stale are readable (a URL may be minted)", () => {
    expect(isTranscriptReadable(TranscriptAvailability.Available)).toBe(true);
    expect(isTranscriptReadable(TranscriptAvailability.Stale)).toBe(true);
  });

  it("pending, failed, permanentlyUnavailable, and missing are not readable", () => {
    expect(isTranscriptReadable(TranscriptAvailability.UploadPending)).toBe(
      false
    );
    expect(isTranscriptReadable(TranscriptAvailability.UploadFailed)).toBe(
      false
    );
    expect(
      isTranscriptReadable(TranscriptAvailability.PermanentlyUnavailable)
    ).toBe(false);
    expect(isTranscriptReadable(TranscriptAvailability.Missing)).toBe(false);
  });
});

describe("toTranscriptAvailabilitySummary", () => {
  it("maps fileKey, availability, and ISO uploadedAt", () => {
    expect(
      toTranscriptAvailabilitySummary({
        ...row(),
        fileKey: "main",
        permanentFailureReason: null,
      })
    ).toEqual({
      fileKey: "main",
      availability: TranscriptAvailability.Available,
      uploadedAt: UPLOADED_AT.toISOString(),
      permanentFailureReason: null,
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
        permanentFailureReason: null,
      })
    ).toEqual({
      fileKey: "subagent:abc",
      availability: TranscriptAvailability.UploadPending,
      uploadedAt: null,
      permanentFailureReason: null,
    });
  });
});

function mainSummary(
  availability: TranscriptAvailability
): TranscriptAvailabilitySummary {
  return {
    fileKey: MAIN_FILE_KEY,
    availability,
    uploadedAt: null,
    permanentFailureReason: null,
  };
}

// FEA-3479 (PRD-536 G1) AC-7: a client can distinguish syncing / stale /
// synced / failed(-permanent) / never-expected from the derived disposition.
describe("deriveTranscriptDisposition", () => {
  it("available main is synced", () => {
    expect(
      deriveTranscriptDisposition([
        mainSummary(TranscriptAvailability.Available),
      ])
    ).toBe(TranscriptDisposition.Synced);
  });

  it("stale main is stale (uploaded but superseded)", () => {
    expect(
      deriveTranscriptDisposition([mainSummary(TranscriptAvailability.Stale)])
    ).toBe(TranscriptDisposition.Stale);
  });

  it("uploadPending main is syncing (normal transcript-uploading case)", () => {
    expect(
      deriveTranscriptDisposition([
        mainSummary(TranscriptAvailability.UploadPending),
      ])
    ).toBe(TranscriptDisposition.Syncing);
  });

  it("missing main is syncing (expected but not yet started)", () => {
    expect(
      deriveTranscriptDisposition([mainSummary(TranscriptAvailability.Missing)])
    ).toBe(TranscriptDisposition.Syncing);
  });

  it("uploadFailed main maps to failedTransient (retryable, not a dead end)", () => {
    // A retryable attempt failure stays transient — only a terminal SKIP
    // (permanentlyUnavailable) is a dead end (see the failedPermanent test).
    expect(
      deriveTranscriptDisposition([
        mainSummary(TranscriptAvailability.UploadFailed),
      ])
    ).toBe(TranscriptDisposition.FailedTransient);
    expect(
      deriveTranscriptDisposition([
        mainSummary(TranscriptAvailability.UploadFailed),
      ])
    ).not.toBe(TranscriptDisposition.FailedPermanent);
  });

  it("permanentlyUnavailable main is failedPermanent (FEA-3476: terminal skip, no retry)", () => {
    expect(
      deriveTranscriptDisposition([
        {
          ...mainSummary(TranscriptAvailability.PermanentlyUnavailable),
          permanentFailureReason: TranscriptSkipReason.TooLarge,
        },
      ])
    ).toBe(TranscriptDisposition.FailedPermanent);
  });

  it("permanentlyUnavailable main with source_gone is failedPermanent (hard terminal, unchanged)", () => {
    // ISS-4695 item 3: a genuinely-vanished raw rollout stays a HARD terminal.
    expect(
      deriveTranscriptDisposition([
        {
          ...mainSummary(TranscriptAvailability.PermanentlyUnavailable),
          permanentFailureReason: TranscriptSkipReason.SourceGone,
        },
      ])
    ).toBe(TranscriptDisposition.FailedPermanent);
  });

  it("permanentlyUnavailable main with retries_exhausted is failedPermanent (hard terminal, unchanged)", () => {
    expect(
      deriveTranscriptDisposition([
        {
          ...mainSummary(TranscriptAvailability.PermanentlyUnavailable),
          permanentFailureReason: TranscriptSkipReason.RetriesExhausted,
        },
      ])
    ).toBe(TranscriptDisposition.FailedPermanent);
  });

  it("permanentlyUnavailable main with materialized_source_unavailable is RECOVERABLE (syncing, NOT failedPermanent) — ISS-4695 item 3", () => {
    // Option A: a regenerable OpenCode materialized source that crossed the
    // missing-source cap must NOT read as a hard `failedPermanent`, which would
    // hide that redrive/recovery is still possible. It maps to `syncing` — the
    // transcript can still come back on a later sweep.
    const disposition = deriveTranscriptDisposition([
      {
        ...mainSummary(TranscriptAvailability.PermanentlyUnavailable),
        permanentFailureReason:
          TranscriptSkipReason.MaterializedSourceUnavailable,
      },
    ]);
    expect(disposition).toBe(TranscriptDisposition.Syncing);
    expect(disposition).not.toBe(TranscriptDisposition.FailedPermanent);
  });

  it("permanentlyUnavailable main with an unknown/null reason defaults to failedPermanent (conservative)", () => {
    // A legacy/older-API row whose reason `normalizeSkipReason` degraded to null
    // must default to the HARD terminal — never LIE as recoverable.
    expect(
      deriveTranscriptDisposition([
        {
          ...mainSummary(TranscriptAvailability.PermanentlyUnavailable),
          permanentFailureReason: null,
        },
      ])
    ).toBe(TranscriptDisposition.FailedPermanent);
  });

  it("no main summary is neverExpected (absence is normal)", () => {
    expect(
      deriveTranscriptDisposition([
        {
          fileKey: "subagent:a",
          availability: TranscriptAvailability.Available,
          uploadedAt: null,
          permanentFailureReason: null,
        },
      ])
    ).toBe(TranscriptDisposition.NeverExpected);
    expect(deriveTranscriptDisposition([])).toBe(
      TranscriptDisposition.NeverExpected
    );
  });

  it("verdict is driven by the main file, ignoring subagent availability", () => {
    // A failing subagent must not downgrade an otherwise-synced session.
    expect(
      deriveTranscriptDisposition([
        mainSummary(TranscriptAvailability.Available),
        {
          fileKey: "subagent:a",
          availability: TranscriptAvailability.UploadFailed,
          uploadedAt: null,
          permanentFailureReason: null,
        },
      ])
    ).toBe(TranscriptDisposition.Synced);
  });
});

type TranscriptRow = Parameters<
  typeof deriveTranscriptDispositionsBySession
>[0][number];

function transcriptRow(overrides: Partial<TranscriptRow> = {}): TranscriptRow {
  return {
    fileKey: MAIN_FILE_KEY,
    uploadStatus: TranscriptUploadStatus.Uploaded,
    uploadedAt: UPLOADED_AT,
    lastObservedAt: UPLOADED_AT,
    permanentFailureReason: null,
    computeTargetId: "ct-1",
    externalSessionId: "ext-1",
    ...overrides,
  };
}

describe("deriveTranscriptDispositionsBySession (PRD-536 G1 Phase 3)", () => {
  it("folds each session's rows into one verdict keyed by (computeTargetId, externalSessionId)", () => {
    const dispositions = deriveTranscriptDispositionsBySession([
      // Session A: synced main.
      transcriptRow({ externalSessionId: "ext-a" }),
      // Session B: stale main (uploaded, then a newer fingerprint observed).
      transcriptRow({
        externalSessionId: "ext-b",
        lastObservedAt: NEWER,
      }),
    ]);

    expect(
      dispositions.get(
        sessionTranscriptGroupKey({
          computeTargetId: "ct-1",
          externalSessionId: "ext-a",
        })
      )
    ).toBe(TranscriptDisposition.Synced);
    expect(
      dispositions.get(
        sessionTranscriptGroupKey({
          computeTargetId: "ct-1",
          externalSessionId: "ext-b",
        })
      )
    ).toBe(TranscriptDisposition.Stale);
  });

  it("synthesizes a missing main (→ syncing) when a session has only subagent rows", () => {
    // Mirrors the detail enrichment: a session always expects a main file, so a
    // subagent-only batch must fold to `syncing`, not `neverExpected`.
    const dispositions = deriveTranscriptDispositionsBySession([
      transcriptRow({
        fileKey: "subagent:a",
        uploadStatus: TranscriptUploadStatus.Uploaded,
      }),
    ]);

    expect(
      dispositions.get(
        sessionTranscriptGroupKey({
          computeTargetId: "ct-1",
          externalSessionId: "ext-1",
        })
      )
    ).toBe(TranscriptDisposition.Syncing);
  });

  it("does not let a failing subagent downgrade a synced main within the same session", () => {
    const dispositions = deriveTranscriptDispositionsBySession([
      transcriptRow({ fileKey: MAIN_FILE_KEY }),
      transcriptRow({
        fileKey: "subagent:a",
        uploadStatus: TranscriptUploadStatus.Failed,
        uploadedAt: null,
      }),
    ]);

    expect(dispositions.size).toBe(1);
    expect(
      dispositions.get(
        sessionTranscriptGroupKey({
          computeTargetId: "ct-1",
          externalSessionId: "ext-1",
        })
      )
    ).toBe(TranscriptDisposition.Synced);
  });

  it("keeps same external id on different compute targets as distinct sessions", () => {
    const dispositions = deriveTranscriptDispositionsBySession([
      transcriptRow({ computeTargetId: "ct-1", externalSessionId: "ext-x" }),
      transcriptRow({
        computeTargetId: "ct-2",
        externalSessionId: "ext-x",
        lastObservedAt: NEWER,
      }),
    ]);

    expect(dispositions.size).toBe(2);
    expect(
      dispositions.get(
        sessionTranscriptGroupKey({
          computeTargetId: "ct-1",
          externalSessionId: "ext-x",
        })
      )
    ).toBe(TranscriptDisposition.Synced);
    expect(
      dispositions.get(
        sessionTranscriptGroupKey({
          computeTargetId: "ct-2",
          externalSessionId: "ext-x",
        })
      )
    ).toBe(TranscriptDisposition.Stale);
  });

  it("returns an empty map for no rows", () => {
    expect(deriveTranscriptDispositionsBySession([]).size).toBe(0);
  });
});

describe("reconcileCloudSyncState (ISS-4621)", () => {
  it("maps a still-syncing transcript blob to `pending` (cloud copy behind)", () => {
    // SES-78221: the required transcript blob is missing/in-flight, so the
    // aggregate must NOT claim synced even though the derived-data lane is.
    expect(reconcileCloudSyncState(TranscriptDisposition.Syncing)).toBe(
      AgentSessionCloudSyncState.Pending
    );
  });

  it("maps a retryable transient transcript failure to `pending` (blob still coming)", () => {
    // ISS-4621: `failedTransient` is a retryable upload failure the desktop
    // re-queues with backoff — the blob is still absent from the cloud, the same
    // "cloud copy is behind" condition as `syncing`. Treating it as settled would
    // reintroduce the false `synced` on the retry path.
    expect(reconcileCloudSyncState(TranscriptDisposition.FailedTransient)).toBe(
      AgentSessionCloudSyncState.Pending
    );
  });

  it("maps a caught-up / permanently-terminal / never-expected transcript to `synced`", () => {
    // Synced/stale are caught-up-or-readable; failedPermanent is terminal (the
    // blob is never coming, the row is as complete as it will be); neverExpected
    // has no blob to wait on. None is an in-flight "cloud copy behind" state.
    expect(reconcileCloudSyncState(TranscriptDisposition.Synced)).toBe(
      AgentSessionCloudSyncState.Synced
    );
    expect(reconcileCloudSyncState(TranscriptDisposition.Stale)).toBe(
      AgentSessionCloudSyncState.Synced
    );
    expect(reconcileCloudSyncState(TranscriptDisposition.FailedPermanent)).toBe(
      AgentSessionCloudSyncState.Synced
    );
    expect(reconcileCloudSyncState(TranscriptDisposition.NeverExpected)).toBe(
      AgentSessionCloudSyncState.Synced
    );
  });

  it("keeps the prior `synced` default when no disposition is available", () => {
    // A producer that didn't compute a verdict ⇒ nothing to contradict the
    // derived-data lane; never fabricate `pending`.
    expect(reconcileCloudSyncState(undefined)).toBe(
      AgentSessionCloudSyncState.Synced
    );
  });

  it("degrades an unknown/legacy disposition to `synced` (version-skew safe, no crash, no false pending)", () => {
    // A newer desktop/producer could emit a disposition string this build does
    // not know. It must degrade to `synced` — never crash, and never LIE as
    // still-uploading `pending` for an unrecognized value.
    const unknownDisposition = "someFutureDisposition" as TranscriptDisposition;
    expect(reconcileCloudSyncState(unknownDisposition)).toBe(
      AgentSessionCloudSyncState.Synced
    );
  });
});
