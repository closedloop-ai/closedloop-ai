import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  TranscriptAvailability,
  type TranscriptFileDescriptor,
} from "@repo/api/src/types/desktop-transcripts";
import { SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY } from "@repo/api/src/types/session-transcript-never-expected-flag";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { FixtureRoute } from "../../../../shared/storybook/fixture-fetch";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { SessionTranscriptPanel } from "../session-transcript-panel";

/**
 * ISS-7516 — a NEVER-EXPECTED transcript must not be reported as a NOT-YET-
 * ARRIVED one.
 *
 * A machine whose data-sync level keeps transcripts local never queues one
 * (`syncTierAllowsTranscripts` admits only `full`), so the server synthesizes a
 * `missing` main forever and the panel told the reader, indefinitely, that the
 * source machine would upload it. It will not.
 *
 * Every negative case here is paired with a POSITIVE sibling on purpose. A spec
 * that only proves the new wording appears would stay green if the change had
 * simply replaced the pending state outright — which would be a different lie,
 * told to every `full`-level machine mid-upload. So each case that asserts the
 * settled wording also asserts the pending wording is ABSENT, and the sibling
 * asserts the pending wording still renders, from the same fixture, with only
 * the never-expected verdict flipped.
 *
 * Assertions are on TEXT, never on `toBeVisible` or a class: the acceptance
 * criterion is that the two absences are distinguishable without colour (WCAG
 * 1.4.1), and `toBeVisible` passes for an `sr-only` node that carries no
 * on-screen difference at all.
 *
 * Expected strings are pinned as INDEPENDENT LITERALS rather than imported from
 * `session-transcript-status-copy`. Reading the expectation out of the module
 * under test would make this suite agree with any copy, including an accidental
 * one that erased the distinction.
 */

const SESSION_ID = "session-transcript-never-expected-1";
const NEVER_EXPECTED_TITLE = "Transcript stays on this machine";
const NEVER_EXPECTED_REASON = /data sync level, not a stalled upload/i;
const PENDING_TITLE = "Transcript still syncing";
const PENDING_NOTICE = /once the source machine uploads it/i;
const FLAGS = [SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY] as const;
/** The Properties pane's Sync row, found by its own label rather than position. */
const SYNC_ROW_LABEL = "Sync";
const SYNCING_ROW_VALUE = /^Syncing(\s|$|\s·)/;
const NO_TRANSCRIPT_ROW_VALUE = /^No transcript(\s|$|\s·)/;
const SYNCED_ROW_VALUE = /^Synced(\s|$|\s·)/;
const UPLOADED_AT = "2026-08-01T00:00:00.000Z";

function missingDescriptor(): TranscriptFileDescriptor {
  return {
    fileKey: "main",
    availability: TranscriptAvailability.Missing,
    url: null,
    byteSize: null,
    rawSha256: null,
    uploadedAt: null,
    lastObservedAt: null,
    permanentFailureReason: null,
  };
}

function transcriptRoute(): FixtureRoute {
  return {
    method: "GET",
    path: `/agent-sessions/${SESSION_ID}/transcript`,
    respond: () => ({ sessionId: SESSION_ID, files: [missingDescriptor()] }),
  };
}

/**
 * The same session carrying the cloud's own verdict for a zero-transcript-row
 * identity. `deriveTranscriptDisposition` folds a synthesized `missing` main to
 * `syncing`, which is what the Sync row and the list badge both read.
 */
function syncingSession(): AgentSessionDetail {
  return {
    ...session(),
    transcriptDisposition: TranscriptDisposition.Syncing,
  };
}

/**
 * An ARCHIVED main transcript: the machine really did upload it, back when its
 * data-sync level was `full`. No signed url/sha, so `isReadable` stays false and
 * no byte read is attempted — `stubBytes` keeps its meaning as "an unexpected
 * fetch is a failure" rather than becoming an expected rejection.
 */
function archivedDescriptor(): TranscriptFileDescriptor {
  return {
    fileKey: "main",
    availability: TranscriptAvailability.Available,
    url: null,
    byteSize: null,
    rawSha256: null,
    uploadedAt: UPLOADED_AT,
    lastObservedAt: null,
    permanentFailureReason: null,
  };
}

function archivedTranscriptRoute(): FixtureRoute {
  return {
    method: "GET",
    path: `/agent-sessions/${SESSION_ID}/transcript`,
    respond: () => ({ sessionId: SESSION_ID, files: [archivedDescriptor()] }),
  };
}

/**
 * The MIXED-tier fixture: a session uploaded while this machine was on `full` —
 * real archived bytes, and the cloud's own `synced` verdict — viewed on a
 * machine whose level is NOW `metadata`, so the shell reports
 * `transcriptNeverExpected: true` for it. A fixture whose session and tier agree
 * cannot express this state, and passes whether or not the override is gated.
 */
function previouslySyncedSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    transcriptDisposition: TranscriptDisposition.Synced,
    transcripts: [
      {
        fileKey: "main",
        availability: TranscriptAvailability.Available,
        uploadedAt: UPLOADED_AT,
        permanentFailureReason: null,
      },
    ],
  });
}

function session(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    transcripts: [
      {
        fileKey: "main",
        availability: TranscriptAvailability.Missing,
        uploadedAt: null,
        permanentFailureReason: null,
      },
    ],
  });
}

/**
 * The Properties row that owns `label`, from the label node itself — so a row
 * assertion cannot accidentally match text belonging to a sibling row or to the
 * transcript panel below.
 */
function getSyncRow(label: HTMLElement): HTMLElement {
  const row = label.parentElement;
  if (!row) {
    throw new Error("Sync row label is not inside a property row");
  }
  return row;
}

/** Fails any byte fetch, so a read that should never happen is observable. */
function stubBytes(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL | Request) =>
      Promise.reject(new Error(`Unexpected fetch: ${String(url)}`))
    )
  );
}

function renderPanel(input: {
  transcriptNeverExpected?: boolean;
  enabledFlags?: readonly string[];
}) {
  stubBytes();
  return render(
    <AppCoreStoryProviders
      apiRoutes={[transcriptRoute()]}
      enabledFlags={input.enabledFlags}
    >
      <SessionTranscriptPanel
        session={session()}
        transcriptNeverExpected={input.transcriptNeverExpected}
      />
    </AppCoreStoryProviders>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SessionTranscriptPanel — never-expected vs not-yet-arrived", () => {
  it("states the settled absence, in text, when the surface reports the transcript is never expected", async () => {
    renderPanel({ enabledFlags: FLAGS, transcriptNeverExpected: true });

    expect(await screen.findByText(NEVER_EXPECTED_TITLE)).toBeInTheDocument();
    // AC: the REASON is discoverable — the reader can tell this from a stalled
    // upload without opening Settings to guess.
    expect(screen.getByText(NEVER_EXPECTED_REASON)).toBeInTheDocument();
    // AC: distinct from the pending state, in words rather than hue.
    expect(screen.queryByText(PENDING_TITLE)).toBeNull();
    expect(screen.queryByText(PENDING_NOTICE)).toBeNull();
  });

  it("keeps the not-yet-arrived wording for a machine whose level does carry transcripts", async () => {
    // The POSITIVE sibling. Same fixture, same flag, same `missing` descriptor —
    // only the verdict differs. Without this, deleting the pending branch
    // outright would leave the spec above green while telling every `full`-level
    // machine that its in-flight upload is never coming.
    renderPanel({ enabledFlags: FLAGS, transcriptNeverExpected: false });

    expect(await screen.findByText(PENDING_TITLE)).toBeInTheDocument();
    expect(screen.getByText(PENDING_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(NEVER_EXPECTED_TITLE)).toBeNull();
  });

  it("keeps the not-yet-arrived wording when the surface cannot answer at all", async () => {
    // An absent answer must render the unchanged pending state, never be
    // coerced into a verdict. Reached when NEITHER producer has evidence — no
    // served `dataSyncLevel` and no local shell answer. (Since ISS-7516's wire
    // half the web usually DOES have evidence; the web-side derivation is
    // covered in `session-transcript-never-expected-web.test.tsx`.)
    renderPanel({ enabledFlags: FLAGS });

    expect(await screen.findByText(PENDING_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(NEVER_EXPECTED_TITLE)).toBeNull();
  });

  it("stays closed by default: a never-expected verdict renders nothing new with the flag off", async () => {
    // ISS-4779 closed-by-default. `enabledFlags` omitted, so the shared gate
    // resolves false on both surfaces and the panel is byte-identical to today.
    renderPanel({ transcriptNeverExpected: true });

    expect(await screen.findByText(PENDING_TITLE)).toBeInTheDocument();
    expect(screen.getByText(PENDING_NOTICE)).toBeInTheDocument();
    expect(screen.queryByText(NEVER_EXPECTED_TITLE)).toBeNull();
  });
});

describe("AgentSessionDetailView — the Sync row agrees with the panel", () => {
  it("stops the Properties Sync row saying Syncing beside a panel saying it is not coming", async () => {
    // The cloud folds a zero-row session to `syncing` and has no representation
    // of the source machine's data-sync level, so before this the same screen
    // carried two opposite claims about one fact: the Sync row nine lines above
    // the panel read "Syncing". Asserted on the COMPOSITE, because the two rows
    // live in sibling components and only the workspace mounts both.
    stubBytes();
    render(
      <AppCoreStoryProviders
        apiRoutes={[transcriptRoute()]}
        enabledFlags={FLAGS}
      >
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={syncingSession()}
          transcriptNeverExpected={true}
        />
      </AppCoreStoryProviders>
    );

    await screen.findByText(NEVER_EXPECTED_TITLE);
    await userEvent.click(screen.getByRole("button", { name: "Properties" }));

    expect(await screen.findByText(SYNC_ROW_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(SYNCING_ROW_VALUE)).toBeNull();
    expect(screen.getByText(NO_TRANSCRIPT_ROW_VALUE)).toBeInTheDocument();
  });

  it("keeps a historically-synced session's real disposition when the tier changed AFTER it uploaded", async () => {
    // Review cid 3836677336. A data-sync level is not retroactive: sessions
    // uploaded while this machine was on `full` have real archived bytes, and
    // switching the machine to `metadata` afterwards cannot un-upload them.
    // `transcriptNeverExpected` describes the CURRENT tier, so it is true for
    // those old sessions too — while the panel below still renders the
    // conversation, because its own gate is `availability === missing`.
    //
    // The fixture is deliberately MIXED-tier: an archived transcript and a
    // `synced` disposition under a machine now reporting never-expected. A
    // fixture where the session and the tier agree passes either way and would
    // not have caught this.
    stubBytes();
    render(
      <AppCoreStoryProviders
        apiRoutes={[archivedTranscriptRoute()]}
        enabledFlags={FLAGS}
      >
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={previouslySyncedSession()}
          transcriptNeverExpected={true}
        />
      </AppCoreStoryProviders>
    );

    await userEvent.click(screen.getByRole("button", { name: "Properties" }));

    // Scoped to the Sync ROW, not the document: this fixture's transcript is
    // archived but not readable in-test, so the PANEL legitimately carries its
    // own "No transcript is available…" copy. A document-wide matcher would
    // confuse that unrelated string with the row's verdict and could never fail
    // for the right reason.
    const syncRow = within(getSyncRow(await screen.findByText(SYNC_ROW_LABEL)));
    // The row must state what is true of THIS session, not of the machine's
    // current level. Before the fix it read
    // "No transcript · Last synced Jun 10, 2026" over a transcript the archive
    // still holds.
    expect(syncRow.getByText(SYNCED_ROW_VALUE)).toBeInTheDocument();
    expect(syncRow.queryByText(NO_TRANSCRIPT_ROW_VALUE)).toBeNull();
    // And the panel never claimed otherwise — it gates on `missing`, so the two
    // now agree instead of contradicting each other on one screen.
    expect(screen.queryByText(NEVER_EXPECTED_TITLE)).toBeNull();
  });

  it("leaves the Sync row alone when the transcript really is still on its way", async () => {
    // The positive sibling: the SAME `syncing` disposition, the same flag, the
    // verdict flipped. Without it, hard-coding the row to "No transcript" would
    // pass the case above.
    stubBytes();
    render(
      <AppCoreStoryProviders
        apiRoutes={[transcriptRoute()]}
        enabledFlags={FLAGS}
      >
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={syncingSession()}
          transcriptNeverExpected={false}
        />
      </AppCoreStoryProviders>
    );

    await screen.findByText(PENDING_TITLE);
    await userEvent.click(screen.getByRole("button", { name: "Properties" }));

    expect(await screen.findByText(SYNC_ROW_LABEL)).toBeInTheDocument();
    expect(screen.getByText(SYNCING_ROW_VALUE)).toBeInTheDocument();
    expect(screen.queryByText(NO_TRANSCRIPT_ROW_VALUE)).toBeNull();
  });
});

describe("AgentSessionDetailView — never-expected verdict reaches the panel", () => {
  it("forwards the shell's verdict through the composed view the shells actually mount", async () => {
    // Graded on the COMPOSITE, not the leaf. Both shells mount
    // `AgentSessionDetailView`, and the verdict travels shell → view →
    // workspace → panel; a spec that only rendered the panel would stay green
    // if any link in that chain dropped the prop.
    stubBytes();
    render(
      <AppCoreStoryProviders
        apiRoutes={[transcriptRoute()]}
        enabledFlags={FLAGS}
      >
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={session()}
          transcriptNeverExpected={true}
        />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText(NEVER_EXPECTED_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(PENDING_TITLE)).toBeNull();
  });

  it("renders the pending state through the same composite when the shell says otherwise", async () => {
    stubBytes();
    render(
      <AppCoreStoryProviders
        apiRoutes={[transcriptRoute()]}
        enabledFlags={FLAGS}
      >
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={session()}
          transcriptNeverExpected={false}
        />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText(PENDING_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(NEVER_EXPECTED_TITLE)).toBeNull();
  });
});
