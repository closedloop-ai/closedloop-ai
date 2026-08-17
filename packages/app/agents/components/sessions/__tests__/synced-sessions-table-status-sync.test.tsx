import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { getTranscriptDispositionLabel } from "@repo/app/agents/lib/session-sync-status";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionListItemFixture } from "../session-list-fixtures";
import { SyncedSessionsTable } from "../synced-sessions-table";
import {
  getGridCellForSessionName,
  LOCAL_ONLY_LABEL_REGEX,
  PULSE_RING_CLASS_RE,
  renderWithFlags,
  STATUS_BADGE_TEST_ID,
  SYNCING_ARIA_LABEL_LEADS_RE,
  SYNCING_STATUS_LABEL_REGEX,
  TONE_BADGE_SELECTOR,
} from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

// ISS-5279: hoisted per Biome's useTopLevelRegex rule.
const SYNCING_ARIA_LABEL_RE = /syncing\.$/i;

// ISS-4774 (gate retired by ISS-5366, shipped ON): fold a still-uploading row's
// sync state into the EXISTING Status pill instead of two inline name-cell
// pills. An uploading row carries both `cloudSyncState: "pending"` (the gray
// "Local only" pill) and `transcriptDisposition: "syncing"` (the blue "Syncing"
// pill) — the two this collapses into one.
// Every default data column EXCEPT Status — the View-menu state wongk's
// hidden-column case describes.
// ISS-5666: `qualifiers` listed explicitly. This set means "everything but
// Status" and predates the `Signals` column, so leaving that id out was
// incidental — but once the qualifiers-column gate was retired the omission
// HID the column these cases read their verdict from, sending it nowhere.
const VISIBLE_COLUMNS_WITHOUT_STATUS = new Set([
  "name",
  "owner",
  "cost",
  "repo",
  "branch",
  "pr",
  "qualifiers",
  "started",
]);

describe("SyncedSessionsTable — ISS-4774 sync state in the Status pill", () => {
  // ISS-5366: with `sessions-honest-unknown-states` retired ON, the row's
  // DISPLAYED status is now folded against the staleness cutoff — and the fold
  // into the Status pill only applies to a row that actually reads Active. The
  // shared fixture's `lastActivityAt` is a fixed date, so against the real wall
  // clock every row here would read "Stale" and nothing would fold, making this
  // suite silently stop testing what it claims. Pin the clock to just after that
  // timestamp so the fixtures are genuinely live (AGENTS.md: clock-boundary
  // behavior is pinned with fake timers, never left to the real clock).
  const NOW = new Date("2026-06-01T14:45:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const uploadingItem = createAgentSessionListItemFixture({
    id: "uploading-session",
    name: "Uploading session",
    status: "active",
    cloudSyncState: AgentSessionCloudSyncState.Pending,
    transcriptDisposition: TranscriptDisposition.Syncing,
  });

  function getStatusCell(sessionName: string): HTMLElement {
    return getGridCellForSessionName(sessionName, "Status");
  }

  it("ONE Status pill, still labelled with the run status, pulsing — no second pill, no dot, no name-cell sync pills (ISS-5279)", () => {
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[uploadingItem]}
      />
    );

    // ISS-5279: ONE pill, and it is the row's OWN Status pill. The Status
    // vocabulary is a closed lifecycle set, so "Syncing" never becomes a value
    // in it — the pill keeps "Active" and pulses instead.
    const statusBadge = screen.getByTestId(STATUS_BADGE_TEST_ID);
    const statusCell = getStatusCell("Uploading session");
    expect(statusCell).toHaveTextContent("Active");
    expect(statusCell).not.toHaveTextContent(SYNCING_STATUS_LABEL_REGEX);
    expect(statusBadge.className).toMatch(PULSE_RING_CLASS_RE);
    // The duplicate Mike filed repeatedly: assert the SECOND pill is absent,
    // not merely that a pill exists.
    expect(statusCell.querySelectorAll(TONE_BADGE_SELECTOR)).toHaveLength(1);
    // ISS-5279: and no separate dot. `SessionLivenessDot` existed only to carry
    // the liveness the narrowed pill stopped stating; the pill states it again.
    expect(
      screen.queryByTestId("session-liveness-dot")
    ).not.toBeInTheDocument();

    // WCAG 1.4.1 / 2.5.3: the pulse is never the only carrier, and the
    // accessible name LEADS with the visible word so voice control still
    // matches the pill.
    expect(statusBadge.getAttribute("aria-label")).toMatch(
      SYNCING_ARIA_LABEL_LEADS_RE
    );
    expect(statusBadge.getAttribute("aria-label")).toMatch(
      SYNCING_ARIA_LABEL_RE
    );

    // Zero sync/local pills in the name column: neither the cloud-sync "Local
    // only" badge nor the inline transcript "Syncing" pill is rendered anywhere.
    expect(
      screen.queryByTestId("cloud-sync-state-badge")
    ).not.toBeInTheDocument();
    expect(screen.queryByText(LOCAL_ONLY_LABEL_REGEX)).not.toBeInTheDocument();
    const nameCell = screen.getByText("Uploading session").closest("span");
    expect(nameCell?.textContent).not.toContain("Syncing");
    expect(nameCell?.textContent).not.toContain("Local only");
  });

  it("an ERROR row that is uploading keeps its 'Failed' Status pill (never painted over as 'Syncing')", () => {
    // The reconciliation invariant (wongk / logical-QA, PR #4202): the Status
    // column carries the RUN outcome. Folding "Syncing" over a Failed row would
    // erase the only error signal and read as a calm blue pill. The fold is
    // scoped to Active rows, so a Failed+uploading row keeps "Failed".
    const failedUploadingItem = createAgentSessionListItemFixture({
      id: "failed-uploading-session",
      name: "Failed uploading session",
      status: "error",
      cloudSyncState: AgentSessionCloudSyncState.Pending,
      transcriptDisposition: TranscriptDisposition.Syncing,
    });
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[failedUploadingItem]}
      />
    );

    // Status pill still reads the real outcome, NOT "Syncing".
    const statusCell = getStatusCell("Failed uploading session");
    expect(statusCell).toHaveTextContent("Failed");
    expect(statusCell).not.toHaveTextContent(SYNCING_STATUS_LABEL_REGEX);
    expect(screen.queryByTestId(STATUS_BADGE_TEST_ID)).not.toBeInTheDocument();

    // The sync state used to be disclosed inline, once, by the chip that names
    // WHICH copy is behind (the one-chip cap, ISS-4953, ungated by ISS-5366).
    // ISS-5770 removed the `Signals` column that chip rendered into, so the list
    // states the sync verdict nowhere — it moved to Session Detail's Sync row.
    // Asserted as ABSENCE here so a chip creeping back onto a row fails, while
    // the Status-pill behaviour above (which is what this case is really about)
    // keeps its coverage.
    expect(screen.queryByTestId("cloud-sync-state-badge")).toBeNull();
  });

  it("a permanently-failed transcript (not uploading) never folds, so its Status pill keeps the run status", () => {
    // reconcileCloudSyncState maps `failedPermanent`/`stale` to `synced`, so
    // these rows are NOT uploading and never fold — the Status pill is never
    // repainted "Syncing" (logical-QA, PR #4202). The inline "Sync failed"
    // badge this case also used to assert went with the `Signals` column
    // (ISS-5770); it is asserted absent below as a creep-back guard.
    const failedPermanentItem = createAgentSessionListItemFixture({
      id: "failed-permanent-session",
      name: "Failed permanent session",
      status: "active",
      cloudSyncState: AgentSessionCloudSyncState.Synced,
      transcriptDisposition: TranscriptDisposition.FailedPermanent,
    });
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[failedPermanentItem]}
      />
    );

    // Not folded (not uploading): Status stays the run status.
    const statusCell = getStatusCell("Failed permanent session");
    expect(statusCell).not.toHaveTextContent(SYNCING_STATUS_LABEL_REGEX);
    // Creep-back guard for the chips the `Signals` column used to carry.
    expect(screen.queryByTestId("cloud-sync-state-badge")).toBeNull();
    expect(screen.queryByTestId("session-sync-status-badge")).toBeNull();
  });

  it("a `failedTransient` row does not fold, so it is never painted 'Syncing' (ISS-4846)", () => {
    // `reconcileCloudSyncState` maps `failedTransient` onto the SAME `pending`
    // cloudSyncState as `syncing`, so a fold gated on cloudSyncState swallowed a
    // retrying-after-failure row: its inline badge was suppressed and it rendered
    // the identical calm blue "Syncing" pill as a healthy in-flight row. The fold
    // keys on the transcript verdict itself, so this row does not fold.
    const failedTransientItem = createAgentSessionListItemFixture({
      id: "failed-transient-session",
      name: "Failed transient session",
      status: "active",
      cloudSyncState: AgentSessionCloudSyncState.Pending,
      transcriptDisposition: TranscriptDisposition.FailedTransient,
    });
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[failedTransientItem]}
      />
    );

    // Not folded: the Status pill stays the run status, never "Syncing".
    const statusCell = getStatusCell("Failed transient session");
    expect(statusCell).toHaveTextContent("Active");
    expect(statusCell).not.toHaveTextContent(SYNCING_STATUS_LABEL_REGEX);
    // ISS-5279 (PR review): the pill carries NO sync mark — it is the ordinary
    // Active pill. The Status pill's claim is "an upload is in flight", and this
    // row's is not; `isTranscriptBlobBehind` in `@repo/api` even counts this
    // verdict as still coming, so a pill asserting "no upload is in progress"
    // would have contradicted the badge sitting inches away.
    expect(screen.queryByTestId(STATUS_BADGE_TEST_ID)).not.toBeInTheDocument();
    // The retry verdict used to be disclosed inline, in the disclosure's own
    // words ("Transcript sync failed"). ISS-5770 removed the `Signals` column it
    // rendered into, so the list states it nowhere — it moved to Session
    // Detail's Sync row. Both chips are asserted absent as creep-back guards.
    expect(screen.queryByTestId("cloud-sync-state-badge")).toBeNull();
    expect(screen.queryByTestId("session-sync-status-badge")).toBeNull();
  });

  it("a synced (not-uploading) row keeps its normal Status pill and shows no sync pills", () => {
    const syncedItem = createAgentSessionListItemFixture({
      id: "synced-session",
      name: "Synced session",
      status: "active",
      cloudSyncState: AgentSessionCloudSyncState.Synced,
    });
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[syncedItem]}
      />
    );

    // Not uploading ⇒ the Status pill is the plain run status, never "Syncing".
    const statusCell = getStatusCell("Synced session");
    expect(statusCell).toHaveTextContent("Active");
    // ISS-5279: a GENUINELY finished sync carries no sync marker at all — the
    // one rendering that is allowed to look like "done", because it is.
    expect(screen.queryByTestId(STATUS_BADGE_TEST_ID)).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("cloud-sync-state-badge")
    ).not.toBeInTheDocument();
  });
  it("an uploading row never renders TWO pills for the one sync fact (ISS-5036)", () => {
    // The ISS-5036 screenshot: one row carrying "Syncing" (the transcript
    // disposition badge) AND "Transcript still syncing" (the cloud-sync badge) —
    // the same fact twice, both in the Session Name cell. Whatever the fold does
    // with the Status column, the row must never say it twice.
    //
    // Which chip survived USED to be settled by `disclosureNamesTheVerdict` in
    // `buildSessionRowQualifiers` (`session-row-state-chips.tsx`). ISS-5770
    // removed the `Signals` column both chips rendered into and deleted that
    // module, so on the list NEITHER survives — the sync verdict is stated on
    // Session Detail's Sync row instead. The ISS-5036 invariant was "never the
    // same fact twice"; with no chip at all it holds in its strongest form, so
    // both are asserted ABSENT and these stand as creep-back guards.
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[uploadingItem]}
        visibleColumns={VISIBLE_COLUMNS_WITHOUT_STATUS}
      />
    );

    // Neither the disclosure chip nor the bare verdict pill reaches the list.
    expect(screen.queryByTestId("cloud-sync-state-badge")).toBeNull();
    expect(screen.queryAllByText(SYNCING_STATUS_LABEL_REGEX)).toHaveLength(0);
  });

  it("the Status column is hidden: the fold stands down, and no sync chip is left behind on the row (ISS-4848)", () => {
    // wongk: with Status hidden from the View menu the grid renders no Status
    // cell, so a folded row's sync pill has nowhere to live — and the fold also
    // suppresses the name-cell badge, which left an actively-uploading row with
    // no sync signal anywhere in the grid. `isSyncStateFoldActive` gates the fold
    // on Status visibility, so the fold stands down here.
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[uploadingItem]}
        visibleColumns={VISIBLE_COLUMNS_WITHOUT_STATUS}
      />
    );

    // No folded Status pill anywhere (there is no Status cell to hold it).
    expect(screen.queryByTestId(STATUS_BADGE_TEST_ID)).not.toBeInTheDocument();
    // ISS-4848 originally asserted that a stood-down fold hands sync state BACK
    // to the Name cell; ISS-5666 moved that destination to the `Signals` column
    // and ISS-5770 removed the column outright, so the list now states the sync
    // verdict nowhere (it lives on Session Detail's Sync row). The fold
    // behaviour above is what this case is really about and keeps its coverage;
    // BOTH sync chips are asserted absent below as creep-back guards, so a chip
    // reappearing on a row fails here. They are separate components with
    // separate test ids — asserting one of them twice, as this did, left the
    // other uncovered.
    expect(screen.queryByTestId("cloud-sync-state-badge")).toBeNull();
    expect(screen.queryByTestId("session-sync-status-badge")).toBeNull();
  });

  it("this unfolded row drops the DUPLICATE freshness pill, keeping the disclosure that names the same verdict (#4284)", () => {
    // The cap applies on THIS surface too, not just web. One chip: the
    // disclosure that names the verdict, with the freshness pill that would
    // merely restate it suppressed.
    renderWithFlags(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[uploadingItem]}
        visibleColumns={VISIBLE_COLUMNS_WITHOUT_STATUS}
      />
    );

    // ISS-5770: neither chip renders on the list any more — the `Signals`
    // column they shared is gone and the disclosure moved to Session Detail's
    // Sync row. The #4284 invariant was "never the same fact twice"; with the
    // column removed the stronger claim holds, so both are asserted absent.
    // The freshness pill is checked by its own canonical label ("Syncing"),
    // which the disclosure's sentence-cased "Transcript still syncing" does not
    // contain, so the two remain genuinely distinguished rather than
    // substring-confused.
    expect(screen.queryByTestId("cloud-sync-state-badge")).toBeNull();
    // `getTranscriptDispositionLabel` returns `string | null`. Narrowed rather
    // than defaulted because the assertion below is an ABSENCE check: a null
    // label would search for nothing and report length 0 no matter what the
    // list rendered, so the test would pass vacuously exactly when the label
    // lookup broke. Failing here instead keeps the absence claim meaningful.
    const syncingLabel = getTranscriptDispositionLabel(
      TranscriptDisposition.Syncing
    );
    if (syncingLabel === null) {
      throw new Error(
        "getTranscriptDispositionLabel(Syncing) returned null; the absence assertion below would be vacuous."
      );
    }
    expect(screen.queryAllByText(syncingLabel)).toHaveLength(0);
  });
});
