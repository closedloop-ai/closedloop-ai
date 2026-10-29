import {
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { measuredInvocationTiming } from "../src/main/database/component-invocation-duration.js";
import { mergeInvocationRowsByExternalId } from "../src/main/database/component-invocation-row-writer.js";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import {
  makeSession,
  writeClaudeTranscript,
} from "./normalized-session-test-utils.js";
import { DELEGATING_ONLY_PARENT } from "./sidecar-diff-stats-fixtures.js";

const start = "2026-10-19T12:00:00.000Z";
const end = "2026-10-19T12:00:10.000Z";

describe("invocation timing producer", () => {
  it.each([0, 10_000])(
    "keeps a winning measured duration of %i paired with its own start on a remap collision",
    (durationMs) => {
      const [candidate] = deriveAgentComponentInvocationCandidates(
        makeSession({
          toolUses: [{ id: "call", name: "Read", timestamp: start }],
        }),
        "main-agent",
        end
      );
      if (!candidate) {
        throw new Error("Expected a tool invocation candidate");
      }
      const weaker = {
        ...candidate,
        invokedAt: end,
        durationMs: 1000,
        evidenceClass: AgentComponentInvocationEvidenceClass.PackMembership,
      };
      const stronger = {
        ...candidate,
        invokedAt: start,
        durationMs,
        evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
      };
      const [merged] = mergeInvocationRowsByExternalId([weaker, stronger]);
      expect(merged).toMatchObject({ invokedAt: start, durationMs });
      const [unchanged] = mergeInvocationRowsByExternalId([stronger, weaker]);
      expect(unchanged).toMatchObject({ invokedAt: start, durationMs });
    }
  );

  it("measures each matched call independently, including zero and ID-less calls", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        toolUses: [
          { id: "slow", name: "Read", timestamp: start, resultTimestamp: end },
          {
            id: "zero",
            name: "Read",
            timestamp: start,
            resultTimestamp: start,
          },
          { id: "point", name: "Bash", timestamp: start },
          { name: "Write", timestamp: start, resultTimestamp: end },
        ],
      }),
      "main-agent",
      end
    );
    expect(
      candidates.find((row) => row.externalInvocationId === "slow")?.durationMs
    ).toBe(10_000);
    expect(
      candidates.find((row) => row.externalInvocationId === "zero")?.durationMs
    ).toBe(0);
    expect(
      candidates.find((row) => row.externalInvocationId === "point")?.durationMs
    ).toBeUndefined();
    expect(candidates.find((row) => row.rawName === "Write")?.durationMs).toBe(
      10_000
    );
  });

  it("uses the spawning call's start and close for a subagent, not its later child start", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        toolUses: [
          {
            id: "spawn",
            name: "Agent",
            timestamp: start,
            resultTimestamp: end,
            input: { subagent_type: "reviewer" },
          },
        ],
        subagents: [
          {
            id: "child",
            type: "reviewer",
            name: "reviewer",
            startedAt: "2026-10-19T12:00:02.000Z",
            metadata: { spawnedByToolUseId: "spawn" },
          },
        ],
      }),
      "main-agent",
      end
    );
    const child = candidates.find(
      (row) => row.componentKind === AgentComponentInvocationKind.Subagent
    );
    expect(child).toMatchObject({ invokedAt: start, durationMs: 10_000 });
  });

  it("does not call a Skill dispatch's elapsed time the skill's duration", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        toolUses: [
          {
            id: "dispatch",
            name: "Skill",
            skillName: "review",
            timestamp: start,
            resultTimestamp: end,
          },
        ],
      }),
      "main-agent",
      end
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((row) => row.durationMs === undefined)).toBe(true);
  });

  it("leaves conflicting duplicate call identities unmeasured", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        toolUses: [
          { id: "same", name: "Read", timestamp: start, resultTimestamp: end },
          {
            id: "same",
            name: "Read",
            timestamp: start,
            resultTimestamp: start,
          },
        ],
      }),
      "main-agent",
      end
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.durationMs).toBeNull();
  });

  // tamsinb on #8910: invalid evidence used to throw out of the derivation and
  // lose every row in the set; it now refuses that one call's duration only.
  it("keeps a missing bracket unknown and refuses invalid source evidence", () => {
    expect(measuredInvocationTiming(start, null)).toEqual({});
    expect(measuredInvocationTiming(null, end)).toEqual({});
    for (const [from, to] of [
      [end, start],
      ["bad", end],
      [start, "bad"],
      [start, ""],
      [start, 3],
    ]) {
      expect(measuredInvocationTiming(from, to)).toEqual({
        durationRefusedInvalidEvidence: true,
      });
    }
  });

  it("derives the whole set when one call's result precedes its start", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      makeSession({
        toolUses: [
          { id: "slow", name: "Read", timestamp: start, resultTimestamp: end },
          {
            id: "backwards",
            name: "Read",
            timestamp: end,
            resultTimestamp: start,
          },
          { name: "Write", timestamp: end, resultTimestamp: start },
        ],
      }),
      "main-agent",
      end
    );
    expect(candidates).toHaveLength(3);
    expect(
      candidates.find((row) => row.externalInvocationId === "slow")
    ).toMatchObject({ durationMs: 10_000 });
    for (const refused of [
      candidates.find((row) => row.externalInvocationId === "backwards"),
      candidates.find((row) => row.rawName === "Write"),
    ]) {
      expect(refused).toMatchObject({ durationRefusedInvalidEvidence: true });
      expect(refused?.durationMs).toBeUndefined();
    }
  });

  // tamsinb on #8910: a flat sidecar `tool_result` line carries the call and
  // its result together, so it holds no result instant to measure against.
  it("does not measure a flat sidecar tool_result record as a zero-length call", async () => {
    const filePath = writeClaudeTranscript(
      "sess-flat-duration",
      DELEGATING_ONLY_PARENT,
      {
        subagents: {
          lane: [
            {
              type: "tool_result",
              timestamp: start,
              id: "toolu_flat_bash",
              name: "Bash",
              input: { command: "ls" },
              result: "a\nb",
            },
          ],
        },
      }
    );
    const parsed = await parseClaudeFile(filePath);
    if (!parsed) {
      throw new Error("Expected the transcript to parse");
    }
    const flat = parsed.subagents
      ?.flatMap((agent) => agent.toolUses ?? [])
      .find((tool) => tool.id === "toolu_flat_bash");
    expect(flat?.output).toBe("a\nb");
    expect(flat?.resultTimestamp).toBeUndefined();
    const candidate = deriveAgentComponentInvocationCandidates(
      parsed,
      "main-agent",
      end
    ).find((row) => row.providerToolUseId === "toolu_flat_bash");
    expect(candidate).toBeDefined();
    expect(candidate?.durationMs).toBeUndefined();
  });
});
