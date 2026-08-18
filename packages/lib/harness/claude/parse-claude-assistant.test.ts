/**
 * @file parse-claude-assistant.test.ts
 * @description The `assistant` record's own contract — the widest handler in the
 * parser, and the one with the most behaviour no other suite reaches.
 *
 * Each case states a rule this handler owes its callers. Mutation testing was
 * used to FIND the rules nothing was holding — it is a map of where to look, not
 * the thing under test, and a case that pins an implementation detail rather
 * than a requirement does not belong here however many mutants it kills.
 *
 * The rule that matters most is the SYNTHETIC-turn exclusion: nobody is billed
 * for a locally-generated turn, so it must reach neither the session model nor
 * the token totals. That was asserted nowhere on either side.
 */
import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./parse-claude-core";

const USER_LINE = JSON.stringify({
  type: "user",
  timestamp: "2026-07-09T12:00:00.000Z",
  cwd: "/workspace/project",
  message: { role: "user", content: "go" },
});

const USAGE = { input_tokens: 10, output_tokens: 5 };

/** Top-level per `useTopLevelRegex`. */
const GENERIC_AGENT_NAME_RE = /^Claude subagent /;

function assistant(fields: Record<string, unknown>): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-09T12:00:01.000Z",
    ...fields,
  });
}

describe("a synthetic turn is not billed and does not name the session's model", () => {
  it("ignores `<synthetic>` when choosing the session model", async () => {
    // The harness stamps `<synthetic>` on a turn it produced locally. Taking it
    // as the session model would report a model nobody ran and no price exists
    // for. A real id on a LATER turn must still win.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "local" }],
            usage: USAGE,
          },
        }),
        assistant({
          timestamp: "2026-07-09T12:00:02.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [{ type: "text", text: "real" }],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "synthetic-model" }
    );

    expect(session?.model).toBe("claude-opus-4");
  });

  it("keeps a synthetic turn's usage out of the session's token totals", async () => {
    // The cost half of the same rule. A synthetic turn carries a usage snapshot
    // like any other, and counting it invents spend.
    const syntheticOnly = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "local" }],
            usage: { input_tokens: 999, output_tokens: 999 },
          },
        }),
      ],
      { sessionId: "synthetic-tokens" }
    );

    expect(syntheticOnly?.tokensByModel).toEqual({});
    // The turn is not a billable round-trip either, so it must not inflate the
    // assistant-turn count the dedup map produces.
    expect(syntheticOnly?.assistantMessages).toBe(0);
  });

  it("still bills a real turn in the same transcript", async () => {
    // The paired control: the exclusions above must be about `<synthetic>`, not
    // about the token path being broken.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [{ type: "text", text: "real" }],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "real-tokens" }
    );

    expect(session?.assistantMessages).toBe(1);
    expect(Object.keys(session?.tokensByModel ?? {})).toEqual([
      "claude-opus-4",
    ]);
  });
});

describe("assistant text assembly", () => {
  it("joins multiple text blocks with a newline, not edge to edge", async () => {
    // `join("")` survived every existing test. It matters beyond cosmetics: the
    // inline-plan scanner and the slash-command scanner both run on this joined
    // string, and a heading glued to the line above it stops matching.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "text-join" }
    );

    const assistantMessage = session?.messages.find(
      (message) => message.role === "assistant"
    );
    expect(assistantMessage?.text).toBe("first\nsecond");
  });

  it("treats a non-array content as empty rather than iterating it", async () => {
    // `message.content` is a string on some records. Iterating a string would
    // walk it character by character and manufacture blocks.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: "plain string",
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "text-nonarray" }
    );

    const assistantMessage = session?.messages.find(
      (message) => message.role === "assistant"
    );
    // `null`, not `""` — `truncateText` maps empty to null, so an absent body is
    // one value everywhere rather than two that read the same.
    expect(assistantMessage?.text).toBeNull();
    expect(session?.toolUses).toEqual([]);
  });

  it("records no plan when the text carries none", async () => {
    // The negative half of the inline-plan scan; `if (inlinePlan)` forced to
    // true survived, meaning nothing asserted the ordinary-prose case.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [{ type: "text", text: "Just some ordinary prose." }],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "no-plan" }
    );

    expect(session?.plans).toEqual([]);
  });
});

describe("per-message token counts degrade without failing the transcript", () => {
  it("attaches counts when the snapshot is readable", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        }),
      ],
      { sessionId: "tokens-present" }
    );

    const assistantMessage = session?.messages.find(
      (message) => message.role === "assistant"
    );
    expect(assistantMessage?.tokens).toMatchObject({ input: 10, output: 5 });
  });

  it("drops THIS message's counts on an unreadable snapshot and parses on", async () => {
    // A negative counter is refused by the strict reader. That must cost the one
    // message its display counts, not abort the transcript — the graceful
    // degradation the handler is written for, and previously untested.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [{ type: "text", text: "bad counter" }],
            usage: { input_tokens: -1, output_tokens: 5 },
          },
        }),
        assistant({
          timestamp: "2026-07-09T12:00:02.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [{ type: "text", text: "after" }],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "tokens-invalid" }
    );

    const messages = (session?.messages ?? []).filter(
      (message) => message.role === "assistant"
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.tokens).toBeUndefined();
    // The later record is unaffected — the drop is scoped to the bad snapshot.
    expect(messages[1]?.tokens).toMatchObject({ input: 10, output: 5 });
  });

  it("omits counts entirely when the record carries no usage", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [{ type: "text", text: "no usage" }],
          },
        }),
      ],
      { sessionId: "tokens-absent" }
    );

    const assistantMessage = session?.messages.find(
      (message) => message.role === "assistant"
    );
    expect(assistantMessage?.tokens).toBeUndefined();
  });
});

describe("sidechain rows are built only for sidechain records", () => {
  it("creates no subagent for an ordinary assistant tool call", async () => {
    // `if (!id) return null` — the non-sidechain path. Every tool call runs
    // through the same function, so this is the common case going unasserted.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [
              {
                type: "tool_use",
                id: "toolu_main",
                name: "Read",
                input: { file_path: "a.ts" },
              },
            ],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "no-sidechain" }
    );

    expect(session?.subagents ?? []).toEqual([]);
    expect(session?.toolUses.map((toolUse) => toolUse.name)).toEqual(["Read"]);
    expect(session?.toolUses[0]?.subagentId ?? null).toBeNull();
  });

  it("names an unattributed sidechain agent generically and claims no type", async () => {
    // The conditional spread of rawName/normalizedName/type survived: with no
    // `attributionAgent` those keys must be ABSENT, not present-and-undefined,
    // because the row is persisted and a present key is a claim.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          agentId: "ad00546980b4b4701",
          isSidechain: true,
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [
              {
                type: "tool_use",
                id: "toolu_child",
                name: "Read",
                input: { file_path: "b.ts" },
              },
            ],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "unnamed-sidechain" }
    );

    const agent = session?.subagents?.[0];
    expect(agent?.id).toBe("agent-ad00546980b4b4701");
    expect(agent?.name).toMatch(GENERIC_AGENT_NAME_RE);
    expect(agent).not.toHaveProperty("rawName");
    expect(agent).not.toHaveProperty("type");
  });

  it("uses attributionAgent for the name and type when present", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          agentId: "ad00546980b4b4701",
          isSidechain: true,
          attributionAgent: "code-reviewer",
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [
              {
                type: "tool_use",
                id: "toolu_child",
                name: "Read",
                input: { file_path: "b.ts" },
              },
            ],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "named-sidechain" }
    );

    const agent = session?.subagents?.[0];
    expect(agent?.name).toBe("code-reviewer");
    expect(agent?.rawName).toBe("code-reviewer");
    expect(agent?.normalizedName).toBe("code-reviewer");
    expect(agent?.type).toBe("code-reviewer");
  });
});

/** Parse one assistant turn whose text is `text`, and return its plans. */
async function plansFor(text: string, sessionId: string) {
  const session = await parseClaudeTranscript(
    [
      USER_LINE,
      assistant({
        message: {
          role: "assistant",
          model: "claude-opus-4",
          content: [{ type: "text", text }],
          usage: USAGE,
        },
      }),
    ],
    { sessionId }
  );
  return session?.plans ?? [];
}

describe("inline plan detection is deliberately strict", () => {
  // Mislabelling prose as a plan is worse than missing one, so the rule is BOTH
  // a line that IS a plan heading AND at least two enumerated phase markers.
  // Each case pins one half of that conjunction; the two regexes and the `>= 2`
  // threshold all survived the previous suite untouched.

  it("recognises a plan with a heading and two phases", async () => {
    const plans = await plansFor(
      "# Implementation Plan\n\nPhase 1: carve\nPhase 2: verify",
      "plan-basic"
    );
    expect(plans).toHaveLength(1);
  });

  it("accepts `Step N` markers as well as `Phase N`", async () => {
    const plans = await plansFor(
      "## Plan\n\nStep 1: one\nStep 2: two",
      "plan-steps"
    );
    expect(plans).toHaveLength(1);
  });

  it("requires TWO markers — one is an aside, not a plan", async () => {
    const plans = await plansFor(
      "# Plan\n\nPhase 1: the only one mentioned",
      "plan-one-phase"
    );
    expect(plans).toEqual([]);
  });

  it("requires a heading LINE — prose mentioning a plan does not count", async () => {
    const plans = await plansFor(
      "I think the plan is fine.\nPhase 1: a\nPhase 2: b",
      "plan-no-heading"
    );
    expect(plans).toEqual([]);
  });

  it("does not treat a word merely starting with `plan` as a heading", async () => {
    const plans = await plansFor(
      "Planning\n\nPhase 1: a\nPhase 2: b",
      "plan-prefix-word"
    );
    expect(plans).toEqual([]);
  });

  // ISS-6735. The cases above pin the CONJUNCTION — a heading AND two markers.
  // The cases below pin what each half means, which is where the two ways of
  // getting this wrong live. Being too permissive labels prose as a plan, which
  // the docstring calls the worse failure. Being too strict drops a real plan
  // the model wrote, which is quieter but still loses the artifact the feature
  // exists to capture.

  it("does not treat a sentence ENDING in `the plan` as a heading", async () => {
    // A heading has to BE the line, not end it. This is the shape most likely
    // to be mislabelled in practice — a sentence introducing a plan reads almost
    // identically to a heading announcing one, and the docstring says mislabelling
    // prose is the worse failure. The existing no-heading case above ends in
    // "fine." and so cannot distinguish this rule at all.
    const plans = await plansFor(
      "Before we start, let me lay out the plan\n\nPhase 1: a\nPhase 2: b",
      "plan-anchor-start"
    );
    expect(plans).toEqual([]);
  });

  it("counts markers only at the START of a line", async () => {
    // Markers are enumerated list items, not any mention of a phase. Prose that
    // discusses phases under a genuine heading is a status update, not a plan —
    // and a real heading is present here, so this rule is the only thing that
    // separates the two.
    const plans = await plansFor(
      "## Implementation Plan\n\nWe finished phase 1 of the rollout and phase 2 is queued.",
      "plan-anchor-marker"
    );
    expect(plans).toEqual([]);
  });

  it("counts a multi-DIGIT marker", async () => {
    // A plan that resumes at Phase 10 is still a plan. Long plans are exactly
    // the ones worth capturing, so the marker rule cannot be limited to the
    // single-digit phases a short example happens to use.
    const plans = await plansFor(
      "## Plan\n\nPhase 10: a\nPhase 11: b",
      "plan-multi-digit"
    );
    expect(plans).toHaveLength(1);
  });

  it("counts markers written at any heading depth in range", async () => {
    // Models write markers at whatever depth suits the surrounding document. A
    // marker is a marker regardless of how deeply it is nested.
    const plans = await plansFor(
      "## Plan\n\n###### Phase 1: a\n###### Phase 2: b",
      "plan-marker-depth"
    );
    expect(plans).toHaveLength(1);
  });

  it("recognises a heading the model indented or spaced loosely", async () => {
    // Models emit markdown with inconsistent spacing — indented under a list,
    // extra spaces after the hashes, a double space inside the phrase. A plan is
    // a plan regardless of how it was formatted; the heading rule is about the
    // WORDS on the line, not the whitespace around them.
    const plans = await plansFor(
      "   ##   Implementation   Plan\n\nPhase 1: a\nPhase 2: b",
      "plan-heading-spacing"
    );
    expect(plans).toHaveLength(1);
  });

  it("allows the same spacing latitude on the MARKERS as on the heading", async () => {
    // The same formatting latitude the heading gets. A marker indented under a
    // section, or spaced loosely, is still the model enumerating a step — the
    // two halves of the rule should not disagree about what counts as tidy.
    const plans = await plansFor(
      "## Plan\n\n  ###   Phase   1: a\n  ###   Phase   2: b",
      "plan-marker-spacing"
    );
    expect(plans).toHaveLength(1);
  });

  it("allows a COLON heading suffix, not only a dash", async () => {
    // The suffix case above exercises the em dash alone, so dropping `:` from
    // the `[:—–-]` class leaves it green.
    const plans = await plansFor(
      "Plan: rewrite the parser\n\nPhase 1: a\nPhase 2: b",
      "plan-suffix-colon"
    );
    expect(plans).toHaveLength(1);
  });

  it("allows a heading suffix after a separator", async () => {
    const plans = await plansFor(
      "Plan — rewrite the parser\n\nPhase 1: a\nPhase 2: b",
      "plan-suffix"
    );
    expect(plans).toHaveLength(1);
  });

  it("is case-insensitive on both the heading and the markers", async () => {
    const plans = await plansFor(
      "IMPLEMENTATION PLAN\n\nPHASE 1: a\nphase 2: b",
      "plan-case"
    );
    expect(plans).toHaveLength(1);
  });

  it("records nothing for text with neither heading nor markers", async () => {
    const plans = await plansFor("Just prose about the work.", "plan-none");
    expect(plans).toEqual([]);
  });
});

describe("a sidechain agent claims a parent only when identified by its own uuid", () => {
  it("takes no parent when the record carries a provider agentId", async () => {
    // With a provider id the row's id is NOT this record's uuid, so reading
    // `parentUuid` as the parent could make an agent its own ancestor.
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          agentId: "ad00546980b4b4701",
          uuid: "rec-1",
          parentUuid: "rec-0",
          isSidechain: true,
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "parent-with-provider-id" }
    );

    expect(session?.subagents?.[0]?.parentId).toBeNull();
  });

  it("takes the parentUuid when the row was identified by its own uuid", async () => {
    const session = await parseClaudeTranscript(
      [
        USER_LINE,
        assistant({
          uuid: "rec-1",
          parentUuid: "rec-0",
          isSidechain: true,
          message: {
            role: "assistant",
            model: "claude-opus-4",
            content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
            usage: USAGE,
          },
        }),
      ],
      { sessionId: "parent-from-uuid" }
    );

    expect(session?.subagents?.[0]?.parentId).toBe("rec-0");
  });
});
