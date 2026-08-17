import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
  STALE_SESSION_DISPLAY_THRESHOLD_HOURS,
} from "@repo/api/src/types/session-status";
import {
  SESSION_STALE_TOOLTIP,
  SESSION_STATUS_LABELS,
} from "@repo/api/src/types/session-status-display";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGridCellForSessionName,
  renderWithFlags,
} from "../../sessions/__tests__/synced-sessions-table.test-helpers";
import { createAgentSessionListItemFixture } from "../../sessions/session-list-fixtures";
import { SyncedSessionsTable } from "../../sessions/synced-sessions-table";
import { SessionDurationProperty } from "../session-duration-property";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

/**
 * ISS-5575: the Sessions LIST and the session DETAIL must not report two
 * different spans for ONE run.
 *
 * The list mapper (`session-table-row.ts`) resolves the DISPLAYED status once
 * and feeds THAT to the Duration rule, so a stored-`active` run silent past the
 * staleness cutoff badges "Stale" and its Duration cell goes to the em-dash
 * together. The detail resolved the same rule from the RAW `session.status`, so
 * the same record read "—" in the list and a number climbing against `now()` one
 * click away.
 *
 * THE COMPARISON THAT MATTERS IS LIST-VS-DETAIL, NOT EACH-VS-A-CONSTANT — the
 * ISS-5565 rule this file inherits from `session-measured-properties.test.tsx`.
 * Both surfaces render from ONE record in ONE tree and are asserted equal to
 * EACH OTHER; a shared constant would keep passing if the two drifted apart
 * again in the same direction, which is exactly the failure being fixed.
 *
 * The list side is driven through `SyncedSessionsTable` with a RAW
 * `AgentSessionListItem`, not a pre-mapped row fixture, so the mapper's own
 * derivation is in the loop. Pre-mapping the row would hand both surfaces the
 * same answer by construction and prove nothing.
 *
 * The fresh-session case is the control: it fails if the fix "agrees" by turning
 * every detail Duration into a dash.
 */

const SESSION_NAME = "Cross-surface duration parity";
const DURATION_HEADER_LABEL = "Duration";
const STATUS_HEADER_LABEL = "Status";
const EM_DASH = "—";
const HOUR_MS = 60 * 60 * 1000;
const FIXED_NOW = new Date("2026-06-11T12:00:00.000Z");
/** Comfortably past the display cutoff, so the fold is not a boundary accident. */
const SILENT_FOR_MS = (STALE_SESSION_DISPLAY_THRESHOLD_HOURS + 6) * HOUR_MS;
/** Well inside the cutoff — this run is genuinely still moving. */
const FRESH_FOR_MS = HOUR_MS;
const RAN_FOR_MS = 3 * HOUR_MS;

/**
 * The ONE record both surfaces render. Deliberately the raw persisted shape —
 * a stored `active` status plus the timestamps the displayed-status derivation
 * reads — so each surface has to reach the same answer by running the
 * derivation, not by being handed it.
 */
type SessionRecord = {
  status: string;
  startedAt: Date;
  lastActivityAt: Date;
  endedAt: Date | null;
  awaitingInputSince: Date | null;
};

function activeRecordSilentFor(silentForMs: number): SessionRecord {
  return {
    awaitingInputSince: null,
    endedAt: null,
    lastActivityAt: new Date(FIXED_NOW.getTime() - silentForMs),
    startedAt: new Date(FIXED_NOW.getTime() - RAN_FOR_MS),
    status: SESSION_STATUS.ACTIVE,
  };
}

/**
 * ISS-6455: the same record, blocked on a human. The desktop LOCAL producer
 * serves exactly this shape — a raw `active` status with `awaitingInputSince`
 * beside it — whenever the `sessions-displayed-status-parity` Labs gate is off,
 * which is its closed-by-default state.
 *
 * The fixture above hardcoded `awaitingInputSince: null`, so the ONE branch that
 * diverged was never seeded and this file stayed green through the split it
 * exists to catch.
 */
function awaitingInputRecordSilentFor(silentForMs: number): SessionRecord {
  return {
    ...activeRecordSilentFor(silentForMs),
    awaitingInputSince: new Date(FIXED_NOW.getTime() - silentForMs),
  };
}

/** Render the LIST and the DETAIL from one record, in one tree. */
function renderBothSurfaces(record: SessionRecord) {
  return renderWithFlags(
    <>
      <div data-testid="list-surface">
        <SyncedSessionsTable
          getSessionHref={(item) => `/sessions/${item.id}`}
          items={[
            createAgentSessionListItemFixture({
              ...record,
              id: "ses-duration-parity",
              name: SESSION_NAME,
              wallClock: null,
            }),
          ]}
          visibleColumns={new Set(["name", "status", "duration"])}
        />
      </div>
      <div data-testid="detail-surface">
        <SessionDurationProperty session={record} />
      </div>
    </>
  );
}

/** The list row's Duration cell text, scoped to that column's cell. */
function listDurationText(): string {
  return (
    getGridCellForSessionName(
      SESSION_NAME,
      DURATION_HEADER_LABEL
    ).textContent?.trim() ?? ""
  );
}

function listStatusText(): string {
  return (
    getGridCellForSessionName(
      SESSION_NAME,
      STATUS_HEADER_LABEL
    ).textContent?.trim() ?? ""
  );
}

/**
 * The detail Duration row's VALUE, with its label stripped. Scoped to the detail
 * surface because the list renders a "Duration" column header with the same
 * word, and matching that would compare a header against a value.
 */
function detailDurationRow(): HTMLElement {
  const detail = screen.getByTestId("detail-surface");
  const label = within(detail).getByText(DURATION_HEADER_LABEL);
  const row = label.closest<HTMLElement>(".prd-prop");
  if (!row) {
    throw new Error("detail did not render a Duration property row");
  }
  return row;
}

/**
 * The detail Duration row's VISIBLE value — label, screen-reader-only text, and
 * tooltip copy removed.
 *
 * Both strips are load-bearing, not convenience. ISS-5575 gives the empty
 * Duration an `explanation`, which `PropertyValue` renders as an `sr-only` tail
 * on the accessible name AND as tooltip content; the tooltip mock at the top of
 * this file inlines that content under `tooltip-content`, where production
 * portals it out of the row entirely. Neither is visible text sitting next to
 * the value, so leaving them in would compare a bare value on the list against
 * value-plus-reason on the detail and red on something that is not a divergence.
 * The reason is asserted directly, on the un-stripped row, in the test below —
 * so nothing is hidden by removing it here.
 */
function detailDurationText(): string {
  const row = detailDurationRow().cloneNode(true) as HTMLElement;
  for (const node of row.querySelectorAll(
    '.sr-only,[data-testid="tooltip-content"]'
  )) {
    node.remove();
  }
  const label = row.querySelector(".prd-prop-label");
  return (row.textContent ?? "").slice(label?.textContent?.length ?? 0).trim();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ISS-5575: list and detail report one Duration for one session", () => {
  it("renders the same Duration on both surfaces for a silent active run", () => {
    renderBothSurfaces(activeRecordSilentFor(SILENT_FOR_MS));

    // The list has folded the run — this is the population the bug was about.
    expect(listStatusText()).toContain(
      SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.STALE]
    );

    // The assertion that matters: the two surfaces agree WITH EACH OTHER.
    expect(detailDurationText()).toBe(listDurationText());
    // ...and they agree on the honest answer, not on a number. A run we have
    // stopped believing is running cannot also be timed against `now()`.
    expect(detailDurationText()).toBe(EM_DASH);

    // ISS-5575 (#review, visual-QA): the dash SAYS WHY, in the accessible name
    // rather than a mouse-only `title`. This row is the only surface a default
    // user sees this change on, and the status chip that would otherwise explain
    // it is not rendered with the prototype-parity flag off.
    expect(detailDurationRow().textContent).toContain(SESSION_STALE_TOOLTIP);
  });

  it("still renders the same measured Duration on both surfaces for a live run", () => {
    // The control: without it, turning every detail Duration into a dash would
    // satisfy the parity assertion above.
    renderBothSurfaces(activeRecordSilentFor(FRESH_FOR_MS));

    expect(listStatusText()).toContain(
      SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
    );
    expect(detailDurationText()).toBe(listDurationText());
    expect(detailDurationText()).not.toBe(EM_DASH);
    expect(detailDurationText()).not.toBe("");
  });

  /**
   * ISS-6455: the population the `projectsLiveWaiting` short-circuit re-opened
   * the split for. The detail exempted an awaiting-input run from the staleness
   * fold and kept timing it; the list never read `awaitingInputSince`, folded
   * the same row to Stale, and emptied its Duration cell.
   *
   * A run blocked on a human three days ago genuinely IS still awaiting input,
   * so the agreed answer is the MEASURED one — asserted as such, not only as
   * equality, because two dashes would satisfy equality while silently taking
   * the wrong side of the disagreement.
   */
  it("renders the same running Duration on both surfaces for a silent awaiting-input run", () => {
    renderBothSurfaces(awaitingInputRecordSilentFor(SILENT_FOR_MS));

    // The list badges the projection rather than folding it away — the same word
    // the detail's title chip already shows, and the one the desktop Status
    // facet gathers this row under.
    expect(listStatusText()).toContain(
      SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.WAITING]
    );

    expect(detailDurationText()).toBe(listDurationText());
    expect(detailDurationText()).not.toBe(EM_DASH);
    expect(detailDurationText()).not.toBe("");
  });
});
