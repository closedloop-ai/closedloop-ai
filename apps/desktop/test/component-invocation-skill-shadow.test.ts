import assert from "node:assert/strict";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { describe, test } from "vitest";
import type { AgentComponentInvocationCandidate } from "../src/main/database/component-invocation-row-writer.js";
import {
  bareComponentName,
  skillShadowedCommandIndexes,
  skillShadowSkillOccurrences,
} from "../src/main/database/component-invocation-skill-shadow.js";

describe("per-occurrence skill shadow correlation", () => {
  test("pairs each skill with the nearest preceding unresolved command", () => {
    const shadowed = skillShadowedCommandIndexes(
      [
        {
          bareName: "review",
          invokedAt: "2026-08-20T10:00:00Z",
          resolved: false,
        },
        {
          bareName: "review",
          invokedAt: "2026-08-20T10:05:00Z",
          resolved: false,
        },
        {
          bareName: "build",
          invokedAt: "2026-08-20T10:02:00Z",
          resolved: false,
        },
      ],
      [
        {
          bareName: "review",
          invokedAt: "2026-08-20T10:06:00Z",
          subagent: false,
        },
        {
          bareName: "build",
          invokedAt: "2026-08-20T10:03:00Z",
          subagent: false,
        },
      ]
    );

    assert.deepEqual([...shadowed].sort(), [1, 2]);
  });

  test("never claims a positioned command forward in time", () => {
    assert.deepEqual(
      [
        ...skillShadowedCommandIndexes(
          [
            {
              bareName: "review",
              invokedAt: "2026-08-20T10:05:00Z",
              resolved: false,
            },
          ],
          [
            {
              bareName: "review",
              invokedAt: "2026-08-20T10:00:00Z",
              subagent: false,
            },
          ]
        ),
      ],
      []
    );
  });

  test("uses null timestamps only as the documented unpositioned fallback", () => {
    assert.deepEqual(
      [
        ...skillShadowedCommandIndexes(
          [
            { bareName: "review", invokedAt: null, resolved: false },
            {
              bareName: "review",
              invokedAt: "2026-08-20T10:05:00Z",
              resolved: false,
            },
          ],
          [
            {
              bareName: "review",
              invokedAt: "2026-08-20T10:00:00Z",
              subagent: false,
            },
          ]
        ),
      ],
      [0]
    );
    assert.deepEqual(
      [
        ...skillShadowedCommandIndexes(
          [
            {
              bareName: "review",
              invokedAt: "2026-08-20T10:05:00Z",
              resolved: false,
            },
          ],
          [{ bareName: "review", invokedAt: null, subagent: false }]
        ),
      ],
      [0]
    );
  });

  test("excludes resolved commands and subagent-owned skills", () => {
    const shadowed = skillShadowedCommandIndexes(
      [
        {
          bareName: "review",
          invokedAt: "2026-08-20T10:00:00Z",
          resolved: true,
        },
        {
          bareName: "review",
          invokedAt: "2026-08-20T10:01:00Z",
          resolved: false,
        },
      ],
      [
        {
          bareName: "review",
          invokedAt: "2026-08-20T10:02:00Z",
          subagent: true,
        },
      ]
    );

    assert.deepEqual([...shadowed], []);
  });

  test("deduplicates emitted skill occurrences by invocation identity", () => {
    const occurrences = skillShadowSkillOccurrences([
      candidate("skill-1", AgentComponentInvocationKind.Skill, null),
      candidate("skill-1", AgentComponentInvocationKind.Skill, "agent-parent"),
      candidate("command-1", AgentComponentInvocationKind.Command, null),
      candidate("skill-2", AgentComponentInvocationKind.Skill, "agent-parent"),
    ]);

    assert.deepEqual(occurrences, [
      {
        bareName: "review",
        invokedAt: "2026-08-20T10:00:00Z",
        subagent: false,
      },
      { bareName: "review", invokedAt: "2026-08-20T10:00:00Z", subagent: true },
    ]);
  });

  test("strips at most one leading slash from component keys", () => {
    assert.equal(bareComponentName("/review"), "review");
    assert.equal(bareComponentName("review"), "review");
    assert.equal(bareComponentName("//review"), "/review");
  });
});

function candidate(
  externalInvocationId: string,
  componentKind: AgentComponentInvocationCandidate["componentKind"],
  parentAgentId: string | null
): AgentComponentInvocationCandidate {
  return {
    externalInvocationId,
    componentKind,
    componentKey: "review",
    invokedAt: "2026-08-20T10:00:00Z",
    parentAgentId,
  } as AgentComponentInvocationCandidate;
}
