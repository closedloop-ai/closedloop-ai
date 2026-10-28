import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { projectLocalSessionList } from "../src/main/session/local-session-list-projection.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";

describe("local Session list compute-target identity", () => {
  it("uses the identity-scoped cloud compute target", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a")],
      sessions: { "session-a": session({ id: "session-a" }) },
    });

    const response = await projectLocalSessionList(
      source,
      {
        computeTargetId: "target-a",
        request: { quality: "all" },
        users: [],
      },
      async (ids, cache, options) =>
        source.loadSyncedSessions(ids, cache, options)
    );

    assert.equal(response.items[0]?.computeTarget.id, "target-a");
  });

  it("retains the local-only identity without a cloud target", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a")],
      sessions: { "session-a": session({ id: "session-a" }) },
    });

    const response = await projectLocalSessionList(
      source,
      {
        computeTargetId: null,
        request: { quality: "all" },
        users: [],
      },
      async (ids, cache, options) =>
        source.loadSyncedSessions(ids, cache, options)
    );

    assert.equal(response.items[0]?.computeTarget.id, "local-desktop");
  });
});
