import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { createSessionTableRowFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import type { SessionTableRow } from "@repo/app/agents/components/sessions/sessions-table";
import {
  buildSessionGroups,
  coerceSessionGroupBy,
  hideSessionGroupedColumn,
  SESSION_GROUP_COLUMN_ID,
  SESSION_GROUP_UNATTRIBUTED_OWNER,
  SESSION_GROUP_UNSPECIFIED,
  SessionGroupBy,
} from "@repo/app/agents/lib/session-grouping";
import { describe, expect, it } from "vitest";

function row(overrides: Partial<SessionTableRow>): SessionTableRow {
  // ISS-5697: the shared neutral row. Grouping keys off `user`/`status`/
  // `harness`, and the shared default leaves `user` undefined, which is what
  // these cases mean by "unattributed".
  return createSessionTableRowFixture({
    costLabel: "$1.00",
    durationLabel: "1m",
    lastActivityLabel: "1m ago",
    name: "a session",
    startedLabel: "1m ago",
    ...overrides,
  });
}

describe("buildSessionGroups (ISS-5315)", () => {
  it("returns undefined for the None dimension so the table renders a flat list", () => {
    expect(
      buildSessionGroups([row({ id: "a" })], SessionGroupBy.None)
    ).toBeUndefined();
  });

  it("bands by status, preserving the incoming row order within and between bands", () => {
    const groups = buildSessionGroups(
      [
        row({ id: "a", status: "active" }),
        row({ id: "b", status: "inactive" }),
        row({ id: "c", status: "active" }),
      ],
      SessionGroupBy.Status
    );

    // The DISPLAY vocabulary, not the raw wire value: the band header sits
    // directly above a Status pill stating the same fact, so "active" over
    // "Active" was one row saying one thing two ways (#4480).
    expect(groups?.map((group) => group.label)).toEqual(["Active", "Inactive"]);
    expect(groups?.[0].items.map((item) => item.id)).toEqual(["a", "c"]);
    expect(groups?.[1].items.map((item) => item.id)).toEqual(["b"]);
  });

  it("bands by owner, folding a missing owner into one honest label", () => {
    const groups = buildSessionGroups(
      [
        row({ id: "a", user: { name: "Parker Byrd" } }),
        row({ id: "b", user: null }),
        row({ id: "c", user: { name: "   " } }),
      ],
      SessionGroupBy.Owner
    );

    expect(groups?.map((group) => group.label)).toEqual([
      "Parker Byrd",
      SESSION_GROUP_UNATTRIBUTED_OWNER,
    ]);
    // A blank-string owner is the same fact as no owner, so it must not open a
    // second, invisible band beside the "Unattributed" one.
    expect(groups?.[1].items.map((item) => item.id)).toEqual(["b", "c"]);
  });

  it("bands by harness, labelling a blank harness rather than rendering an unnamed band", () => {
    const groups = buildSessionGroups(
      [row({ harness: "" })],
      SessionGroupBy.Harness
    );
    expect(groups?.[0].label).toBe(SESSION_GROUP_UNSPECIFIED);
  });

  // ISS-5366: `normalizeSessionStatus` fail-opens the DISPLAY-ONLY members to
  // `active` for its other consumers, so banding through it filed a row whose
  // pill reads "Stale" under the "Active" header — the band contradicting the
  // cell inside it, and the Active band absorbing rows nobody claimed were
  // running. Dark while the gate was off; the default for everyone once it
  // retires.
  it("bands a display-only status under its own header, not Active", () => {
    const groups = buildSessionGroups(
      [
        row({ id: "a", status: SESSION_STATUS.ACTIVE }),
        row({ id: "b", status: DISPLAYED_SESSION_STATUS.STALE }),
        row({ id: "c", status: DISPLAYED_SESSION_STATUS.UNKNOWN }),
      ],
      SessionGroupBy.Status
    );

    expect(groups?.map((group) => group.label)).toEqual([
      SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE],
      SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.STALE],
      SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.UNKNOWN],
    ]);
    // The band a reader would click to gather "the rest of them" holds exactly
    // the row whose pill says so, and the Active band holds only the live one.
    expect(groups?.[0].items.map((item) => item.id)).toEqual(["a"]);
    expect(groups?.[1].items.map((item) => item.id)).toEqual(["b"]);
    expect(groups?.[2].items.map((item) => item.id)).toEqual(["c"]);
  });

  // The band label is the VALUE alone. The list is server-paginated, so a count
  // here would read as "how many sessions are Active" while only ever meaning
  // "how many on this page" — the exact metric-vs-population lie the label is
  // written to avoid.
  it("never puts a count in a band label", () => {
    const groups = buildSessionGroups(
      [row({ id: "a" }), row({ id: "b" })],
      SessionGroupBy.Status
    );
    expect(groups?.[0].items).toHaveLength(2);
    expect(groups?.[0].label).toBe(
      SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]
    );
  });

  // #4480: `error` is labelled "Failed" everywhere else on the row — the pill
  // and the active-filter chip both say it — so a band header saying "error"
  // re-opened the raw-wire-string leak ISS-4696 closed.
  it("bands a failed session under the label its pill and chip use", () => {
    const groups = buildSessionGroups(
      [row({ id: "a", status: SESSION_STATUS.ERROR })],
      SessionGroupBy.Status
    );
    expect(groups?.[0].label).toBe(SESSION_STATUS_LABELS[SESSION_STATUS.ERROR]);
  });

  // `completed`, `abandoned` and `inactive` are ONE state to the pill and to the
  // server's facet predicate (a selected Inactive expands to match all three).
  // Banding them apart put up to three bands under a chip naming one status.
  it("bands the Inactive rows that read as one state together", () => {
    // ISS-5592: this used to also cover the retired `completed`/`abandoned`
    // spellings folding into the same band. They are unrecognized now and no
    // longer belong here — they band as "Active", not Unknown, because grouping
    // routes through `normalizeDisplayedSessionStatus` (which fail-opens to
    // ACTIVE), not `foldSessionStatus` (which answers UNKNOWN).
    const groups = buildSessionGroups(
      [
        row({ id: "a", status: SESSION_STATUS.INACTIVE }),
        row({ id: "c", status: SESSION_STATUS.INACTIVE }),
      ],
      SessionGroupBy.Status
    );

    expect(groups).toHaveLength(1);
    expect(groups?.[0].label).toBe(
      SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE]
    );
    expect(groups?.[0].items.map((item) => item.id)).toEqual(["a", "c"]);
  });

  // #4480: `HarnessBadge` lowercases into its config, so two rows differing only
  // in case rendered one badge while banding apart.
  it("bands harnesses that render as one badge into one band", () => {
    const groups = buildSessionGroups(
      [
        row({ id: "a", harness: "claude" }),
        row({ id: "b", harness: "Claude" }),
      ],
      SessionGroupBy.Harness
    );

    expect(groups).toHaveLength(1);
    expect(groups?.[0].label).toBe("Claude");
    expect(groups?.[0].items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  // wongk (#4480): a display name is not an identity.
  it("keeps two different owners who share a display name in two bands", () => {
    const groups = buildSessionGroups(
      [
        row({ id: "a", user: { id: "usr-1", name: "Alex" } }),
        row({ id: "b", user: { id: "usr-2", name: "Alex" } }),
        row({ id: "c", user: { id: "usr-1", name: "Alex" } }),
      ],
      SessionGroupBy.Owner
    );

    expect(groups).toHaveLength(2);
    expect(groups?.map((group) => group.label)).toEqual(["Alex", "Alex"]);
    expect(groups?.[0].items.map((item) => item.id)).toEqual(["a", "c"]);
    expect(groups?.[1].items.map((item) => item.id)).toEqual(["b"]);
  });

  it("maps each dimension to the column the table hides while banding on it", () => {
    expect(SESSION_GROUP_COLUMN_ID[SessionGroupBy.None]).toBeUndefined();
    expect(SESSION_GROUP_COLUMN_ID[SessionGroupBy.Status]).toBe("status");
    expect(SESSION_GROUP_COLUMN_ID[SessionGroupBy.Harness]).toBe("harness");
    expect(SESSION_GROUP_COLUMN_ID[SessionGroupBy.Owner]).toBe("owner");
  });

  // #4480: the ONE derivation both shells reach through the shared table. The
  // deletion used to live only in the web page, so desktop banded the rows and
  // then printed the same value down every row.
  it("removes the banded column from the visible set, and only that column", () => {
    const visible = new Set(["status", "harness", "owner", "repo"]);

    expect([
      ...(hideSessionGroupedColumn(visible, SessionGroupBy.Status) ?? []),
    ]).toEqual(["harness", "owner", "repo"]);
    expect([
      ...(hideSessionGroupedColumn(visible, SessionGroupBy.Owner) ?? []),
    ]).toEqual(["status", "harness", "repo"]);
  });

  it("returns the caller's own set untouched when nothing is banded", () => {
    const visible = new Set(["status"]);

    // The same INSTANCE, so an unconditional call in a render path does not
    // mint a new identity on every commit.
    expect(hideSessionGroupedColumn(visible, SessionGroupBy.None)).toBe(
      visible
    );
    // A banded column that is already hidden is not a change either.
    expect(hideSessionGroupedColumn(visible, SessionGroupBy.Harness)).toBe(
      visible
    );
    expect(
      hideSessionGroupedColumn(undefined, SessionGroupBy.Status)
    ).toBeUndefined();
  });

  it("coerces an unknown persisted dimension to None", () => {
    expect(coerceSessionGroupBy("repository")).toBe(SessionGroupBy.None);
    expect(coerceSessionGroupBy(undefined)).toBe(SessionGroupBy.None);
    expect(coerceSessionGroupBy(SessionGroupBy.Owner)).toBe(
      SessionGroupBy.Owner
    );
  });
});
