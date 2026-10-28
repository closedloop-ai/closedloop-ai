import assert from "node:assert/strict";
import { DEFAULT_HUMAN_ACTOR_COLOR_TOKEN } from "@repo/api/src/agent-session-user-color";
import { encodeBranchId } from "@repo/api/src/types/branch.js";
import { describe, test } from "vitest";
import { getSharedBranchTrace } from "../src/main/branch/shared-branch-trace.js";
import { getSharedAgentSessionDetail } from "../src/main/session/shared-agent-session-detail-read.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";
import {
  link,
  makeSource,
  syncedSession,
} from "./shared-branches-test-helpers.js";

/**
 * ISS-8772 — the desktop's trace producers used to hand the local human actor a
 * hard-coded slate hex of their own, so the SAME unresolved owner read one
 * colour on the desktop trace and another on the cloud-served one. The
 * projection now emits the single shared token, which is also what proves no raw
 * literal survived: a hex fails both assertions below.
 */
const CSS_VARIABLE_COLOR_PATTERN = /^var\(--[a-z-]+\)$/;
const SESSION_ID = "session-actor-color";

const metadataWithPrompt = {
  kind: "fixture",
  messages: [
    {
      role: "human",
      timestamp: "2026-01-01T00:00:00.000Z",
      text: "Steer the local session.",
    },
  ],
};

describe("desktop-local trace actor colour", () => {
  test("the single-session detail projection emits the shared neutral token", async () => {
    const source = createFakeSource({
      cursorRows: [cursor(SESSION_ID)],
      sessions: {
        [SESSION_ID]: session({
          id: SESSION_ID,
          metadata: metadataWithPrompt,
        }),
      },
    });

    const detail = await getSharedAgentSessionDetail(source, SESSION_ID);
    const promptTurn = detail?.turnItems?.find(
      (item) => item.type === "prompt"
    );

    assert.equal(promptTurn?.type, "prompt");
    if (promptTurn?.type === "prompt") {
      assert.equal(promptTurn.actor.color, DEFAULT_HUMAN_ACTOR_COLOR_TOKEN);
      assert.match(promptTurn.actor.color, CSS_VARIABLE_COLOR_PATTERN);
    }
  });

  // The sibling producer in shared-branch-trace.ts sets the same human-actor
  // colour, but the merged-trace wire deliberately carries only `actorName` —
  // the Branch trace's own actor domain colours those turns. Pinning that here
  // is what makes the producer-side value provably inert, and it fails if a
  // later change plumbs a producer colour onto the wire, which would hand the
  // Branch trace a second actor-colour source.
  test("the branch merged-trace wire carries no actor colour at all", async () => {
    const branchId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "feature/x",
    });
    const source = makeSource({
      links: [link({ session_id: SESSION_ID })],
      sessions: [
        syncedSession({
          externalSessionId: SESSION_ID,
          startedAt: "2026-01-01T00:00:00.000Z",
          metadata: metadataWithPrompt,
        }),
      ],
    });

    const result = await getSharedBranchTrace(source, branchId);
    const promptItem = result.items.find((item) => item.type === "prompt");

    assert.equal(promptItem?.type, "prompt");
    for (const item of result.items) {
      assert.ok(
        !Object.hasOwn(item as Record<string, unknown>, "color"),
        `merged-trace ${item.type} item must not carry a colour`
      );
    }
  });
});
