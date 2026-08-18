/**
 * ISS-5292 Packet C: branch coverage for `parse-claude.ts` — entry-, message-,
 * and session-level branches.
 *
 * Covers the branches left uncovered by the main test suite and the
 * feature-specific tests (hooks, model-switch, cache, delegations, etc.).
 * Tool-use and tool-result handling lives in the sibling
 * `parse-claude.tools.test.ts`. Every test asserts an observable behavioral
 * outcome — no source-text scans.
 */
import { describe, expect, it } from "vitest";
import type { UsageDedupEntry } from "../usage-dedup";
import { extractDedupedUsage, isoTs } from "./parse-claude";
import {
  assistantLine,
  BASE_USAGE,
  userLine,
} from "./parse-claude.test-fixtures";
import { parseClaudeTranscript } from "./parse-claude-core";
import { UNATTRIBUTED_SUBAGENT_ID } from "./parse-claude-subagents";

// ---------------------------------------------------------------------------
// isoTs — number branch
// ---------------------------------------------------------------------------

describe("isoTs", () => {
  it("converts an epoch number to an ISO string", () => {
    // typeof ts === "number" → new Date(ts).toISOString()
    expect(isoTs(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(isoTs(1_234_567_890_000)).toBe("2009-02-13T23:31:30.000Z");
  });

  it("returns null for null/undefined/object inputs", () => {
    expect(isoTs(null)).toBeNull();
    expect(isoTs(undefined)).toBeNull();
    expect(isoTs({ ts: "2026-01-01" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// captureCommonMetadata — session metadata fields
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — session metadata fields", () => {
  it("captures slug, gitBranch, version, entrypoint, and permissionMode from the first matching line", async () => {
    // Branches 79[0], 81[0], 83[0], 85[0], 87[0]: each field's first-wins if-true path.
    const metaLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/workspace/project",
      slug: "my-feature-branch",
      gitBranch: "feat/my-feature",
      version: "1.4.2",
      entrypoint: "claude",
      permissionMode: "acceptEdits",
      message: { role: "user", content: "hi" },
    });

    const session = await parseClaudeTranscript([metaLine, assistantLine()], {
      sessionId: "metadata-test",
    });

    expect(session?.slug).toBe("my-feature-branch");
    expect(session?.gitBranch).toBe("feat/my-feature");
    expect(session?.version).toBe("1.4.2");
    expect(session?.entrypoint).toBe("claude");
    expect(session?.permissionMode).toBe("acceptEdits");
  });

  it("captures teamName from entries that carry it", async () => {
    // typeof entry.teamName === "string" → acc.teams.add(teamName).
    const teamLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      cwd: "/workspace/project",
      teamName: "platform-engineering",
      message: { role: "user", content: "team line" },
    });

    const session = await parseClaudeTranscript([teamLine, assistantLine()], {
      sessionId: "team-test",
    });

    expect(session?.teams).toContain("platform-engineering");
  });
});

// ---------------------------------------------------------------------------
// captureCommonMetadata — raw API error
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — raw API error message", () => {
  it("records a raw API error from entry.message.type === 'error'", async () => {
    // rawMsg.type === "error" && rawMsg.error → push to apiErrors.
    const errorLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      message: {
        type: "error",
        error: {
          type: "overloaded_error",
          message: "Overloaded — try again later",
        },
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), errorLine],
      { sessionId: "raw-api-error" }
    );

    const rawError = session?.apiErrors.find(
      (e) => e.type === "overloaded_error"
    );
    expect(rawError).toBeDefined();
    expect(rawError?.message).toBe("Overloaded — try again later");
  });
});

// ---------------------------------------------------------------------------
// captureCommonMetadata — compaction with falsy uuid/timestamp
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — compaction with falsy uuid and timestamp", () => {
  it("stores null for uuid and timestamp when they are empty strings", async () => {
    // Branches 66[1]/67[1]: (entry.uuid as string) || null → "" → null.
    const compactionLine = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      uuid: "",
      timestamp: "",
      message: { role: "user", content: "summary" },
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), compactionLine],
      { sessionId: "compaction-falsy" }
    );

    const compaction = session?.compactions[0] as
      | { uuid: unknown; timestamp: unknown }
      | undefined;
    expect(compaction?.uuid).toBeNull();
    expect(compaction?.timestamp).toBeNull();
  });

  it("keeps a non-empty uuid and timestamp on the compaction record", async () => {
    // Paired control for Branches 66[0]/67[0]: the `|| null` fallback must not
    // fire for real values, so the nulls asserted above are caused by the empty
    // strings and not by the field being dropped outright.
    const compactionLine = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      uuid: "compaction-uuid-1",
      timestamp: "2026-07-09T12:00:07.000Z",
      message: { role: "user", content: "summary" },
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), compactionLine],
      { sessionId: "compaction-truthy" }
    );

    const compaction = session?.compactions[0] as
      | { uuid: unknown; timestamp: unknown }
      | undefined;
    expect(compaction?.uuid).toBe("compaction-uuid-1");
    expect(compaction?.timestamp).toBe("2026-07-09T12:00:07.000Z");
  });
});

// ---------------------------------------------------------------------------
// handlePrLinkEntry — non-numeric prNumber
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — pr-link with non-number prNumber", () => {
  it("skips a pr-link whose prNumber is not a number", async () => {
    // typeof entry.prNumber !== "number" → prNumber = null →
    // !(prUrl && prNumber) → return early.
    const prLinkLine = JSON.stringify({
      type: "pr-link",
      timestamp: "2026-07-09T12:00:05.000Z",
      prUrl: "https://github.com/org/repo/pull/42",
      prRepository: "org/repo",
      prNumber: "not-a-number",
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), prLinkLine],
      { sessionId: "pr-link-nonnumber" }
    );

    // The pr-link is ignored because prNumber is not a number.
    expect(session?.prLinks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractDedupedUsage — requestId branch and subagentIdOverride
// ---------------------------------------------------------------------------

describe("extractDedupedUsage", () => {
  it("includes the entry in the dedup map when requestId is a non-empty string", () => {
    // typeof entry.requestId === "string" && length > 0 → truthy.
    const entry: Record<string, unknown> = {
      requestId: "req-abc123",
      message: {
        id: "msg-abc",
        model: "claude-opus-4",
        usage: BASE_USAGE,
      },
    };

    const map = extractDedupedUsage([
      { entry, iso: "2026-07-09T12:00:01.000Z" },
    ]);
    expect(map.size).toBe(1);
  });

  it("stamps subagentId from subagentIdOverride onto every dedup entry", () => {
    // subagentIdOverride is defined → short-circuit
    // (subagentIdOverride ?? deriveSidechainSubagentId) → uses the override.
    const entry: Record<string, unknown> = {
      message: {
        id: "msg-sub",
        model: "claude-opus-4",
        usage: BASE_USAGE,
      },
    };

    const map = extractDedupedUsage(
      [{ entry, iso: "2026-07-09T12:00:01.000Z" }],
      "agent-override-id"
    );

    const dedupEntry = [...map.values()][0] as UsageDedupEntry | undefined;
    expect(dedupEntry?.subagentId).toBe("agent-override-id");
  });

  it("leaves subagentId unset when no override is supplied", () => {
    // Paired control: without an override the derivation runs,
    // and a non-sidechain entry yields no subagent id. Pins that the assertion
    // above is caused by the override rather than by a value the parser always
    // produces.
    const entry: Record<string, unknown> = {
      message: {
        id: "msg-sub-2",
        model: "claude-opus-4",
        usage: BASE_USAGE,
      },
    };

    const map = extractDedupedUsage([
      { entry, iso: "2026-07-09T12:00:01.000Z" },
    ]);

    const dedupEntry = [...map.values()][0] as UsageDedupEntry | undefined;
    expect(dedupEntry?.subagentId ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleAssistantBlock — thinking block
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — thinking block", () => {
  it("counts thinking blocks and emits an isThinking message for each", async () => {
    // block.type === "thinking" → thinkingBlockCount++ + message push.
    const thinkingAssistantLine = assistantLine({}, [
      { type: "thinking", thinking: "Let me reason through this..." },
      { type: "text", text: "Here is my answer." },
    ]);

    const session = await parseClaudeTranscript(
      [userLine(), thinkingAssistantLine],
      { sessionId: "thinking-test" }
    );

    expect(session?.thinkingBlockCount).toBe(1);
    const thinkingMsg = session?.messages.find((m) => m.isThinking === true);
    expect(thinkingMsg).toBeDefined();
    expect(thinkingMsg?.role).toBe("assistant");
    expect(thinkingMsg?.text).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleAttachmentEntry — hookEvent null / command null
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — attachment hook without hookEvent or command", () => {
  it("records hook.event as null when hookEvent is absent", async () => {
    const attachmentLine = JSON.stringify({
      type: "attachment",
      timestamp: "2026-07-09T12:00:02.000Z",
      attachment: {
        type: "hook_success",
        hookName: "PreToolUse:Bash",
        // hookEvent deliberately absent → null
        toolUseID: "toolu_x1",
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), attachmentLine],
      { sessionId: "hook-no-event" }
    );

    expect(session?.hooks).toHaveLength(1);
    expect(session?.hooks[0]?.event).toBeNull();
  });

  it("records hook.command as null when command is absent", async () => {
    const attachmentLine = JSON.stringify({
      type: "attachment",
      timestamp: "2026-07-09T12:00:02.000Z",
      attachment: {
        type: "hook_success",
        hookName: "Stop:handler",
        hookEvent: "Stop",
        // command deliberately absent → null
        toolUseID: "toolu_x2",
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), attachmentLine],
      { sessionId: "hook-no-command" }
    );

    expect(session?.hooks).toHaveLength(1);
    expect(session?.hooks[0]?.command).toBeNull();
  });

  it("carries hookEvent and command through when both are present", async () => {
    // Paired control for the two null arms above.
    const attachmentLine = JSON.stringify({
      type: "attachment",
      timestamp: "2026-07-09T12:00:02.000Z",
      attachment: {
        type: "hook_success",
        hookName: "PreToolUse:Bash",
        hookEvent: "PreToolUse",
        command: "./scripts/guard.sh",
        toolUseID: "toolu_x3",
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), attachmentLine],
      { sessionId: "hook-full" }
    );

    expect(session?.hooks[0]?.event).toBe("PreToolUse");
    expect(session?.hooks[0]?.command).toBe("./scripts/guard.sh");
  });
});

// ---------------------------------------------------------------------------
// isSyntheticUserEntry — isMeta and origin.kind paths
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — synthetic user entries are not counted as human", () => {
  it("skips isMeta=true entries (slash-command expansion turns)", async () => {
    // Branch: entry.isMeta === true → isSyntheticUserEntry returns true.
    const metaUserLine = userLine({ isMeta: true }, "slash-command expansion");

    const session = await parseClaudeTranscript(
      [userLine(), metaUserLine, assistantLine()],
      { sessionId: "meta-user-test" }
    );

    // Only the real user turn is counted.
    expect(session?.userMessages).toBe(1);
  });

  it("skips entries whose origin.kind is a non-human value", async () => {
    // Branch: typeof kind === "string" && kind !== "human" → isSyntheticUserEntry true.
    const notificationLine = userLine(
      { origin: { kind: "task-notification" } },
      "background task done"
    );

    const session = await parseClaudeTranscript(
      [userLine(), notificationLine, assistantLine()],
      { sessionId: "notification-test" }
    );

    expect(session?.userMessages).toBe(1);
  });

  it("counts an origin.kind of 'human' as a real turn", async () => {
    // Paired control: the same entry shape with kind === "human" takes the false
    // arm and IS counted, so the two skips above are attributable to the value.
    const humanLine = userLine(
      { origin: { kind: "human" } },
      "a second real question"
    );

    const session = await parseClaudeTranscript(
      [userLine(), humanLine, assistantLine()],
      { sessionId: "human-origin-test" }
    );

    expect(session?.userMessages).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// <synthetic> model — skips model/usage accumulation
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — <synthetic> model entries", () => {
  it("does not record a model or usage for an assistant entry with model='<synthetic>'", async () => {
    const syntheticModelLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "synthetic response" }],
        usage: BASE_USAGE,
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), syntheticModelLine],
      { sessionId: "synthetic-model-test" }
    );

    // No real model set → session.model is null (or falls back to modelSwitchLabel).
    expect(session?.model).toBeNull();
    // No usage recorded for <synthetic> → tokensByModel is empty.
    expect(Object.keys(session?.tokensByModel ?? {})).toHaveLength(0);
    // No assistant turns counted (assistantMessages from dedup map, which stays empty).
    expect(session?.assistantMessages).toBe(0);
  });

  it("records model and usage for the same entry with a real model name", async () => {
    // Paired control: identical shape, real model → all three assertions above
    // flip, proving the skip is driven by the "<synthetic>" sentinel.
    const session = await parseClaudeTranscript([userLine(), assistantLine()], {
      sessionId: "real-model-test",
    });

    expect(session?.model).toBe("claude-opus-4");
    expect(Object.keys(session?.tokensByModel ?? {})).toHaveLength(1);
    expect(session?.assistantMessages).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unknown assistant block type (handleAssistantBlock fall-through)
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — unknown assistant block type", () => {
  it("ignores unknown block types without crashing", async () => {
    // block.type !== "thinking" (also not text/tool_use) → fall-through.
    const unknownBlockLine = assistantLine({}, [
      { type: "redacted_thinking", data: "some opaque data" },
      { type: "text", text: "visible response" },
    ]);

    const session = await parseClaudeTranscript(
      [userLine(), unknownBlockLine],
      { sessionId: "unknown-block-type" }
    );

    // The text block is still captured; the unknown block is ignored.
    const assistantMsg = session?.messages.find(
      (m) => m.role === "assistant" && m.text?.includes("visible response")
    );
    expect(assistantMsg).toBeDefined();
    expect(session?.thinkingBlockCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Usage with service_tier, speed, and inference_geo
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — assistant usage tier fields", () => {
  it("records service_tier, speed, and a real inference_geo from the usage block", async () => {
    // Branches 169[0], 170[0], 172[0]: each string field is added to its set.
    const tieredAssistantLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text: "tiered" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          service_tier: "standard",
          speed: "fast",
          inference_geo: "us-east-1",
        },
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), tieredAssistantLine],
      { sessionId: "tiered-usage" }
    );

    expect(session?.usageExtras?.service_tiers).toEqual(["standard"]);
    expect(session?.usageExtras?.speeds).toEqual(["fast"]);
    expect(session?.usageExtras?.inference_geos).toEqual(["us-east-1"]);
  });

  it("does not record inference_geo when the value is 'not_available'", async () => {
    // inference_geo === "not_available" → skip (false arm of &&).
    // service_tier is still carried, which pins that the entry WAS processed and
    // only the geo was filtered.
    const notAvailableGeoLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [{ type: "text", text: "geo test" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          service_tier: "standard",
          inference_geo: "not_available",
        },
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), notAvailableGeoLine],
      { sessionId: "geo-not-available" }
    );

    expect(session?.usageExtras?.inference_geos).toEqual([]);
    expect(session?.usageExtras?.service_tiers).toEqual(["standard"]);
  });

  it("records nothing in the tier sets when the usage block omits them", async () => {
    // Paired control for the 169[1]/170[1] false arms.
    const session = await parseClaudeTranscript([userLine(), assistantLine()], {
      sessionId: "no-tier-fields",
    });

    expect(session?.usageExtras?.service_tiers).toEqual([]);
    expect(session?.usageExtras?.speeds).toEqual([]);
    expect(session?.usageExtras?.inference_geos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractDedupedUsage — iso=null branch
// ---------------------------------------------------------------------------

describe("extractDedupedUsage — null iso timestamp", () => {
  it("uses empty string timestamp when iso is null", () => {
    // iso ?? "" → iso is null → "" is used as timestamp.
    const entry: Record<string, unknown> = {
      message: {
        id: "msg-null-ts",
        model: "claude-opus-4",
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    };

    const map = extractDedupedUsage([{ entry, iso: null }]);
    expect(map.size).toBe(1);
    // The `?? ""` fallback supplied `firstTs`, rather than the entry being
    // dropped or stamped null.
    const dedupEntry = [...map.values()][0] as UsageDedupEntry | undefined;
    expect(dedupEntry?.firstTs).toBe("");
  });

  it("carries a real iso through to firstTs", () => {
    // Paired control for the non-null arm, so the "" above is attributable to
    // the fallback and not to the field never being populated.
    const entry: Record<string, unknown> = {
      message: {
        id: "msg-real-ts",
        model: "claude-opus-4",
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    };

    const map = extractDedupedUsage([
      { entry, iso: "2026-07-09T12:00:01.000Z" },
    ]);
    const dedupEntry = [...map.values()][0] as UsageDedupEntry | undefined;
    expect(dedupEntry?.firstTs).toBe("2026-07-09T12:00:01.000Z");
  });
});

// ---------------------------------------------------------------------------
// Duplicate pr-link — Branch for acc.seenPrLinks dedup
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — duplicate pr-link dedup", () => {
  it("records a pr-link entry only once when the same URL appears twice", async () => {
    // Branch: acc.seenPrLinks.has(prUrl) → true → return early (dedup).
    const prLink1 = JSON.stringify({
      type: "pr-link",
      timestamp: "2026-07-09T12:00:05.000Z",
      prUrl: "https://github.com/org/repo/pull/99",
      prRepository: "org/repo",
      prNumber: 99,
    });
    const prLink2 = JSON.stringify({
      type: "pr-link",
      timestamp: "2026-07-09T12:00:06.000Z",
      prUrl: "https://github.com/org/repo/pull/99",
      prRepository: "org/repo",
      prNumber: 99,
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), prLink1, prLink2],
      { sessionId: "pr-link-dedup" }
    );

    expect(session?.prLinks).toHaveLength(1);
  });

  it("records two pr-links when the URLs differ", async () => {
    // Paired control for the false arm of the seenPrLinks guard: the dedup above
    // must be attributable to the repeated URL, not to a cap of one.
    const prLink1 = JSON.stringify({
      type: "pr-link",
      timestamp: "2026-07-09T12:00:05.000Z",
      prUrl: "https://github.com/org/repo/pull/99",
      prRepository: "org/repo",
      prNumber: 99,
    });
    const prLink2 = JSON.stringify({
      type: "pr-link",
      timestamp: "2026-07-09T12:00:06.000Z",
      prUrl: "https://github.com/org/repo/pull/100",
      prRepository: "org/repo",
      prNumber: 100,
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), prLink1, prLink2],
      { sessionId: "pr-link-distinct" }
    );

    expect(session?.prLinks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Sidechain subagent — nativeId absent and existing update
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — sidechain subagent edge cases", () => {
  it("gives an unidentifiable sidechain entry the unattributed row its tokens are stamped with", async () => {
    // `extractDedupedUsage` stamps this turn's token provenance with
    // UNATTRIBUTED_SUBAGENT_ID via the shared `deriveSidechainSubagentId`, so a
    // row under that id has to exist — otherwise the session reports tokens
    // belonging to a subagent it does not list. The pre-rewrite core derived the
    // id inline instead of through the shared helper and returned null here,
    // producing exactly that orphan; FEA-3597 introduced the shared helper to
    // make the two impossible to disagree.
    const noIdSidechainLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:02.000Z",
      isSidechain: true,
      // No agentId, no uuid, no parentUuid, no sessionId
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          {
            type: "tool_use",
            id: "toolu_sc_tool",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
        usage: BASE_USAGE,
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), noIdSidechainLine],
      { sessionId: "sidechain-no-id" }
    );

    const rows = session?.subagents ?? [];
    expect(rows.map((agent) => agent.id)).toEqual([UNATTRIBUTED_SUBAGENT_ID]);
    // The point of the row: every stamped provenance resolves to one.
    const stamped = new Set(
      (session?.tokenSeries ?? [])
        .map((point) => point.subagentId)
        .filter((id): id is string => typeof id === "string")
    );
    expect([...stamped]).toEqual([UNATTRIBUTED_SUBAGENT_ID]);
    for (const id of stamped) {
      expect(rows.some((agent) => agent.id === id)).toBe(true);
    }
  });

  it("folds a repeated agentId into the existing subagent rather than a second record", async () => {
    // the second entry resolves to the SAME id, so `existing` is
    // found and `!existing.parentId` is true. What it assigns is null, by design:
    // `parentId` is only read from `parentUuid` when the id came from `uuid`
    // (`!providerAgentId && idFromUuid`), and here `agentId` supplies the
    // identity. So the observable contract of this branch is the fold itself —
    // one record, not two — and a `parentId` that stays null even though the
    // second entry carries a `parentUuid`.
    const childAgentId = "cc11223344556677";
    const line1 = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:02.000Z",
      isSidechain: true,
      agentId: childAgentId,
      // No uuid/parentUuid on first appearance → parentId = null
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          { type: "tool_use", id: "toolu_1a", name: "Read", input: {} },
        ],
        usage: BASE_USAGE,
      },
    });
    const line2 = JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-09T12:00:03.000Z",
      isSidechain: true,
      agentId: childAgentId,
      // Second appearance with same agentId (existing will be found)
      uuid: "second-uuid",
      parentUuid: "parent-of-second",
      message: {
        role: "assistant",
        model: "claude-opus-4",
        content: [
          { type: "tool_use", id: "toolu_2a", name: "Bash", input: {} },
        ],
        usage: BASE_USAGE,
      },
    });

    const session = await parseClaudeTranscript([userLine(), line1, line2], {
      sessionId: "sidechain-existing",
    });

    const subagents = session?.subagents ?? [];
    // One subagent, not two — the second entry folded into the existing record.
    expect(subagents).toHaveLength(1);
    const subagent = subagents.find((s) => s.id === `agent-${childAgentId}`);
    expect(subagent).toBeDefined();
    // `parentUuid` is NOT promoted when `agentId` owns the identity.
    expect(subagent?.parentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isApiErrorMessage — top-level error format (alternative path)
// ---------------------------------------------------------------------------

describe("parseClaudeTranscript — isApiErrorMessage error entries", () => {
  it("records an API error from an entry with isApiErrorMessage=true", async () => {
    const apiErrorLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      isApiErrorMessage: true,
      error: "overloaded_error",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Overloaded — please try again later." },
        ],
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), apiErrorLine],
      { sessionId: "api-error-message-type" }
    );

    expect(session?.apiErrors).toHaveLength(1);
    expect(session?.apiErrors[0]?.type).toBe("overloaded_error");
    expect(session?.apiErrors[0]?.message).toContain("Overloaded");
  });

  it("does not record an API error for the same entry without the flag", async () => {
    // Paired control: identical entry minus `isApiErrorMessage` is an ordinary
    // user turn, so the assertion above is driven by the flag.
    const plainLine = JSON.stringify({
      type: "user",
      timestamp: "2026-07-09T12:00:00.000Z",
      error: "overloaded_error",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Overloaded — please try again later." },
        ],
      },
    });

    const session = await parseClaudeTranscript(
      [userLine(), assistantLine(), plainLine],
      { sessionId: "api-error-no-flag" }
    );

    expect(session?.apiErrors).toHaveLength(0);
  });
});
