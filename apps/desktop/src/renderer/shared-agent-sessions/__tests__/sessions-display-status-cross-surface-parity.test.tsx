import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SyncedSessionsTable } from "@repo/app/agents/components/sessions/synced-sessions-table";
import { createDateReviver } from "@repo/app/shared/api/revive-with-dates";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncedAgentSession } from "../../../main/agent-sync/agent-session-sync-contract.js";
import { mapListItem } from "../../../main/session/shared-agent-sessions-api.js";

/**
 * ISS-6714: ONE stored session, rendered on the Sessions table by BOTH
 * surfaces' producers, must badge and time identically.
 *
 * Desktop derives Sessions display status through a main-process producer
 * (`mapListItem`) that hands the renderer already-parsed `Date`s; the web
 * surface serves the same stored row as JSON and reconstructs those `Date`s
 * with the API client's own reviver. Two producers, one shared fold
 * (`agentSessionToSessionTableRow` -> `resolveDisplayedSessionStatusWithWaiting`).
 *
 * THE ASSERTION IS DESKTOP-VS-WEB, NEVER EITHER-VS-A-CONSTANT. ISS-6455 landed
 * two suites that each pin one side against a literal, and both stay green while
 * the two paths compute a different answer for every row outside their fixtures
 * — which is the whole defect family here (ISS-5575, ISS-5951, ISS-6041).
 * Comparing the two DERIVATION functions would miss it in the other direction:
 * that skips whether each surface actually routes its rows through the shared
 * fold, which is the part that broke.
 *
 * ISS-10364 (operator ruling, Cosimo Corrigan, 2026-09-23/24: "Don't
 * distinguish between active and stale", "let's drop waiting as well") retired
 * the Waiting and Stale words that used to tell the two rows below apart; both
 * are active rows and now read the same answer, so the suite pins agreement
 * plus a non-empty reading rather than a difference between them.
 */

const FIXED_NOW = new Date("2026-06-11T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
/** Long-silent: the shape the retired (ISS-10364) staleness fold used to badge. */
const SILENT_FOR_MS = 30 * HOUR_MS;
/** Longer than the silence, so the row's last activity never precedes its start. */
const RAN_FOR_MS = 33 * HOUR_MS;
const STARTED_AT = new Date(FIXED_NOW.getTime() - RAN_FOR_MS).toISOString();
const LAST_ACTIVITY_AT = new Date(
  FIXED_NOW.getTime() - SILENT_FOR_MS
).toISOString();
const AWAITING_SINCE = LAST_ACTIVITY_AT;
const MALFORMED_INSTANT = "13 o'clock";
const WAITING_ROW_NAME = "Blocked on a human";
const MALFORMED_ROW_NAME = "Corrupt awaiting instant";
/** The list path the web API client reviver is scoped to. */
const SESSIONS_REQUEST_PATH = "/agent-sessions";
const STATUS_COLUMN_ID = "status";
const DURATION_COLUMN_ID = "duration";
const VISIBLE_COLUMNS = new Set(["name", STATUS_COLUMN_ID, DURATION_COLUMN_ID]);

/** The persisted row, exactly as both producers read it out of storage. */
type StoredSession = {
  externalSessionId: string;
  name: string;
  status: string;
  startedAt: string;
  lastActivityAt: string;
  awaitingInputSince: string | null;
};

function storedSession(
  name: string,
  awaitingInputSince: string | null
): StoredSession {
  return {
    awaitingInputSince,
    externalSessionId: name,
    lastActivityAt: LAST_ACTIVITY_AT,
    name,
    startedAt: STARTED_AT,
    status: SESSION_STATUS.ACTIVE,
  };
}

/** DESKTOP: the main-process producer's row, `Date`s and all, straight over IPC. */
function desktopRow(stored: StoredSession): AgentSessionListItem {
  return mapListItem({
    agents: [],
    events: [],
    externalSessionId: stored.externalSessionId,
    name: stored.name,
    startedAt: stored.startedAt,
    status: stored.status,
    tokenUsageByModel: [],
    updatedAt: stored.lastActivityAt,
    lastActivityAt: stored.lastActivityAt,
    awaitingInputSince: stored.awaitingInputSince,
  } as unknown as SyncedAgentSession);
}

/**
 * WEB: the SAME stored row served as a cloud JSON list item and revived by the
 * API client's own reviver.
 *
 * The scaffolding fields are borrowed from the desktop row because the IPC and
 * cloud list item are literally the same type
 * (`SharedAgentSessionListItem = AgentSessionListItem`) — but the five fields
 * this ticket is about are put back to their RAW stored values first, so the
 * web side re-derives them from the wire instead of inheriting desktop's
 * answers. That is what keeps the comparison a comparison.
 */
function webRow(stored: StoredSession): AgentSessionListItem {
  const wire = {
    ...desktopRow(stored),
    awaitingInputSince: stored.awaitingInputSince,
    endedAt: null,
    lastActivityAt: stored.lastActivityAt,
    startedAt: stored.startedAt,
    status: stored.status,
  };
  return JSON.parse(
    JSON.stringify(wire),
    createDateReviver(SESSIONS_REQUEST_PATH)
  ) as AgentSessionListItem;
}

function renderBothSurfaces(stored: StoredSession) {
  return render(
    <>
      <div data-testid="desktop-surface">
        <SyncedSessionsTable
          getSessionHref={(item) => `/sessions/${item.id}`}
          items={[desktopRow(stored)]}
          visibleColumns={VISIBLE_COLUMNS}
        />
      </div>
      <div data-testid="web-surface">
        <SyncedSessionsTable
          getSessionHref={(item) => `/sessions/${item.id}`}
          items={[webRow(stored)]}
          visibleColumns={VISIBLE_COLUMNS}
        />
      </div>
    </>,
    { wrapper: AppCoreStoryProviders }
  );
}

/** The rendered text of one column's data cell on the named surface. */
function cellText(surfaceTestId: string, columnId: string): string {
  const surface = screen.getByTestId(surfaceTestId);
  // The DATA cell, not the column header — both carry `data-column-id`.
  const cell = surface.querySelector(
    `[role="cell"][data-column-id="${columnId}"]`
  );
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`No "${columnId}" data cell on ${surfaceTestId}`);
  }
  return cell.textContent?.trim() ?? "";
}

function surfaceReadings(surfaceTestId: string) {
  return {
    duration: cellText(surfaceTestId, DURATION_COLUMN_ID),
    status: cellText(surfaceTestId, STATUS_COLUMN_ID),
  };
}

describe("Sessions display status — desktop producer vs web payload (ISS-6714)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("agrees on a long-silent active row that is blocked on a human", () => {
    renderBothSurfaces(storedSession(WAITING_ROW_NAME, AWAITING_SINCE));

    const desktop = surfaceReadings("desktop-surface");

    expect(desktop).toEqual(surfaceReadings("web-surface"));
    // Not an equality-of-two-blanks pass: the row has to have rendered
    // something in both cells for the comparison above to mean anything.
    expect(desktop.status).not.toBe("");
    expect(desktop.duration).not.toBe("");
  });

  it("agrees when the two producers represent a corrupt awaiting-input instant differently", () => {
    // The divergence seam, named precisely: the two surfaces hand the fold the
    // same corruption in DIFFERENT SHAPES. Desktop's producer has already
    // answered it with `null` (`parseNullableSessionDate`); the cloud payload
    // still carries the raw unparseable string, which `createDateReviver`
    // leaves as a string. Both must land on the same answer.
    //
    // Coercing the instant on either side — the ISS-6455 epoch-0 floor is the
    // version of this the repo already shipped once — splits the two.
    renderBothSurfaces(storedSession(MALFORMED_ROW_NAME, MALFORMED_INSTANT));

    const desktop = surfaceReadings("desktop-surface");

    expect(desktop).toEqual(surfaceReadings("web-surface"));
    expect(desktop.status).not.toBe("");
    expect(desktop.duration).not.toBe("");
  });
});
