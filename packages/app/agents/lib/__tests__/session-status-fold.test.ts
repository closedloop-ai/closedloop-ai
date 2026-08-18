import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionListItemFixture } from "../../components/sessions/session-list-fixtures";
import { SESSION_STATUS_FILTER_OPTIONS } from "../session-status-filters";
import {
  isSessionRowUploading,
  isSessionSyncStateFolded,
  resolveSessionSyncPresentation,
  toSessionTableRowWithSyncFold,
} from "../session-status-fold";
import { SessionSyncPresentation } from "../session-sync-presentation";

const FOLD_ON = true;
const FOLD_OFF = false;

/**
 * ISS-5366: `toSessionTableRowWithSyncFold` now folds the DISPLAYED status
 * against the staleness cutoff unconditionally (`sessions-honest-unknown-states`
 * retired ON), and the sync fold only applies to a row that actually reads
 * Active. The shared fixture's `lastActivityAt` is a fixed date, so against the
 * real wall clock every row here would read "Stale" and nothing would fold —
 * the suite would go green on vacuously-unfolded rows. Pin the clock just after
 * that timestamp so the fixtures are genuinely live.
 */
const NOW = new Date("2026-06-01T14:45:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function uploadingActiveItem() {
  return createAgentSessionListItemFixture({
    id: "uploading-active",
    name: "Uploading active session",
    status: SESSION_STATUS.ACTIVE,
    cloudSyncState: AgentSessionCloudSyncState.Pending,
    transcriptDisposition: TranscriptDisposition.Syncing,
  });
}

describe("isSessionRowUploading", () => {
  it("is true only for a transcript verdict of `syncing`", () => {
    expect(isSessionRowUploading(uploadingActiveItem())).toBe(true);
    expect(
      isSessionRowUploading(
        createAgentSessionListItemFixture({
          transcriptDisposition: TranscriptDisposition.Synced,
        })
      )
    ).toBe(false);
  });

  it("is FALSE for a `failedTransient` row, whose upload attempt failed (ISS-4846)", () => {
    // `reconcileCloudSyncState` maps `failedTransient` onto `pending` alongside
    // `syncing`, so the original `cloudSyncState`-based gate folded a retrying
    // row, suppressed its "Sync failed" badge, and painted it the same calm blue
    // "Syncing" as a healthy in-flight row — the verdict vanished.
    expect(
      isSessionRowUploading(
        createAgentSessionListItemFixture({
          cloudSyncState: AgentSessionCloudSyncState.Pending,
          transcriptDisposition: TranscriptDisposition.FailedTransient,
        })
      )
    ).toBe(false);
  });

  it("is FALSE for a LOCAL-ONLY row: pending, but with no transcript verdict (ISS-4846)", () => {
    // `pending` with no verdict means the row is not in the cloud AT ALL, which
    // #4150 deliberately words differently from "the transcript is still
    // uploading". Folding it would flatten the two messages back together.
    expect(
      isSessionRowUploading(
        createAgentSessionListItemFixture({
          cloudSyncState: AgentSessionCloudSyncState.Pending,
          transcriptDisposition: undefined,
        })
      )
    ).toBe(false);
  });
});

describe("isSessionSyncStateFolded", () => {
  it("folds an Active, still-uploading row when the flag is on", () => {
    expect(isSessionSyncStateFolded(uploadingActiveItem(), FOLD_ON)).toBe(true);
  });

  it("never folds while the flag is off, even for an Active uploading row", () => {
    // The closed-by-default gate: with the flag off this predicate is the ONLY
    // thing standing between today's inline pills and the folded presentation.
    expect(isSessionSyncStateFolded(uploadingActiveItem(), FOLD_OFF)).toBe(
      false
    );
  });

  it("never folds a non-Active DISPLAYED status, so a real outcome is never crowded out", () => {
    // `waiting` is the regression guard: `normalizeSessionStatus` collapses it
    // into `active`, so the original predicate (#4202) folded awaiting-input rows
    // despite excluding them in its own docstring. The fold reads the DISPLAYED
    // vocabulary — the same one the Status facet offers and the Status sort ranks
    // — so Waiting stays Waiting.
    for (const status of [
      SESSION_STATUS.ERROR,
      DISPLAYED_SESSION_STATUS.WAITING,
      SESSION_STATUS.INACTIVE,
    ]) {
      const item = createAgentSessionListItemFixture({
        status,
        cloudSyncState: AgentSessionCloudSyncState.Pending,
        transcriptDisposition: TranscriptDisposition.Syncing,
      });
      expect(isSessionSyncStateFolded(item, FOLD_ON)).toBe(false);
    }
  });

  it("never folds a settled (non-uploading) row, so stale/failed verdicts keep their inline badge", () => {
    // reconcileCloudSyncState maps `stale`/`failedPermanent` to `synced`, so
    // these rows are not uploading. They must NOT fold — folding suppresses the
    // inline disposition badge, which would drop the verdict entirely.
    for (const disposition of [
      TranscriptDisposition.Stale,
      TranscriptDisposition.FailedPermanent,
    ]) {
      const item = createAgentSessionListItemFixture({
        status: SESSION_STATUS.ACTIVE,
        cloudSyncState: AgentSessionCloudSyncState.Synced,
        transcriptDisposition: disposition,
      });
      expect(isSessionSyncStateFolded(item, FOLD_ON)).toBe(false);
    }
  });
});

describe("toSessionTableRowWithSyncFold", () => {
  it("marks a folded row `syncing` without rewriting its run status", () => {
    const row = toSessionTableRowWithSyncFold(uploadingActiveItem(), FOLD_ON);

    expect(row.syncPresentation).toBe(SessionSyncPresentation.Syncing);
    // ISS-4846, the load-bearing assertion: `status` is the value the Status
    // facet filter and the server-side Status sort both key off, and the fold
    // must never rewrite it — only the presentational marker is added.
    expect(row.status).toBe(SESSION_STATUS.ACTIVE);
  });

  /**
   * ISS-6455: the row now projects Waiting from `awaitingInputSince`, so an
   * uploading awaiting-input row stops folding — the Active-only rule this
   * predicate has enforced since ISS-4846, now reached by a desktop-local row
   * that already read "Waiting" everywhere else.
   *
   * This is PARITY, not a new rule: a CLOUD row in the same state has been
   * getting this answer since the server started serving `waiting` outright, and
   * the projection here is what brings the desktop-local row to the same place.
   *
   * It does drop the row's only in-flight signal in the grid, and that is stated
   * rather than waved away: ISS-5666 cleared the Name cell and ISS-5770 deleted
   * the `Signals` column, so `SessionSyncStatusBadge` has no production render
   * site left and there is no inline badge to fall back on. Restoring one is a
   * UI decision for the Sessions surface, not something this fold should decide
   * by exempting `waiting` from a rule the cloud already applies.
   */
  it("ISS-6455: stands down for an uploading row that is awaiting input", () => {
    const row = toSessionTableRowWithSyncFold(
      createAgentSessionListItemFixture({
        id: "uploading-awaiting",
        name: "Uploading awaiting-input session",
        status: SESSION_STATUS.ACTIVE,
        awaitingInputSince: new Date(NOW.getTime() - 60 * 1000),
        endedAt: null,
        cloudSyncState: AgentSessionCloudSyncState.Pending,
        transcriptDisposition: TranscriptDisposition.Syncing,
      }),
      FOLD_ON
    );

    expect(row.status).toBe(DISPLAYED_SESSION_STATUS.WAITING);
    expect(row.syncPresentation).toBeUndefined();
  });

  it("leaves `syncPresentation` unset for every non-folded row", () => {
    expect(
      toSessionTableRowWithSyncFold(uploadingActiveItem(), FOLD_OFF)
        .syncPresentation
    ).toBeUndefined();
    expect(
      toSessionTableRowWithSyncFold(
        createAgentSessionListItemFixture({
          status: SESSION_STATUS.ERROR,
          cloudSyncState: AgentSessionCloudSyncState.Pending,
          transcriptDisposition: TranscriptDisposition.Syncing,
        }),
        FOLD_ON
      ).syncPresentation
    ).toBeUndefined();
  });

  it("emits a status the Status facet vocabulary can actually filter to (ISS-4846)", () => {
    // The reconciliation this ticket is about: whatever the fold does to a row,
    // the row's `status` must remain one of the values the Status facet offers,
    // so "filter to what the cell shows" is always possible. A fold that wrote a
    // sync-lane value (e.g. "syncing") into `status` would fail here.
    const facetValues = new Set(
      SESSION_STATUS_FILTER_OPTIONS.map((option) => option.value)
    );
    const foldedRow = toSessionTableRowWithSyncFold(
      uploadingActiveItem(),
      FOLD_ON
    );
    expect(facetValues.has(foldedRow.status)).toBe(true);
  });
});

// ISS-5279: the pulse's scope. The pill claims exactly one thing — an upload is
// in flight — and PR review is what narrowed it to that. Every other verdict
// keeps its Name-cell disposition badge and is NOT restated here, so these cases
// pin the boundary rather than a second vocabulary.
describe("resolveSessionSyncPresentation — in-flight, and nothing else", () => {
  function activeItemWith(disposition: TranscriptDisposition) {
    return createAgentSessionListItemFixture({
      status: SESSION_STATUS.ACTIVE,
      cloudSyncState: AgentSessionCloudSyncState.Synced,
      transcriptDisposition: disposition,
    });
  }

  it("an in-flight upload is `Syncing` — the only state that pulses", () => {
    expect(resolveSessionSyncPresentation(uploadingActiveItem(), FOLD_ON)).toBe(
      SessionSyncPresentation.Syncing
    );
  });

  it("EVERY non-in-flight verdict yields no presentation, so the pill never restates the Name cell's badge", () => {
    // PR review removed the second `Unresolved` presentation. `stale` /
    // `failedTransient` / `failedPermanent` are not "finished", but they already
    // state themselves through the Name cell's disposition badge — which this
    // fold never suppresses for a row that is not uploading (see
    // `isSessionSyncStateFolded`) — so marking them again on the pill was the
    // duplication ISS-5279 exists to delete.
    //
    // `failedTransient` also makes the point that this is correctness, not just
    // tidiness: `isTranscriptBlobBehind` in `@repo/api` — the exported SSOT for
    // "is an upload still coming" — counts it as still coming, so a pill saying
    // "no upload is in progress" contradicted the very badge sitting inches away
    // saying "It retries automatically".
    for (const disposition of [
      TranscriptDisposition.Stale,
      TranscriptDisposition.FailedTransient,
      TranscriptDisposition.FailedPermanent,
      TranscriptDisposition.Synced,
      TranscriptDisposition.NeverExpected,
    ]) {
      expect(
        resolveSessionSyncPresentation(activeItemWith(disposition), FOLD_ON)
      ).toBeUndefined();
    }
  });

  it("`Syncing` is gated by the flag and by the displayed run status", () => {
    const uploading = uploadingActiveItem();
    // Flag off — the closed-by-default path renders nothing new.
    expect(resolveSessionSyncPresentation(uploading, FOLD_OFF)).toBeUndefined();
    // Non-Active displayed status — a pulse over a settled outcome would read as
    // "this is still moving".
    expect(
      resolveSessionSyncPresentation(uploading, FOLD_ON, SESSION_STATUS.ERROR)
    ).toBeUndefined();
  });

  it("an unrecognized disposition from a newer producer claims nothing", () => {
    // Version skew: a client that does not know the verdict must not assert
    // "syncing" — a pulse it cannot justify.
    const item = createAgentSessionListItemFixture({
      status: SESSION_STATUS.ACTIVE,
      cloudSyncState: AgentSessionCloudSyncState.Synced,
      transcriptDisposition: "someFutureVerdict" as TranscriptDisposition,
    });
    expect(resolveSessionSyncPresentation(item, FOLD_ON)).toBeUndefined();
  });

  it("a row carrying NO transcript verdict claims nothing either", () => {
    // Reachable, not theoretical: `transcriptDisposition` is optional on the
    // wire and a desktop local row can land without one (PR review). It renders
    // the ordinary pill — the same one it rendered before this ticket — because
    // the pill's claim is "in flight", and an absent verdict is not that.
    const item = createAgentSessionListItemFixture({
      status: SESSION_STATUS.ACTIVE,
      cloudSyncState: AgentSessionCloudSyncState.Synced,
      transcriptDisposition: undefined,
    });
    expect(resolveSessionSyncPresentation(item, FOLD_ON)).toBeUndefined();
  });
});
