import assert from "node:assert/strict";
import {
  ListQueryExecution,
  type ListQueryObservation,
} from "@repo/api/src/types/list-query-observability";
import { test } from "vitest";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  createFakeSource,
  cursor,
} from "./shared-agent-sessions-test-helpers.js";

test("unsupported capability omits unknown populations while an empty scope reports zero", async () => {
  const source = createFakeSource({
    cursorRows: [cursor("stale"), cursor("session-a")],
    loadOrder: ["session-a"],
  });
  const unsupportedObservations: ListQueryObservation[] = [];
  const unsupported = await getSharedAgentSessions(
    source,
    { teamId: "cloud-team", userId: "user-alex" },
    {
      onQueryObservation: (observation) =>
        unsupportedObservations.push(observation),
    }
  );

  assert.deepEqual(unsupported, {
    items: [],
    total: 0,
    viewerScope: "self",
  });
  assert.deepEqual(unsupportedObservations, [
    { execution: ListQueryExecution.Unsupported },
  ]);

  const emptyObservations: ListQueryObservation[] = [];
  const logicallyEmpty = await getSharedAgentSessions(
    source,
    { userId: "user-alex", userIds: ["user-blair"] },
    {
      onQueryObservation: (observation) => emptyObservations.push(observation),
    }
  );

  assert.deepEqual(logicallyEmpty, {
    items: [],
    total: 0,
    viewerScope: "self",
  });
  assert.deepEqual(emptyObservations, [
    { execution: ListQueryExecution.Unsupported },
    { matchedCount: 0 },
  ]);
  assert.equal(source.calls.length, 0);
});
