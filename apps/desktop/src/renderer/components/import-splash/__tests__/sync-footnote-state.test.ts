import { describe, expect, it } from "vitest";
import {
  emptyTranscriptStatusCounts,
  TranscriptEgressGate,
  TranscriptSyncStatus,
  type TranscriptSyncStatusCounts,
  type TranscriptSyncStatusSnapshot,
} from "../../../../shared/transcript-sync-status-contract";
import {
  deriveSyncFootnoteState,
  SYNC_FOOTNOTE_LABELS,
  SYNC_FOOTNOTE_TONES,
  SyncFootnoteState,
} from "../sync-footnote-state";

// Module-scoped so the matchers aren't recompiled per assertion (useTopLevelRegex).
const INSTANTANEOUS_UPLOAD_CLAIM = /uploading transcripts to/i;
const COMPLETION_CLAIM = /uploaded to|all uploaded|nothing uploaded/i;
const NEGATIVE_HISTORY_CLAIM = /nothing|never|0 bytes/i;
const PERMISSION_VERDICT =
  /permitted|denied|blocked|not allowed|your org|policy/i;

/** A census with one row in each named status, and zero everywhere else. */
function counts(
  ...statuses: TranscriptSyncStatus[]
): TranscriptSyncStatusCounts {
  const census = emptyTranscriptStatusCounts();
  for (const status of statuses) {
    census[status] += 1;
  }
  return census;
}

/** A fully-permitted, operative lane. Individual cases override one dimension. */
function snapshot(
  overrides: Partial<TranscriptSyncStatusSnapshot> = {}
): TranscriptSyncStatusSnapshot {
  return {
    enabled: true,
    online: true,
    tierGate: TranscriptEgressGate.Allowed,
    storeReady: true,
    statusCounts: emptyTranscriptStatusCounts(),
    ...overrides,
  };
}

function stateFor(
  overrides: Partial<TranscriptSyncStatusSnapshot> = {}
): SyncFootnoteState {
  return deriveSyncFootnoteState({
    state: "ready",
    snapshot: snapshot(overrides),
  });
}

describe("deriveSyncFootnoteState (ISS-4716)", () => {
  it("keeps the read's own states distinct from anything the snapshot could say", () => {
    // A not-yet-resolved read and a failed read must never collapse into each
    // other or into a settled snapshot — that conflation IS the ticket.
    expect(deriveSyncFootnoteState({ state: "loading" })).toBe(
      SyncFootnoteState.Loading
    );
    expect(deriveSyncFootnoteState({ state: "unavailable" })).toBe(
      SyncFootnoteState.Unavailable
    );
  });

  it.each([
    [
      "the user's own toggle is off",
      { enabled: false },
      SyncFootnoteState.Disabled,
    ],
    [
      "consent tier / org policy settles on a denial",
      { tierGate: TranscriptEgressGate.Denied },
      SyncFootnoteState.Inactive,
    ],
    [
      "the store is not up",
      { storeReady: false },
      SyncFootnoteState.Unavailable,
    ],
    [
      "there is no compute target / sign-in",
      { online: false },
      SyncFootnoteState.NotConnected,
    ],
  ] as const)("reports the blocking precondition when %s", (_why, overrides, expected) => {
    expect(stateFor(overrides)).toBe(expected);
  });

  it("ranks a blocked precondition above any work it observes", () => {
    // Every `shouldRun()` precondition gates the drain, so a row below one of
    // them must never claim work is happening.
    const working = { statusCounts: counts(TranscriptSyncStatus.Uploading) };
    expect(stateFor({ ...working, enabled: false })).toBe(
      SyncFootnoteState.Disabled
    );
    expect(
      stateFor({ ...working, tierGate: TranscriptEgressGate.Denied })
    ).toBe(SyncFootnoteState.Inactive);
    // ISS-5348: an UNRESOLVED gate also outranks the work, but reports the
    // pending read rather than a denial nobody made.
    expect(
      stateFor({ ...working, tierGate: TranscriptEgressGate.Unresolved })
    ).toBe(SyncFootnoteState.Loading);
    expect(stateFor({ ...working, storeReady: false })).toBe(
      SyncFootnoteState.Unavailable
    );
  });

  it.each([
    [TranscriptSyncStatus.Uploading, SyncFootnoteState.Uploading],
    [TranscriptSyncStatus.Queued, SyncFootnoteState.Queued],
    [TranscriptSyncStatus.Failed, SyncFootnoteState.Retrying],
    [TranscriptSyncStatus.Dead, SyncFootnoteState.Failed],
  ] as const)("maps an observed %s row to %s", (status, expected) => {
    expect(stateFor({ statusCounts: counts(status) })).toBe(expected);
  });

  it("separates a terminal dead-letter from a retryable failure", () => {
    // `listReady` re-lists `failed` rows on backoff but never `dead` ones, so
    // collapsing the two would report a permanent failure for work that is
    // simply being retried.
    expect(
      stateFor({ statusCounts: counts(TranscriptSyncStatus.Failed) })
    ).toBe(SyncFootnoteState.Retrying);
    expect(stateFor({ statusCounts: counts(TranscriptSyncStatus.Dead) })).toBe(
      SyncFootnoteState.Failed
    );
    expect(
      stateFor({
        statusCounts: counts(
          TranscriptSyncStatus.Failed,
          TranscriptSyncStatus.Dead
        ),
      })
    ).toBe(SyncFootnoteState.Failed);
  });

  it("does not let in-flight work hide a terminal failure", () => {
    expect(
      stateFor({
        statusCounts: counts(
          TranscriptSyncStatus.Uploading,
          TranscriptSyncStatus.Dead
        ),
      })
    ).toBe(SyncFootnoteState.Failed);
  });

  it("keys uploading vs queued off the row's own status, not connectivity", () => {
    // A queued row is not an upload in flight, and an uploading row does not
    // become queued because `online` flipped.
    expect(
      stateFor({ statusCounts: counts(TranscriptSyncStatus.Queued) })
    ).toBe(SyncFootnoteState.Queued);
    expect(
      stateFor({ statusCounts: counts(TranscriptSyncStatus.Uploading) })
    ).toBe(SyncFootnoteState.Uploading);
  });

  it("claims no activity while offline — but still surfaces a terminal failure", () => {
    // The drain cannot tick without a compute target, so "retrying" and
    // "syncing" would both be false. `dead` is different: it can only have been
    // written while the lane WAS running, so it stays true offline.
    expect(
      stateFor({
        online: false,
        statusCounts: counts(TranscriptSyncStatus.Failed),
      })
    ).toBe(SyncFootnoteState.NotConnected);
    expect(stateFor({ online: false, statusCounts: counts() })).toBe(
      SyncFootnoteState.NotConnected
    );
    expect(
      stateFor({
        online: false,
        statusCounts: counts(TranscriptSyncStatus.Dead),
      })
    ).toBe(SyncFootnoteState.Failed);
  });

  it("treats a crash-stranded uploading row as pending rather than in flight", () => {
    // A crash mid-upload leaves the row at `uploading` until the boot-time
    // re-arm. The state is deliberately the same; the LABEL is what carries the
    // pending framing (asserted below).
    expect(
      stateFor({ statusCounts: counts(TranscriptSyncStatus.Uploading) })
    ).toBe(SyncFootnoteState.Uploading);
    expect(SYNC_FOOTNOTE_LABELS[SyncFootnoteState.Uploading]).not.toMatch(
      INSTANTANEOUS_UPLOAD_CLAIM
    );
  });

  it("settles an operative lane with nothing observed on the claim-free state", () => {
    expect(stateFor({ statusCounts: counts() })).toBe(
      SyncFootnoteState.Enabled
    );
  });

  it("ISS-5348: reports the unresolved org-policy window as pending, never as a denial", () => {
    // The defect: the gate fails closed on an unresolved policy, so the boot
    // splash printed "Transcript upload isn't active" as settled fact and then
    // flipped a poll later. `Unresolved` must read as a pending status.
    expect(stateFor({ tierGate: TranscriptEgressGate.Unresolved })).toBe(
      SyncFootnoteState.Loading
    );
    expect(stateFor({ tierGate: TranscriptEgressGate.Denied })).toBe(
      SyncFootnoteState.Inactive
    );
  });

  it("ISS-5348: prefers a settled truth to a skeleton that would never land", () => {
    // `Unknown` has no timeout: a signed-out or permanently offline device sits
    // there for the whole process lifetime, so holding Loading would be a
    // spinner that never resolves. The settled `!online` fact — and a terminal
    // failure — are reported instead.
    expect(
      stateFor({ online: false, tierGate: TranscriptEgressGate.Unresolved })
    ).toBe(SyncFootnoteState.NotConnected);
    expect(
      stateFor({
        online: false,
        tierGate: TranscriptEgressGate.Unresolved,
        statusCounts: counts(TranscriptSyncStatus.Dead),
      })
    ).toBe(SyncFootnoteState.Failed);
  });

  it("never claims completion, in either direction", () => {
    // The snapshot is a whole-table census of CURRENT statuses and carries no
    // history: `idle` covers "uploaded" and "never had anything to upload"
    // alike. So no label may assert that everything uploaded, and none may
    // assert that
    // nothing ever did (false for anyone who synced at `full` and later
    // lowered the level).
    for (const label of Object.values(SYNC_FOOTNOTE_LABELS)) {
      expect(label).not.toMatch(COMPLETION_CLAIM);
    }
    expect(SYNC_FOOTNOTE_LABELS[SyncFootnoteState.Disabled]).not.toMatch(
      NEGATIVE_HISTORY_CLAIM
    );
  });

  it("asserts no permission verdict for a denial it cannot attribute", () => {
    // A settled denial is either an insufficient consent tier or a denying org
    // policy, and the renderer cannot tell which. Naming a cause would invent a
    // specificity the snapshot does not carry.
    expect(SYNC_FOOTNOTE_LABELS[SyncFootnoteState.Inactive]).not.toMatch(
      PERMISSION_VERDICT
    );
  });

  it("labels every state except the two that render no text", () => {
    // `Loading` is a skeleton and, since ISS-5348, `Unavailable` renders
    // nothing at all — a failed read is a fact about us, not an answer about
    // the user's uploads. Every other state must carry copy.
    const wordless: SyncFootnoteState[] = [
      SyncFootnoteState.Loading,
      SyncFootnoteState.Unavailable,
    ];
    for (const state of Object.values(SyncFootnoteState)) {
      const label = SYNC_FOOTNOTE_LABELS[state];
      if (wordless.includes(state)) {
        expect(label).toBe("");
        continue;
      }
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it("never dresses a state in a success tone", () => {
    // The original copy's green shield read as a privacy guarantee it had not
    // earned. Nothing here re-earns it.
    for (const state of Object.values(SyncFootnoteState)) {
      expect(SYNC_FOOTNOTE_TONES[state]).not.toBe("success");
    }
    expect(SYNC_FOOTNOTE_TONES[SyncFootnoteState.Failed]).toBe("warning");
  });
});
