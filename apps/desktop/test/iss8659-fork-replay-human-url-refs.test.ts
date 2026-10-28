/**
 * @file iss8659-fork-replay-human-url-refs.test.ts
 * @description ISS-8659 — a `/fork` child must not claim the PR links its
 * parent's human pasted.
 *
 * `addHumanUrlRefs` scrapes GitHub PR URLs out of `role === "human"` message
 * text. That is the SECOND producer of the fact ISS-8659 already gated on the
 * pr-link record: one gated and one not is how a fork kept claiming every PR its
 * parent had ever linked, through the surface nobody was looking at.
 *
 * Drives the production entry point rather than the private helper, so deleting
 * the gate — or the call — fails this.
 */

import assert from "node:assert/strict";
import { ArtifactRefMethod } from "@repo/api/src/types/session-artifact-link";
import { test } from "vitest";
import type { ArtifactRefRecord } from "../src/main/collectors/parsing/artifact-ref-record.js";
import { attachMonitoredSessionActivity } from "../src/main/collectors/parsing/monitored-session-activity.js";
import { makeSession } from "./normalized-session-test-utils.js";

const EXTRACTOR_VERSION = 1;
const TS = "2026-01-01T00:01:00.000Z";

test("ISS-8659: a replayed human message does not contribute a PR url ref", () => {
  const refs: ArtifactRefRecord[] = [];
  attachMonitoredSessionActivity(
    makeSession({
      messages: [
        {
          role: "human",
          text: "look at https://github.com/closedloop-ai/closedloop-ai/pull/1111",
          timestamp: TS,
          isForkReplayed: true,
        },
        {
          role: "human",
          text: "and mine is https://github.com/closedloop-ai/closedloop-ai/pull/2222",
          timestamp: TS,
        },
      ],
    }),
    { toolUses: [], refs },
    EXTRACTOR_VERSION
  );

  const urlRefs = refs.filter(
    (ref) => ref.method === ArtifactRefMethod.UrlInMessage
  );
  assert.deepEqual(
    urlRefs.map((ref) => ref.prNumber),
    [2222],
    "only the fork's own pasted PR is its reference; the parent's is the parent's"
  );
});
