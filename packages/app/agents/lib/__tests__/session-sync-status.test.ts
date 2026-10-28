import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { describe, expect, it } from "vitest";
import {
  getSessionSyncStatus,
  getTranscriptDispositionLabel,
  getTranscriptDispositionTone,
} from "../session-sync-status";

const NOW = new Date("2026-06-10T12:30:00.000Z");

describe("getTranscriptDispositionLabel", () => {
  it("maps every disposition to a human label", () => {
    expect(getTranscriptDispositionLabel(TranscriptDisposition.Synced)).toBe(
      "Synced"
    );
    expect(getTranscriptDispositionLabel(TranscriptDisposition.Stale)).toBe(
      "Stale"
    );
    expect(getTranscriptDispositionLabel(TranscriptDisposition.Syncing)).toBe(
      "Syncing"
    );
    expect(
      getTranscriptDispositionLabel(TranscriptDisposition.FailedTransient)
    ).toBe("Sync failed, retrying");
    expect(
      getTranscriptDispositionLabel(TranscriptDisposition.FailedPermanent)
    ).toBe("Sync failed");
    expect(
      getTranscriptDispositionLabel(TranscriptDisposition.NeverExpected)
    ).toBe("No transcript");
  });

  it("returns null for an unrecognized (version-skewed) disposition", () => {
    // A newer producer can send a disposition this client does not know yet;
    // the label must degrade to null rather than a runtime `undefined`.
    expect(
      getTranscriptDispositionLabel(
        "someFutureDisposition" as TranscriptDisposition
      )
    ).toBeNull();
  });
});

describe("getTranscriptDispositionTone", () => {
  it("maps every disposition to a design-system tone", () => {
    expect(getTranscriptDispositionTone(TranscriptDisposition.Synced)).toBe(
      "success"
    );
    expect(getTranscriptDispositionTone(TranscriptDisposition.Stale)).toBe(
      "warning"
    );
    expect(getTranscriptDispositionTone(TranscriptDisposition.Syncing)).toBe(
      "info"
    );
    expect(
      getTranscriptDispositionTone(TranscriptDisposition.FailedTransient)
    ).toBe("danger");
    expect(
      getTranscriptDispositionTone(TranscriptDisposition.FailedPermanent)
    ).toBe("danger");
    expect(
      getTranscriptDispositionTone(TranscriptDisposition.NeverExpected)
    ).toBe("muted");
  });

  it("returns null for an unrecognized (version-skewed) disposition", () => {
    expect(
      getTranscriptDispositionTone(
        "someFutureDisposition" as TranscriptDisposition
      )
    ).toBeNull();
  });
});

describe("getSessionSyncStatus", () => {
  it("combines disposition and freshness when both are present", () => {
    const status = getSessionSyncStatus(
      {
        transcriptDisposition: TranscriptDisposition.Synced,
        lastSyncedAt: new Date("2026-06-10T12:19:00.000Z"),
      },
      { now: NOW }
    );

    expect(status.dispositionLabel).toBe("Synced");
    expect(status.freshnessLabel).toBe("Last synced 11 min ago");
    expect(status.valueLabel).toBe("Synced · Last synced 11 min ago");
    expect(status.tone).toBe("success");
    // Synced is a nominal steady state — no attention treatment.
    expect(status.attention).toBe(false);
  });

  it("flags non-nominal dispositions (stale/syncing/failed*) for attention", () => {
    const attentionOf = (disposition: TranscriptDisposition) =>
      getSessionSyncStatus({ transcriptDisposition: disposition }, { now: NOW })
        .attention;

    expect(attentionOf(TranscriptDisposition.Stale)).toBe(true);
    expect(attentionOf(TranscriptDisposition.Syncing)).toBe(true);
    expect(attentionOf(TranscriptDisposition.FailedTransient)).toBe(true);
    expect(attentionOf(TranscriptDisposition.FailedPermanent)).toBe(true);
    expect(attentionOf(TranscriptDisposition.Synced)).toBe(false);
    expect(attentionOf(TranscriptDisposition.NeverExpected)).toBe(false);
  });

  it("carries a null tone and no attention when only freshness is present (no verdict to color)", () => {
    const status = getSessionSyncStatus(
      { lastSyncedAt: new Date("2026-06-10T12:19:00.000Z") },
      { now: NOW }
    );

    expect(status.valueLabel).toBe("Last synced 11 min ago");
    expect(status.tone).toBeNull();
    expect(status.attention).toBe(false);
  });

  it("renders freshness alone when the disposition is absent", () => {
    const status = getSessionSyncStatus(
      { lastSyncedAt: new Date("2026-06-10T12:19:00.000Z") },
      { now: NOW }
    );

    expect(status.dispositionLabel).toBeNull();
    expect(status.freshnessLabel).toBe("Last synced 11 min ago");
    expect(status.valueLabel).toBe("Last synced 11 min ago");
  });

  it("renders the disposition alone when there is no timestamp", () => {
    const status = getSessionSyncStatus(
      { transcriptDisposition: TranscriptDisposition.NeverExpected },
      { now: NOW }
    );

    expect(status.dispositionLabel).toBe("No transcript");
    expect(status.freshnessLabel).toBeNull();
    expect(status.valueLabel).toBe("No transcript");
  });

  it("yields all-null labels when neither field is present (degrades safely)", () => {
    const status = getSessionSyncStatus({}, { now: NOW });

    expect(status.dispositionLabel).toBeNull();
    expect(status.freshnessLabel).toBeNull();
    expect(status.valueLabel).toBeNull();
  });

  it("treats an invalid timestamp as no freshness rather than an Invalid Date render", () => {
    const status = getSessionSyncStatus(
      {
        transcriptDisposition: TranscriptDisposition.Stale,
        lastSyncedAt: new Date("not-a-date"),
      },
      { now: NOW }
    );

    expect(status.freshnessLabel).toBeNull();
    expect(status.valueLabel).toBe("Stale");
  });

  it("drops an unrecognized disposition but keeps freshness (degrades cleanly)", () => {
    const status = getSessionSyncStatus(
      {
        transcriptDisposition: "someFutureDisposition" as TranscriptDisposition,
        lastSyncedAt: new Date("2026-06-10T12:19:00.000Z"),
      },
      { now: NOW }
    );

    expect(status.dispositionLabel).toBeNull();
    expect(status.freshnessLabel).toBe("Last synced 11 min ago");
    // No leading `undefined · ` — only the freshness half renders.
    expect(status.valueLabel).toBe("Last synced 11 min ago");
  });
});

describe("ISS-9884: the failedTransient pair that means paused, not retrying", () => {
  it("renders Upload paused in warning tone for environment_unavailable", () => {
    // The whole point of the reason reaching the list. Before it did, this row
    // read "Sync failed, retrying" in danger red while the detail panel said
    // "Transcript upload paused" about the same transcript.
    const status = getSessionSyncStatus(
      {
        transcriptDisposition: TranscriptDisposition.FailedTransient,
        transcriptDispositionReason:
          TranscriptSkipReason.EnvironmentUnavailable,
      },
      { now: NOW }
    );

    expect(status.dispositionLabel).toBe("Upload paused");
    expect(status.tone).toBe("warning");
    expect(status.attention).toBe(true);
  });

  it("leaves the re-queued producer of the SAME disposition unchanged", () => {
    // The control. `failedTransient` with no reason is the ordinary
    // retryable upload failure the desktop re-queues with backoff, and
    // "It retries automatically" is true of it.
    const status = getSessionSyncStatus(
      { transcriptDisposition: TranscriptDisposition.FailedTransient },
      { now: NOW }
    );

    expect(status.dispositionLabel).toBe("Sync failed, retrying");
    expect(status.tone).toBe("danger");
  });

  it("needs BOTH halves: the reason alone does not pause another disposition", () => {
    // A version-skewed producer can carry a reason on a row whose verdict it
    // did not produce. Only the pair names the paused state.
    const status = getSessionSyncStatus(
      {
        transcriptDisposition: TranscriptDisposition.FailedPermanent,
        transcriptDispositionReason:
          TranscriptSkipReason.EnvironmentUnavailable,
      },
      { now: NOW }
    );

    expect(status.dispositionLabel).toBe("Sync failed");
    expect(status.tone).toBe("danger");
  });

  it("keeps failedTransient with any OTHER reason on the retrying copy", () => {
    const status = getSessionSyncStatus(
      {
        transcriptDisposition: TranscriptDisposition.FailedTransient,
        transcriptDispositionReason: TranscriptSkipReason.RetriesExhausted,
      },
      { now: NOW }
    );

    expect(status.dispositionLabel).toBe("Sync failed, retrying");
  });

  it("joins the paused label with freshness like any other verdict", () => {
    const status = getSessionSyncStatus(
      {
        transcriptDisposition: TranscriptDisposition.FailedTransient,
        transcriptDispositionReason:
          TranscriptSkipReason.EnvironmentUnavailable,
        lastSyncedAt: new Date("2026-06-10T12:19:00.000Z"),
      },
      { now: NOW }
    );

    expect(status.valueLabel).toBe("Upload paused · Last synced 11 min ago");
  });
});

describe("getSessionSyncStatus — ISS-11427 dead-lettered rows", () => {
  const lastSyncedAt = new Date("2026-06-10T12:00:00.000Z");

  it("names a dead letter and an abandoned row apart, each drawing attention", () => {
    const deadLetter = getSessionSyncStatus(
      { lastSyncedAt, cloudSyncState: AgentSessionCloudSyncState.DeadLetter },
      { now: NOW }
    );
    const abandoned = getSessionSyncStatus(
      { lastSyncedAt, cloudSyncState: AgentSessionCloudSyncState.Abandoned },
      { now: NOW }
    );

    expect(deadLetter.dispositionLabel).toBe("Dead letter");
    expect(deadLetter.tone).toBe("warning");
    expect(abandoned.dispositionLabel).toBe("Abandoned");
    expect(abandoned.tone).toBe("danger");
    expect([deadLetter.attention, abandoned.attention]).toEqual([true, true]);
    expect(deadLetter.valueLabel).toBe(
      `Dead letter · ${deadLetter.freshnessLabel}`
    );
  });

  it("leaves a pending or synced row to its transcript verdict", () => {
    for (const cloudSyncState of [
      AgentSessionCloudSyncState.Pending,
      AgentSessionCloudSyncState.Synced,
    ]) {
      const status = getSessionSyncStatus(
        {
          lastSyncedAt,
          cloudSyncState,
          transcriptDisposition: TranscriptDisposition.Synced,
        },
        { now: NOW }
      );
      expect(status.dispositionLabel).toBe(
        getTranscriptDispositionLabel(TranscriptDisposition.Synced)
      );
    }
  });
});
