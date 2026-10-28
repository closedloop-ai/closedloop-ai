import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SESSIONS_HISTORY_LIST_TEST_ID } from "@repo/app/agents/components/sessions/sessions-list-surface-v2";
import type { BothHostRenderContract } from "@repo/app/shared/testing/both-host-render-contract";
import {
  DESKTOP_HOST,
  foundOrAbsent,
} from "@repo/app/shared/testing/both-host-render-contract";
import { screen } from "@testing-library/react";

/**
 * ISS-9544 — what `SessionsListSurfaceV2` owes its reader on BOTH shells.
 *
 * The second adoption of the both-host runner, and the one that shows what the
 * mechanism is for: this surface's divergence is not a bug, it is the entry the
 * capability ledger already carries — a local-mode session id is not an
 * artifact id, so the star could neither read nor persist. Stating it here
 * makes it EXPIRE on its own. The static ledger notices when the desktop host
 * starts passing `favorites`; this notices when the star reaches the reader.
 *
 * The fixture is `createAgentSessionListItemFixture`, which both shells' suites
 * already import, so the two halves cannot drift on what a session looks like.
 */

export type SessionsBothHostFixture = {
  readonly items: readonly AgentSessionListItem[];
  readonly statusFilter?: typeof SESSION_STATUS.ACTIVE;
  readonly total?: number;
};

/**
 * Recent, not the fixture's pinned June instants: the desktop shell windows the
 * list on its own shared date range, so a fixed date ages out and empties the
 * table — leaving every case below asserting over zero rows and reading as a
 * divergence that is really an expired fixture.
 */
const RECENT = new Date(Date.now() - 60 * 60 * 1000);

/**
 * Two rows, not one: a shell that renders a single hard-coded row satisfies a
 * one-row fixture.
 */
export const CONTRACT_SESSIONS: readonly AgentSessionListItem[] = [
  createAgentSessionListItemFixture({
    endedAt: RECENT,
    id: "ses-both-host-1",
    lastActivityAt: RECENT,
    name: "agent/both-host-one",
    startedAt: RECENT,
    updatedAt: RECENT,
  }),
  createAgentSessionListItemFixture({
    endedAt: RECENT,
    id: "ses-both-host-2",
    lastActivityAt: RECENT,
    name: "agent/both-host-two",
    startedAt: RECENT,
    updatedAt: RECENT,
  }),
];

/**
 * ONE session's star, by the accessible name that names THAT session. Written
 * out rather than imported from the favorites control: reading it off the code
 * under test is what keeps a spec green after the control stops announcing
 * itself.
 *
 * Item-specific rather than a shared `/favorites$/` suffix counted against the
 * fixture size, because a global tally is satisfied by a shell that drops the
 * control on one row and renders it twice on another, and by a toolbar-level
 * bulk control that names no row at all (davetho review).
 */
function favoriteControlName(item: AgentSessionListItem): string {
  return `Add ${item.name} to favorites`;
}

async function everySessionNamed({
  items,
}: SessionsBothHostFixture): Promise<string | undefined> {
  for (const item of items) {
    const named = await foundOrAbsent(() =>
      screen.findAllByText(item.name ?? "")
    );
    if (named === undefined) {
      return `no element names the session "${item.name}"`;
    }
  }
  return undefined;
}

/** Pins the shared production composition, not only matching host-owned rows. */
async function sharedChampionComposition({
  items,
}: SessionsBothHostFixture): Promise<string | undefined> {
  const list = await foundOrAbsent(() =>
    screen.findByTestId(SESSIONS_HISTORY_LIST_TEST_ID)
  );
  if (!list) {
    return "the shared SessionsListSurfaceV2 list region is absent";
  }
  if (!list.querySelector('[data-testid="sessions-live-update-status"]')) {
    return "the shared live-update region is absent from the list";
  }
  for (const item of items) {
    const row = list.querySelector(`[data-grid-row-id="${item.id}"]`);
    if (!row?.textContent?.includes(item.name ?? "")) {
      return `the shared grid row for ${item.id} is absent`;
    }
  }
  return undefined;
}

async function favoriteControls({
  items,
}: SessionsBothHostFixture): Promise<string | undefined> {
  for (const item of items) {
    const name = favoriteControlName(item);
    // `findByRole`, singular: a SECOND control carrying this row's name is an
    // ambiguous match, which `foundOrAbsent` re-throws rather than laundering
    // into the absence sentence a divergence entry would accept. So one row
    // losing its star and another gaining a duplicate reddens twice over.
    const star = await foundOrAbsent(() =>
      screen.findByRole("button", { name })
    );
    if (star === undefined) {
      return `no control named "${name}" is on screen`;
    }
    // The star must sit in the row it names. Checked only AFTER the control is
    // known to exist, so the shell that renders no star at all is reported as
    // the absence it is rather than as a missing row.
    if (star.closest(TABLE_ROW_SELECTOR) === null) {
      return `the control named "${name}" is not inside a table row`;
    }
  }
  return undefined;
}

async function filteredRowsAndCount({
  items,
  statusFilter,
  total,
}: SessionsBothHostFixture): Promise<string | undefined> {
  if (!(statusFilter && total)) {
    return "the filtered population fixture is incomplete";
  }
  const readout = await foundOrAbsent(() =>
    screen.findByText(`Showing 1-${items.length} of ${total} sessions`)
  );
  if (!readout) {
    return `the list does not state the filtered population ${total}`;
  }
  const chip = await foundOrAbsent(() =>
    screen.findByLabelText(
      `Remove Status: ${SESSION_STATUS_LABELS[statusFilter]} filter`
    )
  );
  if (!chip) {
    return "the selected status filter has no visible chip";
  }
  for (const item of items) {
    const row = await foundOrAbsent(() => screen.findByText(item.name ?? ""));
    if (!row) {
      return `the filtered row "${item.name}" is absent`;
    }
  }
  if (screen.queryByText(CONTRACT_SESSIONS[1]!.name ?? "")) {
    return "the host displayed a row excluded by the filtered read";
  }
  return undefined;
}

/** A grid body row, on both the v1 and v2 table shapes. */
const TABLE_ROW_SELECTOR = '[role="row"]';

/**
 * The same inability the desktop entry in
 * `apps/app/__tests__/sessions-list-v2-host-capability-parity.test.ts` records
 * against the `favorites` capability — stated here in this check's own words
 * rather than copied, because a copy claiming to be that ledger's sentence is a
 * second declaration of it that nothing keeps in step.
 */
const NOT_AN_ARTIFACT_ID =
  "Favourites are keyed on an artifact id written through /artifacts/favorites, and a local-mode session id is not one, so this shell has nothing for the star to read or persist against.";

export const SESSIONS_BOTH_HOST_CONTRACT: BothHostRenderContract<SessionsBothHostFixture> =
  {
    surface: "Sessions list surface v2",
    cases: [
      {
        renderProblem: sharedChampionComposition,
        fixture: { items: CONTRACT_SESSIONS },
        name: "mounts the shared SessionsListSurfaceV2 champion",
      },
      {
        renderProblem: everySessionNamed,
        fixture: { items: CONTRACT_SESSIONS },
        name: "names every session in the fixture",
      },
      {
        renderProblem: filteredRowsAndCount,
        fixture: {
          items: [CONTRACT_SESSIONS[0]!],
          statusFilter: SESSION_STATUS.ACTIVE,
          total: 31,
        },
        name: "shows the same filtered rows and source total",
      },
      {
        divergence: { [DESKTOP_HOST]: NOT_AN_ARTIFACT_ID },
        renderProblem: favoriteControls,
        fixture: { items: CONTRACT_SESSIONS },
        name: "offers a favorite control on the rows",
      },
    ],
  };
