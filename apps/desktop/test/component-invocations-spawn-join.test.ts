/**
 * @file component-invocations-spawn-join.test.ts
 * @description ISS-4592: the tier-0 exact spawn join in `matchSpawnedSubagent`.
 *
 * Before ISS-4592 Claude parser subagents carried no `type`, so the fuzzy
 * "same type" tier never fired for them and mispairing was impossible in
 * practice. Populating `type` activates that tier — and with N same-type
 * siblings (16 in golden dossier f216298d) it pairs by ARRAY ORDER, which is
 * not identity. The parser now records the delegating tool_use id on the
 * subagent, so the exact join runs first.
 *
 * Pairing is observed through `externalInvocationId`, which is
 * `subagent:<parser subagent id>` when a parser record was matched.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-07-31T17:00:00.000Z";
const MAIN_AGENT = "main-agent";
const FIRST_TOOL_USE = "toolu_first";
const SECOND_TOOL_USE = "toolu_second";

function delegationToolUse(id: string, timestamp: string) {
  return {
    id,
    providerToolUseId: id,
    name: "Agent",
    timestamp,
    input: { subagent_type: "code-reviewer", prompt: `kickoff for ${id}` },
  };
}

/**
 * Two same-type subagents listed in the OPPOSITE order from their delegating
 * tool uses, so an order-based match provably pairs them wrongly.
 */
function crossedSession(options: { withSpawnMetadata: boolean }) {
  const metadataFor = (toolUseId: string) =>
    options.withSpawnMetadata
      ? { metadata: { spawnedByToolUseId: toolUseId } }
      : {};
  return makeSession({
    sessionId: "spawn-join-session",
    startedAt: NOW,
    toolUses: [
      delegationToolUse(FIRST_TOOL_USE, "2026-07-31T17:00:01.000Z"),
      delegationToolUse(SECOND_TOOL_USE, "2026-07-31T17:00:02.000Z"),
    ],
    subagents: [
      {
        id: "agent-second",
        name: "Claude subagent second",
        nativeSubagentId: "agent-second",
        type: "code-reviewer",
        startedAt: NOW,
        ...metadataFor(SECOND_TOOL_USE),
      },
      {
        id: "agent-first",
        name: "Claude subagent first",
        nativeSubagentId: "agent-first",
        type: "code-reviewer",
        startedAt: NOW,
        ...metadataFor(FIRST_TOOL_USE),
      },
    ],
  });
}

function subagentPairs(
  session: ReturnType<typeof makeSession>
): Array<{ providerToolUseId: string | null; externalInvocationId: string }> {
  return deriveAgentComponentInvocationCandidates(session, MAIN_AGENT, NOW)
    .filter(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Subagent
    )
    .map((candidate) => ({
      providerToolUseId: candidate.providerToolUseId,
      externalInvocationId: candidate.externalInvocationId,
    }));
}

describe("matchSpawnedSubagent exact spawn join (ISS-4592)", () => {
  test("pairs each delegation with the subagent it actually spawned", () => {
    assert.deepEqual(
      subagentPairs(crossedSession({ withSpawnMetadata: true })),
      [
        {
          providerToolUseId: FIRST_TOOL_USE,
          externalInvocationId: "subagent:agent-first",
        },
        {
          providerToolUseId: SECOND_TOOL_USE,
          externalInvocationId: "subagent:agent-second",
        },
      ]
    );
  });

  test("without the spawn id, order decides — which is the ambiguity being fixed", () => {
    // Pins WHY tier-0 exists: identical input, no spawn metadata, and the
    // fuzzy tier pairs the first delegation with the first-listed subagent —
    // the wrong one. If this ever starts matching correctly on its own, the
    // fuzzy tiers changed and tier-0's rationale needs revisiting.
    assert.deepEqual(
      subagentPairs(crossedSession({ withSpawnMetadata: false })),
      [
        {
          providerToolUseId: FIRST_TOOL_USE,
          externalInvocationId: "subagent:agent-second",
        },
        {
          providerToolUseId: SECOND_TOOL_USE,
          externalInvocationId: "subagent:agent-first",
        },
      ]
    );
  });

  test("subagent ids that sanitize to the same agent-id segment keep their own exact claims", () => {
    // ISS-5099 review: the minted `-parser-sub-*` agent id round-trips through
    // `sanitizeSubagentIdSegment`, so "agent child" and "agent+child" both
    // collapse to "agent_child". A pairing map keyed by the minted id was
    // last-write-wins across that collision; the pre-pass must key by the raw
    // subagent id so each delegation resolves to its OWN claimant.
    const session = makeSession({
      sessionId: "spawn-join-collision",
      startedAt: NOW,
      toolUses: [
        delegationToolUse(FIRST_TOOL_USE, "2026-07-31T17:00:01.000Z"),
        delegationToolUse(SECOND_TOOL_USE, "2026-07-31T17:00:02.000Z"),
      ],
      subagents: [
        {
          id: "agent child",
          name: "Claude subagent first",
          nativeSubagentId: "agent child",
          type: "code-reviewer",
          startedAt: NOW,
          metadata: { spawnedByToolUseId: FIRST_TOOL_USE },
        },
        {
          id: "agent+child",
          name: "Claude subagent second",
          nativeSubagentId: "agent+child",
          type: "code-reviewer",
          startedAt: NOW,
          metadata: { spawnedByToolUseId: SECOND_TOOL_USE },
        },
      ],
    });

    assert.deepEqual(subagentPairs(session), [
      {
        providerToolUseId: FIRST_TOOL_USE,
        externalInvocationId: "subagent:agent child",
      },
      {
        providerToolUseId: SECOND_TOOL_USE,
        externalInvocationId: "subagent:agent+child",
      },
    ]);
  });

  test("a claim against providerToolUseId pairs exactly even when it differs from the transcript id", () => {
    // ISS-5099 review: the pre-pass must key the exact claim on
    // `providerToolUseId ?? toolUse.id` — the same key as the tier-0 check and
    // the emitted row's `provider_tool_use_id` — not on `toolUse.id` alone.
    // No parser populates `providerToolUseId` today, so before this key was
    // unified the two only agreed by accident; this pins the invariant for the
    // first harness that does populate it.
    const session = makeSession({
      sessionId: "spawn-join-provider-key",
      startedAt: NOW,
      toolUses: [
        {
          id: "call_x1",
          providerToolUseId: "toolu_prov_1",
          name: "Agent",
          timestamp: "2026-07-31T17:00:01.000Z",
          input: { subagent_type: "code-reviewer", prompt: "first" },
        },
        {
          id: "call_x2",
          providerToolUseId: "toolu_prov_2",
          name: "Agent",
          timestamp: "2026-07-31T17:00:02.000Z",
          input: { subagent_type: "code-reviewer", prompt: "second" },
        },
      ],
      subagents: [
        {
          id: "agent-claimed",
          name: "Claude subagent claimed",
          nativeSubagentId: "agent-claimed",
          type: "code-reviewer",
          startedAt: "2026-07-31T17:00:02.000Z",
          metadata: { spawnedByToolUseId: "toolu_prov_2" },
        },
      ],
    });

    // The earlier same-type delegation must NOT steal the claimant through the
    // fuzzy type tier; the exactly-claimed SECOND delegation gets it.
    assert.deepEqual(subagentPairs(session), [
      {
        providerToolUseId: "toolu_prov_1",
        externalInvocationId: "subagent:toolu_prov_1",
      },
      {
        providerToolUseId: "toolu_prov_2",
        externalInvocationId: "subagent:agent-claimed",
      },
    ]);
  });

  test("a subagent spawned by an unrelated tool use never steals the pairing", () => {
    const session = makeSession({
      sessionId: "spawn-join-stale",
      startedAt: NOW,
      toolUses: [delegationToolUse(FIRST_TOOL_USE, "2026-07-31T17:00:01.000Z")],
      subagents: [
        {
          id: "agent-stale",
          name: "Claude subagent stale",
          nativeSubagentId: "agent-stale",
          type: "code-reviewer",
          startedAt: NOW,
          metadata: { spawnedByToolUseId: "toolu_from_another_session" },
        },
      ],
    });

    // The exact join misses, so the existing fuzzy tiers still apply — the
    // change is additive, not a replacement of the old behavior.
    assert.deepEqual(subagentPairs(session), [
      {
        providerToolUseId: FIRST_TOOL_USE,
        externalInvocationId: "subagent:agent-stale",
      },
    ]);
  });
});
