import assert from "node:assert/strict";
import { AgentSessionListCapability } from "@repo/api/src/types/agent-session-list-contract";
import { describe, test } from "vitest";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import { sessionListPageEcho } from "../src/main/session/shared-agent-sessions-page-echo.js";
import { emptySharedAgentSessionsListResponse } from "../src/shared/shared-agent-sessions-contract.js";
import {
  createFakeSource,
  cursor,
  defaultSessions,
} from "./shared-agent-sessions-test-helpers.js";

/**
 * ISS-9555 slice 2, the desktop LOCAL producer's half.
 *
 * Desktop CLOUD mode is not exercised here on purpose: it and the web app share
 * one data source against one `apps/api` route, so the echo that route mints is
 * the one desktop-cloud receives, and a second desktop assertion would be a test
 * of the same producer wearing a different name.
 */

describe("desktop local sessions page echo (ISS-9555)", () => {
  test("states the position the read was answered at", () => {
    assert.deepEqual(sessionListPageEcho({ limit: 10, offset: 120 }), {
      capability: AgentSessionListCapability.ServerPaginationV1,
      limit: 10,
      offset: 120,
    });
  });

  test("the hydrated list read echoes the page it served", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("session-a"),
        cursor("session-b"),
        cursor("session-c"),
      ],
      sessions: defaultSessions(),
    });

    const response = await getSharedAgentSessions(source, {
      quality: "all",
      limit: 2,
      offset: 0,
    });

    assert.deepEqual(response.pageInfo, {
      capability: AgentSessionListCapability.ServerPaginationV1,
      limit: 2,
      offset: 0,
    });
  });

  test("a hydrated read past the last page answers empty AT the offset asked for", async () => {
    const source = createFakeSource({
      cursorRows: [
        cursor("session-a"),
        cursor("session-b"),
        cursor("session-c"),
      ],
      sessions: defaultSessions(),
    });

    const response = await getSharedAgentSessions(source, {
      quality: "all",
      limit: 2,
      offset: 40,
    });

    // The overshoot is REPORTED, not relocated: the local producer answers the
    // page that was asked for, exactly as the cloud route does, and the echo
    // names that same position so a consumer can place the empty answer.
    assert.equal(response.total, 3);
    assert.equal(response.items.length, 0);
    assert.equal(response.pageInfo?.offset, 40);
  });

  test("the count-only read echoes too, because it IS a read", async () => {
    const source = createFakeSource({
      cursorRows: [cursor("session-a")],
      sessions: defaultSessions(),
      countSessions: () => 25,
    });

    const response = await getSharedAgentSessions(source, {
      countOnly: true,
      quality: "all",
      limit: 10,
      offset: 120,
    });

    assert.equal(response.total, 25);
    assert.deepEqual(response.pageInfo, {
      capability: AgentSessionListCapability.ServerPaginationV1,
      limit: 10,
      offset: 120,
    });
  });

  test("the empty response carries no echo, because no read happened", () => {
    // ISS-4773's `meteredEstimatedCost` note is the precedent: what the empty
    // shape OMITS is itself a wire signal. A consumer must be able to tell
    // "nothing was read" from "a legacy producer read something", and an echo
    // minted here would collapse the two.
    assert.equal(
      Object.hasOwn(emptySharedAgentSessionsListResponse(), "pageInfo"),
      false
    );
  });
});
