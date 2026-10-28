import { describe, expect, it } from "vitest";
import { createAgentSessionListItemFixture } from "../../components/sessions/session-list-fixtures";
import { agentSessionToSessionTableRow } from "../session-table-row";

const RECORDER = {
  id: "user-recorder",
  email: "recorder@example.test",
  firstName: "Bo",
  lastName: "Recorder",
  avatarUrl: null,
};
const ASSIGNEE = {
  id: "user-assignee",
  email: "assignee@example.test",
  firstName: "Ada",
  lastName: "Assignee",
  avatarUrl: "https://example.test/ada.png",
};

/** ISS-12251 (PLN-2176 T-4.1): the row's Owner is the session's assignee. */
describe("agentSessionToSessionTableRow owner", () => {
  it("maps owner from the assignee and keeps user as the recording user", () => {
    const row = agentSessionToSessionTableRow(
      createAgentSessionListItemFixture({ user: RECORDER, assignee: ASSIGNEE }),
      null
    );

    expect(row.owner).toEqual({
      id: ASSIGNEE.id,
      name: "Ada Assignee",
      avatarUrl: ASSIGNEE.avatarUrl,
    });
    expect(row.user).toEqual({
      id: RECORDER.id,
      name: "Bo Recorder",
      avatarUrl: null,
    });
  });

  it("is null for an unassigned session and absent for a producer that omits assignee", () => {
    const unassigned = agentSessionToSessionTableRow(
      createAgentSessionListItemFixture({ user: RECORDER, assignee: null }),
      null
    );
    const omitted = agentSessionToSessionTableRow(
      createAgentSessionListItemFixture({ user: RECORDER }),
      null
    );

    expect(unassigned.owner).toBeNull();
    // ISS-12251 T-4.5: the rename gate falls back to `user` only for an
    // omitted `assignee`, so the row keeps the two apart.
    expect(omitted).not.toHaveProperty("owner");
    expect(omitted.user?.id).toBe(RECORDER.id);
  });
});
