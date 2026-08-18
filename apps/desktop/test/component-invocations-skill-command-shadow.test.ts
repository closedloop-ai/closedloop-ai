import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import {
  NormalizedDefinitionKind,
  type NormalizedSession,
} from "@repo/lib/harness/types";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-07-22T17:00:00.000Z";
const TS = "2026-07-22T17:00:01.000Z";

function commandKeys(
  sessionId: string,
  overrides: Partial<NormalizedSession>
): string[] {
  const candidates = deriveAgentComponentInvocationCandidates(
    makeSession({ sessionId, ...overrides }),
    "main-agent",
    NOW
  );
  return candidates
    .filter(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Command
    )
    .map((candidate) => candidate.componentKey);
}

describe("ISS-4775 skill/command shadow suppression", () => {
  test("a slash-invoked skill yields only the Skill candidate, no phantom command", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "slash-invoked-skill",
        messages: [{ role: "human", timestamp: TS, text: "/cl-ci-babysit" }],
        slashCommands: [{ name: "/cl-ci-babysit", timestamp: TS }],
        skills: [{ name: "cl-ci-babysit", timestamp: TS }],
        toolUses: [
          {
            name: "Skill",
            kind: "harness" as const,
            skillName: "cl-ci-babysit",
            timestamp: TS,
          },
        ],
      }),
      "main-agent",
      NOW
    );
    const commandCandidates = candidates.filter(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Command
    );
    assert.equal(commandCandidates.length, 0);
    const skillCandidates = candidates.filter(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Skill
    );
    assert.equal(skillCandidates.length, 1);
    assert.equal(skillCandidates[0]?.componentKey, "cl-ci-babysit");
  });

  test("a genuine non-skill command still emits", () => {
    assert.deepEqual(
      commandKeys("genuine-command", {
        messages: [{ role: "human", timestamp: TS, text: "/deploy" }],
        slashCommands: [{ name: "/deploy", timestamp: TS }],
      }),
      ["/deploy"]
    );
  });

  // wongk (PR #4193): a legacy `Skill` tool_use carries normalizedName "Skill"
  // (the tool identity) with the invoked skill in `skillName`. With no
  // `session.skills` entry, suppression must still key off `skillName` so the
  // phantom `/review` command is dropped — keying off normalizedName would add
  // "Skill" to the set and leave the phantom.
  test("tool-use-only legacy Skill (normalizedName 'Skill') still suppresses its phantom command", () => {
    assert.deepEqual(
      commandKeys("legacy-skill-tool-use-only", {
        messages: [{ role: "human", timestamp: TS, text: "/review" }],
        slashCommands: [{ name: "/review", timestamp: TS }],
        toolUses: [
          {
            name: "Skill",
            rawName: "Skill",
            normalizedName: "Skill",
            kind: "harness" as const,
            skillName: "review",
            timestamp: TS,
          },
        ],
      }),
      []
    );
  });

  // codex / closedloop-ai-stage (PR #4193): a `/foo` that resolved against a
  // real `.claude/commands/foo.md` (carrying a definitionSnapshot) is a genuine
  // command even when a same-named skill was also invoked; suppression must not
  // drop it, or the session's Command count loses a correct row.
  test("a resolved command sharing a skill's bare name still emits", () => {
    assert.deepEqual(
      commandKeys("resolved-command-name-collision", {
        messages: [{ role: "human", timestamp: TS, text: "/review" }],
        slashCommands: [
          {
            name: "/review",
            timestamp: TS,
            definitionSnapshot: {
              kind: NormalizedDefinitionKind.Command,
              rawName: "/review",
              normalizedName: "/review",
              content: "---\nname: review\n---\nReview the diff.\n",
              capturedAt: TS,
            },
          },
        ],
        skills: [{ name: "review", timestamp: TS }],
        toolUses: [
          {
            name: "Skill",
            kind: "harness" as const,
            skillName: "review",
            timestamp: TS,
          },
        ],
      }),
      ["/review"]
    );
  });
});

// ISS-4810 (closedloop-ai-stage, PR #4193): suppression must pair each slash
// invocation to its OWN Skill tool_use, not drop every same-named command in the
// session. Three `/foo` user turns against two `foo` Skill invocations must
// leave ONE Command row, or the components view undercounts against the very
// turns it derives from.
describe("ISS-4810 per-occurrence skill/command shadow correlation", () => {
  const FIRST = "2026-07-22T17:00:01.000Z";
  const ESCAPED = "2026-07-22T17:00:02.000Z";
  const SECOND = "2026-07-22T17:00:03.000Z";

  test("three slash invocations against two Skill invocations keep the unpaired command", () => {
    assert.deepEqual(
      commandKeys("escaped-slash-skill", {
        messages: [
          { role: "human", timestamp: FIRST, text: "/foo" },
          { role: "human", timestamp: ESCAPED, text: "/foo" },
          { role: "human", timestamp: SECOND, text: "/foo" },
        ],
        slashCommands: [
          { name: "/foo", timestamp: FIRST },
          { name: "/foo", timestamp: ESCAPED },
          { name: "/foo", timestamp: SECOND },
        ],
        skills: [
          { name: "foo", timestamp: FIRST, providerToolUseId: "toolu_foo_1" },
          { name: "foo", timestamp: SECOND, providerToolUseId: "toolu_foo_2" },
        ],
      }),
      ["/foo"]
    );
  });

  test("the surviving command is the slash turn no Skill invocation followed", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        sessionId: "escaped-slash-skill-identity",
        messages: [
          { role: "human", timestamp: FIRST, text: "/foo" },
          { role: "human", timestamp: ESCAPED, text: "/foo" },
          { role: "human", timestamp: SECOND, text: "/foo" },
        ],
        slashCommands: [
          { name: "/foo", timestamp: FIRST },
          { name: "/foo", timestamp: ESCAPED },
          { name: "/foo", timestamp: SECOND },
        ],
        skills: [
          { name: "foo", timestamp: FIRST, providerToolUseId: "toolu_foo_1" },
          { name: "foo", timestamp: SECOND, providerToolUseId: "toolu_foo_2" },
        ],
      }),
      "main-agent",
      NOW
    );
    const survivors = candidates.filter(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Command
    );
    assert.equal(survivors.length, 1);
    // The escaped turn is the one with no Skill invocation between it and the
    // next slash turn — pairing is by occurrence, not by array position.
    assert.equal(survivors[0]?.invokedAt, ESCAPED);
    assert.equal(
      candidates.filter(
        (candidate) =>
          candidate.componentKind === AgentComponentInvocationKind.Skill
      ).length,
      2
    );
  });

  test("a skills entry and its legacy Skill tool_use count as ONE occurrence", () => {
    // Both lists describe the same invocation and dedupe to a single Skill
    // candidate, so they must claim a single slash invocation — counting the raw
    // lists would suppress both `/foo` turns.
    assert.deepEqual(
      commandKeys("skill-and-tool-use-same-invocation", {
        messages: [
          { role: "human", timestamp: FIRST, text: "/foo" },
          { role: "human", timestamp: SECOND, text: "/foo" },
        ],
        slashCommands: [
          { name: "/foo", timestamp: FIRST },
          { name: "/foo", timestamp: SECOND },
        ],
        skills: [{ name: "foo", timestamp: FIRST }],
        toolUses: [
          {
            name: "Skill",
            kind: "harness" as const,
            skillName: "foo",
            timestamp: FIRST,
          },
        ],
      }),
      ["/foo"]
    );
  });

  // wongk-adjacent review threads (chatgpt-codex-connector + closedloop-ai-stage,
  // PR #4255): the `earliestUnclaimed` fallback existed for occurrences with NO
  // timestamp, but as written it also fired for a fully-positioned Skill that
  // strictly PRECEDES every unclaimed slash turn — claiming a command forward in
  // time and deleting the exact user turn ISS-4810 exists to preserve.
  test("a Skill invocation that precedes the slash turn does NOT claim it", () => {
    assert.deepEqual(
      commandKeys("skill-before-escaped-slash", {
        messages: [{ role: "human", timestamp: SECOND, text: "/foo" }],
        // The model fired `foo` autonomously FIRST; the user then typed `/foo`
        // and escaped before the Skill tool could fire. Two independent facts,
        // so the Command row must stand.
        slashCommands: [{ name: "/foo", timestamp: SECOND }],
        skills: [
          { name: "foo", timestamp: FIRST, providerToolUseId: "toolu_foo_pre" },
        ],
      }),
      ["/foo"]
    );
  });

  test("a Skill invocation still claims the slash turn that precedes it", () => {
    // The guard above must not break the ordinary case it is bounding.
    assert.deepEqual(
      commandKeys("skill-after-slash", {
        messages: [{ role: "human", timestamp: FIRST, text: "/foo" }],
        slashCommands: [{ name: "/foo", timestamp: FIRST }],
        skills: [
          {
            name: "foo",
            timestamp: SECOND,
            providerToolUseId: "toolu_foo_post",
          },
        ],
      }),
      []
    );
  });

  // chatgpt-codex-connector (PR #4255): slash invocations are attributed to the
  // MAIN agent, so a subagent independently invoking `foo` is not evidence about
  // the user's `/foo` turn and must not claim it.
  test("a SUBAGENT's skill invocation does not claim the main agent's slash turn", () => {
    assert.deepEqual(
      commandKeys("subagent-skill-vs-main-slash", {
        messages: [{ role: "human", timestamp: SECOND, text: "/foo" }],
        slashCommands: [{ name: "/foo", timestamp: SECOND }],
        subagents: [{ id: "sub-1", name: "worker", startedAt: FIRST }],
        skills: [
          {
            name: "foo",
            timestamp: SECOND,
            providerToolUseId: "toolu_foo_sub",
            subagentId: "sub-1",
          },
        ],
      }),
      ["/foo"]
    );
  });

  test("more Skill invocations than slash turns suppresses only the slash turns", () => {
    assert.deepEqual(
      commandKeys("skill-invoked-without-slash", {
        messages: [{ role: "human", timestamp: FIRST, text: "/foo" }],
        slashCommands: [{ name: "/foo", timestamp: FIRST }],
        skills: [
          { name: "foo", timestamp: FIRST, providerToolUseId: "toolu_foo_1" },
          { name: "foo", timestamp: SECOND, providerToolUseId: "toolu_foo_2" },
        ],
      }),
      []
    );
  });
});
