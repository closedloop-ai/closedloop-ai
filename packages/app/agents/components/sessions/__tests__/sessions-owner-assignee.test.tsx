import type { BasicUser } from "@repo/api/src/types/user";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  buildSessionGroups,
  SESSION_GROUP_UNATTRIBUTED_OWNER,
  SessionGroupBy,
} from "../../../lib/session-grouping";
import { agentSessionToSessionTableRow } from "../../../lib/session-table-row";
import { SESSIONS_OWNER_COLUMN_ID } from "../../../lib/sessions-table-columns";
import { renderSessionCell } from "../session-cell-renderers";
import {
  createAgentSessionListItemFixture,
  SESSION_ASSIGNEE_FIXTURE,
  SESSION_CREATOR_FIXTURE,
  SESSION_UPLOADER_FIXTURE,
} from "../session-list-fixtures";
import {
  ownerId,
  ownerName,
  sessionsGroupCanonicalValue,
} from "../sessions-list-group-values";
import { collectOwners } from "../sessions-list-surface-rows";
import { UNASSIGNED_OWNER_ID } from "../sessions-list-view-state";

/**
 * ISS-12251 (PLN-2176 T-4.2): every Sessions grid reader the UI labels Owner
 * reads the assignee (operator ruling 2026-10-13, "The owner is the
 * assignee"). Rows are built through the production mapper from a wire item
 * whose assignee, recording user and creator are three different people, so a
 * reader still on `user` fails.
 *
 * AC-012: a producer that OMITS `assignee` (an older API)
 * renders as before, on `user`; a present `null` is unassigned.
 */

const ASSIGNEE_NAME = "Ada Lovelace";
const UPLOADER_NAME = "Sam Uploader";

function rowFrom(
  id: string,
  people: { assignee?: BasicUser | null; user: BasicUser | null }
) {
  return agentSessionToSessionTableRow(
    createAgentSessionListItemFixture({
      createdBy: SESSION_CREATOR_FIXTURE,
      id,
      ...people,
    }),
    null
  );
}

const assigned = rowFrom("assigned", {
  assignee: SESSION_ASSIGNEE_FIXTURE,
  user: SESSION_UPLOADER_FIXTURE,
});
const unassigned = rowFrom("unassigned", {
  assignee: null,
  user: SESSION_UPLOADER_FIXTURE,
});
const omitted = rowFrom("omitted", { user: SESSION_UPLOADER_FIXTURE });

describe("Sessions grid Owner reads the assignee (ISS-12251 T-4.2)", () => {
  it("draws the assignee in the Owner cell, not the recording user", () => {
    render(renderSessionCell(SESSIONS_OWNER_COLUMN_ID, assigned));
    expect(screen.getByText(ASSIGNEE_NAME, { exact: true })).toBeVisible();
    expect(screen.queryByText(UPLOADER_NAME, { exact: true })).toBeNull();
  });

  it("draws the recording user when the producer omits assignee (AC-012)", () => {
    render(renderSessionCell(SESSIONS_OWNER_COLUMN_ID, omitted));
    expect(screen.getByText(UPLOADER_NAME, { exact: true })).toBeVisible();
  });

  it("draws the empty cell for an unassigned session, not the recording user", () => {
    const { container } = render(
      renderSessionCell(SESSIONS_OWNER_COLUMN_ID, unassigned)
    );
    expect(screen.queryByText(UPLOADER_NAME, { exact: true })).toBeNull();
    expect(
      container.querySelector('[data-slot="grid-empty-value"]')
    ).not.toBeNull();
  });

  it("names and keys the Owner facet and sort by the assignee", () => {
    expect(ownerName(assigned)).toBe(ASSIGNEE_NAME);
    expect(ownerId(assigned)).toBe(SESSION_ASSIGNEE_FIXTURE.id);
    expect(ownerName(omitted)).toBe(UPLOADER_NAME);
    expect(ownerId(omitted)).toBe(SESSION_UPLOADER_FIXTURE.id);
    expect(ownerName(unassigned)).toBe(UNASSIGNED_ASSIGNEE_LABEL);
    expect(ownerId(unassigned)).toBe(UNASSIGNED_OWNER_ID);
    expect(collectOwners([assigned, unassigned, omitted])).toEqual([
      { id: SESSION_ASSIGNEE_FIXTURE.id, label: ASSIGNEE_NAME },
      { id: SESSION_UPLOADER_FIXTURE.id, label: UPLOADER_NAME },
      { id: UNASSIGNED_OWNER_ID, label: UNASSIGNED_ASSIGNEE_LABEL },
    ]);
  });

  it("bands the Owner grouping by the assignee", () => {
    const groups = buildSessionGroups(
      [assigned, unassigned, omitted],
      SessionGroupBy.Owner
    );
    expect(
      groups?.map((group) => [
        group.key,
        group.label,
        group.items.map((item) => item.id),
      ])
    ).toEqual([
      [SESSION_ASSIGNEE_FIXTURE.id, ASSIGNEE_NAME, ["assigned"]],
      [
        SESSION_GROUP_UNATTRIBUTED_OWNER,
        SESSION_GROUP_UNATTRIBUTED_OWNER,
        ["unassigned"],
      ],
      [SESSION_UPLOADER_FIXTURE.id, UPLOADER_NAME, ["omitted"]],
    ]);
  });

  it("emits the assignee id as the Owner band's group-drop value", () => {
    expect(
      sessionsGroupCanonicalValue(SESSIONS_OWNER_COLUMN_ID, assigned)
    ).toBe(SESSION_ASSIGNEE_FIXTURE.id);
    expect(
      sessionsGroupCanonicalValue(SESSIONS_OWNER_COLUMN_ID, unassigned)
    ).toBe(UNASSIGNED_OWNER_ID);
    expect(sessionsGroupCanonicalValue(SESSIONS_OWNER_COLUMN_ID, omitted)).toBe(
      SESSION_UPLOADER_FIXTURE.id
    );
  });
});
