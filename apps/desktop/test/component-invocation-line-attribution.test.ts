/**
 * @file component-invocation-line-attribution.test.ts
 * @description ISS-10730 — the producer half of per-invocation line
 * attribution, driven through the production entry
 * `deriveAgentComponentInvocationCandidates`.
 *
 * The fixture carries TWO mutating calls made by TWO DIFFERENT agents with
 * DIFFERENT deltas, because a one-agent fixture cannot tell per-agent
 * attribution from a session total: every assertion below would pass on a
 * global number if both rows carried the same one.
 */
import assert from "node:assert/strict";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { describe, test } from "vitest";
import { invocationLineColumns } from "../src/main/database/component-invocation-row-writer.js";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-09-21T17:00:00.000Z";
const MAIN_AGENT = "main-agent";

function session() {
  return makeSession({
    sessionId: "line-attribution-session",
    startedAt: NOW,
    toolUses: [
      // Orchestrator's own edit.
      {
        id: "toolu_main_edit",
        providerToolUseId: "toolu_main_edit",
        name: "Edit",
        timestamp: "2026-09-21T17:00:01.000Z",
        diffDelta: { add: 12, del: 4 },
      },
      // A subagent's edit, with a DIFFERENT delta, and delete-only — the shape a
      // block relocated out of one file takes at this grain.
      {
        id: "toolu_child_edit",
        providerToolUseId: "toolu_child_edit",
        name: "Edit",
        timestamp: "2026-09-21T17:00:02.000Z",
        subagentId: "agent-child",
        diffDelta: { add: 0, del: 37 },
      },
      // A read changed nothing and carries no delta at all.
      {
        id: "toolu_read",
        providerToolUseId: "toolu_read",
        name: "Read",
        timestamp: "2026-09-21T17:00:03.000Z",
      },
      // A skill invocation is not a file mutation; a delta must not ride it even
      // if a harness ever attached one.
      {
        id: "toolu_skill",
        providerToolUseId: "toolu_skill",
        name: "Skill",
        skillName: "frankenstein",
        timestamp: "2026-09-21T17:00:04.000Z",
        diffDelta: { add: 99, del: 99 },
      },
      // A corrupt delta: fractional counts are a parse that went wrong, not a
      // smaller measurement.
      {
        id: "toolu_corrupt",
        providerToolUseId: "toolu_corrupt",
        name: "Write",
        timestamp: "2026-09-21T17:00:05.000Z",
        diffDelta: { add: 1.5, del: 0 },
      },
    ],
    subagents: [
      {
        id: "agent-child",
        name: "Claude subagent child",
        nativeSubagentId: "agent-child",
        type: "code-reviewer",
        startedAt: NOW,
      },
    ],
  });
}

function linesById(): Map<
  string,
  { linesAdded: number | null; linesRemoved: number | null; kind: string }
> {
  return new Map(
    deriveAgentComponentInvocationCandidates(session(), MAIN_AGENT, NOW).map(
      (candidate) => [
        candidate.externalInvocationId,
        {
          linesAdded: candidate.linesAdded,
          linesRemoved: candidate.linesRemoved,
          kind: candidate.componentKind,
        },
      ]
    )
  );
}

describe("per-invocation line attribution", () => {
  test("gives each mutating call its own delta, not a shared total", () => {
    const rows = linesById();
    assert.deepEqual(rows.get("toolu_main_edit"), {
      linesAdded: 12,
      linesRemoved: 4,
      kind: AgentComponentInvocationKind.Tool,
    });
    assert.deepEqual(rows.get("toolu_child_edit"), {
      linesAdded: 0,
      linesRemoved: 37,
      kind: AgentComponentInvocationKind.Tool,
    });
  });

  test("leaves a call with no recorded delta NULL, never a measured zero", () => {
    const read = rows(linesById(), "toolu_read");
    assert.equal(read.linesAdded, null);
    assert.equal(read.linesRemoved, null);
  });

  /**
   * NARROW, deliberately: the legacy `Skill` tool_use lane never forwards a
   * delta in the first place (`toolCandidates` skips it before
   * `toolInvocationCandidate`), so this case pins that forwarding gap and NOT
   * the kind gate. The gate itself is exercised below, where the stored-event
   * lane really can pair a Skill kind with a delta.
   */
  test("does not forward a delta through the legacy skill tool lane", () => {
    const skill = rows(linesById(), "toolu_skill");
    assert.equal(skill.kind, AgentComponentInvocationKind.Skill);
    assert.equal(skill.linesAdded, null);
    assert.equal(skill.linesRemoved, null);
  });

  /**
   * The kind gate, driven where it is load-bearing. `storedEventCandidate`
   * classifies a `Skill` row from `events.data` AND independently reads that
   * row's `diffDelta`, so this pair really does reach `invocationLineColumns`
   * together — nothing but `LINE_BEARING_INVOCATION_KINDS` stops it.
   */
  test("refuses a delta paired with a kind nothing measures lines for", () => {
    assert.deepEqual(
      invocationLineColumns({
        componentKind: AgentComponentInvocationKind.Skill,
        diffDelta: { add: 99, del: 99 },
      }),
      { linesAdded: null, linesRemoved: null }
    );
    // The same delta on a line-bearing kind IS kept, so the assertion above
    // cannot be satisfied by the function refusing every input.
    assert.deepEqual(
      invocationLineColumns({
        componentKind: AgentComponentInvocationKind.Tool,
        diffDelta: { add: 99, del: 99 },
      }),
      { linesAdded: 99, linesRemoved: 99 }
    );
  });

  test("refuses a corrupt delta whole rather than persisting its good half", () => {
    const corrupt = rows(linesById(), "toolu_corrupt");
    assert.equal(corrupt.linesAdded, null);
    assert.equal(corrupt.linesRemoved, null);
  });
});

function rows(
  map: ReturnType<typeof linesById>,
  id: string
): { linesAdded: number | null; linesRemoved: number | null; kind: string } {
  const row = map.get(id);
  if (!row) {
    throw new Error(`no candidate for ${id}`);
  }
  return row;
}
