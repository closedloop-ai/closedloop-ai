/**
 * ISS-12251 (PLN-2176 T-5.1, D-7): Desktop's local list item serves the local
 * creator as `assignee` and `createdBy`, beside `user`, all resolved from the
 * session's one `user_id`. An id the org directory cannot resolve omits both
 * keys: an explicit `null` assignee is an unassigned session to the shared Owner
 * resolver, which a not-yet-loaded directory is not.
 */
import assert from "node:assert/strict";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { BasicUser } from "@repo/api/src/types/user";
import { describe, it } from "vitest";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { mapListItem } from "../src/main/session/shared-agent-sessions-api.js";

const STARTED_AT = "2026-10-12T09:00:00.000Z";
const CREATOR: BasicUser = {
  id: "user-local-creator",
  email: "creator@example.test",
  firstName: "Local",
  lastName: "Creator",
  avatarUrl: null,
};
const DIRECTORY = new Map([[CREATOR.id, CREATOR]]);

function session(overrides: Partial<SyncedAgentSession>): SyncedAgentSession {
  return {
    agents: [],
    events: [],
    externalSessionId: "ses-local-people",
    startedAt: STARTED_AT,
    status: SESSION_STATUS.ACTIVE,
    tokenUsageByModel: [],
    updatedAt: STARTED_AT,
    ...overrides,
  } as SyncedAgentSession;
}

function mapWithDirectory(overrides: Partial<SyncedAgentSession>) {
  return mapListItem(session(overrides), undefined, undefined, DIRECTORY);
}

describe("Desktop local list item people (ISS-12251 T-5.1)", () => {
  it("serves the resolved local creator as assignee, createdBy and user", () => {
    const item = mapWithDirectory({ userId: CREATOR.id });

    assert.deepEqual(item.assignee, CREATOR);
    assert.deepEqual(item.createdBy, CREATOR);
    assert.deepEqual(item.user, CREATOR);
    assert.notEqual(item.userColor, null);
  });

  it("omits assignee and createdBy when the directory cannot resolve the user", () => {
    const item = mapWithDirectory({ userId: "user-not-in-directory" });

    assert.equal(Object.hasOwn(item, "assignee"), false);
    assert.equal(Object.hasOwn(item, "createdBy"), false);
    assert.equal(item.user, null);
    assert.equal(item.userColor, null);
  });
});
