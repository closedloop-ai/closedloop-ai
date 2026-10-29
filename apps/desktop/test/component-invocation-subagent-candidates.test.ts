import assert from "node:assert/strict";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import { UNATTRIBUTED_SUBAGENT_ID } from "@repo/lib/harness/claude/parse-claude-subagents";
import {
  NormalizedDefinitionKind,
  type NormalizedInvocationDefinitionEvidence,
  type NormalizedSession,
} from "@repo/lib/harness/types";
import { describe, test } from "vitest";
import type { ToolCandidateContext } from "../src/main/database/component-invocation-candidate-context.js";
import type { MarkdownCandidateFn } from "../src/main/database/component-invocation-markdown-candidate.js";
import type { AgentComponentInvocationCandidate } from "../src/main/database/component-invocation-row-writer.js";
import { parserSubagentCandidates } from "../src/main/database/component-invocation-subagent-candidates.js";
import { buildSubagentAncestryIndex } from "../src/main/database/subagent-ancestry.js";
import { PARSE_POLICY_BASE } from "../src/main/parse-policy/parse-policy.js";

describe("parser-discovered subagent candidates", () => {
  test("skips represented and unattributed parser anchors", () => {
    const { candidates } = project(
      [
        subagent({ id: "represented" }),
        subagent({ id: UNATTRIBUTED_SUBAGENT_ID }),
      ],
      new Set(["represented"])
    );

    assert.deepEqual(candidates, []);
  });

  test("projects direct main-agent children with stable fallbacks", () => {
    const { candidates, inputs } = project([
      subagent({ id: "child-1", name: "Raw child", rawName: "Raw child" }),
    ]);

    assert.equal(candidates.length, 1);
    assert.equal(inputs[0]?.externalInvocationId, "subagent:child-1");
    assert.equal(inputs[0]?.externalSourceId, "child-1");
    assert.equal(inputs[0]?.componentKey, "general-purpose");
    assert.equal(inputs[0]?.normalizedName, "general-purpose");
    assert.equal(inputs[0]?.rawName, "Raw child");
    assert.equal(
      inputs[0]?.relationship,
      AgentComponentInvocationRelationship.Direct
    );
    assert.equal(
      inputs[0]?.anchorKind,
      AgentComponentInvocationAnchorKind.Agent
    );
    assert.equal(inputs[0]?.anchorValue, "agent-child-1");
    assert.equal(inputs[0]?.parentAgentId, "main-agent");
    assert.equal(inputs[0]?.sourceOrder, 350_000);
  });

  test("projects child-session, parent, evidence, and identity overrides", () => {
    const { inputs } = project([
      // ISS-10714: the parent must be a subagent of THIS session — the id map
      // production builds is derived from `session.subagents`, so the two can
      // never disagree there, and an ancestry naming an absent subagent is a
      // dangling pointer the resolver refuses.
      subagent({
        id: "child-2",
        parentId: "parent-1",
        childSessionId: "session-child",
        nativeSubagentId: "native-child",
        normalizedName: "reviewer",
        type: "worker",
        startedAt: "2026-08-20T10:00:00.000Z",
        definitionSnapshot: {
          kind: NormalizedDefinitionKind.Subagent,
          rawName: "worker",
          normalizedName: "reviewer",
          content: "definition",
          capturedAt: "2026-08-20T10:00:00.000Z",
        },
      }),
      subagent({ id: "parent-1", name: "Parent" }),
    ]);

    assert.equal(inputs[0]?.externalSourceId, "native-child");
    assert.equal(inputs[0]?.childSessionId, "session-child");
    assert.equal(inputs[0]?.componentKey, "reviewer");
    assert.equal(inputs[0]?.invokedAt, "2026-08-20T10:00:00.000Z");
    assert.equal(
      inputs[0]?.relationship,
      AgentComponentInvocationRelationship.ChildSession
    );
    assert.equal(inputs[0]?.parentAgentId, "agent-parent-1");
    assert.equal(inputs[0]?.externalAgentId, "native-child");
    assert.deepEqual(
      inputs[0]?.focusedEvidence,
      definitionEvidence("subagent:child-2")
    );
  });

  test("falls back to the main agent and session anchor when parser ids are absent", () => {
    const { inputs } = project(
      [subagent({ id: "child-3", parentId: "missing-parent", type: "worker" })],
      new Set(),
      new Map()
    );

    assert.equal(inputs[0]?.agentId, null);
    assert.equal(inputs[0]?.parentAgentId, "main-agent");
    assert.equal(
      inputs[0]?.anchorKind,
      AgentComponentInvocationAnchorKind.Session
    );
    assert.equal(inputs[0]?.anchorValue, "session-1");
    assert.equal(inputs[0]?.componentKey, "worker");
  });
});

function project(
  subagents: NonNullable<NormalizedSession["subagents"]>,
  representedSubagentIds: ReadonlySet<string> = new Set(),
  parserAgentIdById: ReadonlyMap<string, string> = new Map([
    ["child-1", "agent-child-1"],
    ["child-2", "agent-child-2"],
    ["parent-1", "agent-parent-1"],
  ])
): {
  candidates: AgentComponentInvocationCandidate[];
  inputs: Parameters<MarkdownCandidateFn>[0][];
} {
  const inputs: Parameters<MarkdownCandidateFn>[0][] = [];
  const markdownCandidate: MarkdownCandidateFn = (input) => {
    inputs.push(input);
    return input as unknown as AgentComponentInvocationCandidate;
  };
  const session = {
    sessionId: "session-1",
    subagents,
  } as NormalizedSession;
  const context: ToolCandidateContext = {
    session,
    mainAgentId: "main-agent",
    parserAgentIdById,
    subagentAncestryById: buildSubagentAncestryIndex(session, parserAgentIdById)
      .bySubagentId,
    externalAgentIdById: new Map<string, string>(),
    evidenceByInvocationId: new Map([
      ["subagent:child-2", definitionEvidence("subagent:child-2")],
    ]),
    subagentUsageById: new Map(),
    subagentTokenRecordsById: new Map(),
    now: "2026-08-20T12:00:00.000Z",
    harness: null,
    parsePolicy: PARSE_POLICY_BASE,
  };
  return {
    candidates: parserSubagentCandidates(
      context,
      markdownCandidate,
      representedSubagentIds
    ),
    inputs,
  };
}

function subagent(
  overrides: Partial<NonNullable<NormalizedSession["subagents"]>[number]>
): NonNullable<NormalizedSession["subagents"]>[number] {
  return {
    id: "child",
    name: "Child",
    ...overrides,
  };
}

function definitionEvidence(
  invocationId: string
): NormalizedInvocationDefinitionEvidence {
  return {
    invocationId,
    kind: NormalizedDefinitionKind.Subagent,
    rawName: "worker",
    normalizedName: "reviewer",
    invokedAt: "2026-08-20T10:00:00.000Z",
    content: "definition",
    definitionHash: "definition-hash",
    normalizerContractVersion: 1,
    definitionFormat: "md",
    sourcePath: "/tmp/reviewer.md",
    sourceModifiedAt: "2026-08-20T09:59:00.000Z",
    capturedAt: "2026-08-20T10:00:00.000Z",
  };
}
