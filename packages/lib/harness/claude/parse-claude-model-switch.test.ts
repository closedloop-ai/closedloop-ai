// FEA-4376: a `/model` slash-command switch echoes the switched-to model as
// `<local-command-stdout>Set model to <label></local-command-stdout>`. When a
// session records NO assistant `msg.model` (so `acc.model` stays null), the
// parser must fall back to that human-readable label for `session.model` instead
// of leaving it null (which renders as "Unknown model"). An assistant API model
// id still wins when present. The label is a display name, never a priceable wire
// id — it must not leak into `tokensByModel`.
import { describe, expect, it } from "vitest";
import { ASSISTANT_LINE } from "./parse-claude.test-fixtures";
import { parseClaudeTranscript } from "./parse-claude-core";
import { extractModelSwitchLabel } from "./parse-claude-model-switch-label";

// The harness wraps the label in ANSI bold: ESC[1m … ESC[22m. The parser strips
// the bold markers whether the ESC byte survives or was already stripped to a
// bare `[1m`. Built via char code so no control byte lives in the source text.
const ESC = String.fromCharCode(27);

function modelSwitchLine(label: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: "2026-07-09T12:00:00.000Z",
    cwd: "workspace/myproject",
    message: {
      role: "user",
      content: `<local-command-stdout>Set model to ${label}</local-command-stdout>`,
    },
  });
}

describe("parseClaudeTranscript /model switch model label (FEA-4376)", () => {
  it("uses the /model echo label as session.model when there is no assistant record", async () => {
    const line = modelSwitchLine(`${ESC}[1mOpus 4.8 (1M context)${ESC}[22m`);

    const session = await parseClaudeTranscript([line], {
      sessionId: "model-switch-only",
    });

    expect(session).not.toBeNull();
    // ANSI bold wrappers stripped, clean display name captured.
    expect(session?.model).toBe("Opus 4.8 (1M context)");
    // FEA-4376: the resolved model came from the /model display label, so it is
    // flagged a fallback. The importer keeps the model column COALESCE-sticky for
    // a fallback (fill-only) but overwrites a stored fallback with a real
    // assistant id on a later import (see write-core `freshModelIsRealId`).
    expect(session?.modelIsFallback).toBe(true);
    // No assistant turns, so no priceable model keys — the display-name label
    // must NOT be synthesized into a cost/token key.
    expect(session?.tokensByModel).toEqual({});
    expect(session?.tokensByModel).not.toHaveProperty("Opus 4.8 (1M context)");
    // The echo is recorded as a system message, not a human turn (FEA-3112).
    expect(session?.userMessages).toBe(0);
  });

  it("strips a bare (ESC-less) [1m…[22m wrapper and a trailing (default) marker", async () => {
    const line = modelSwitchLine("[1mSonnet 4.5[22m (default)");

    const session = await parseClaudeTranscript([line], {
      sessionId: "model-switch-default",
    });

    expect(session?.model).toBe("Sonnet 4.5");
  });

  it("keeps a real model id's [1m] 1M-context alias suffix (a lone bare marker is NOT a bold wrapper)", async () => {
    // PR #3903 review (wongk): the frozen corpus has `Set model to
    // claude-sonnet-4-6[1m]`, where `[1m]` is the semantic 1M-context alias — a
    // lone bare `[1m` with no paired `[22m`. It must survive verbatim, not be
    // stripped to a corrupt `claude-sonnet-4-6]`.
    const line = modelSwitchLine("claude-sonnet-4-6[1m]");

    const session = await parseClaudeTranscript([line], {
      sessionId: "model-switch-1m-alias",
    });

    expect(session?.model).toBe("claude-sonnet-4-6[1m]");
    expect(session?.modelIsFallback).toBe(true);
  });

  it("rejects an over-length label so it never poisons the worker boundary", async () => {
    // PR #3903 review (wongk): the label is unbounded transcript text but the
    // worker `.strict()` schema caps `model` at 8,192 chars — a longer label
    // would reject the whole source payload. An over-cap label must be dropped
    // (model stays null), not assigned.
    const line = modelSwitchLine("x".repeat(8193));

    const session = await parseClaudeTranscript([line], {
      sessionId: "model-switch-too-long",
    });

    expect(session?.model).toBeNull();
    // Omitted (not `false`) when no fallback label was resolved.
    expect(session?.modelIsFallback).toBeUndefined();
  });

  it("keeps the last /model switch label when several are echoed (last-wins)", async () => {
    const first = modelSwitchLine("Haiku 4.5");
    const second = modelSwitchLine("Opus 4.8");

    const session = await parseClaudeTranscript([first, second], {
      sessionId: "model-switch-last-wins",
    });

    expect(session?.model).toBe("Opus 4.8");
  });

  it("prefers an assistant msg.model over the /model echo label when both are present", async () => {
    const switchLine = modelSwitchLine("Opus 4.8 (1M context)");

    const session = await parseClaudeTranscript([switchLine, ASSISTANT_LINE], {
      sessionId: "model-switch-and-assistant",
    });

    // Assistant API model id wins; the display label is a fallback only.
    expect(session?.model).toBe("claude-opus-4");
    // FEA-4376: a real assistant id resolved the model, so the fallback flag is
    // OMITTED (not `false`) — the importer treats a model with no fallback flag as
    // authoritative and lets it overwrite a previously stored /model display label.
    expect(session?.modelIsFallback).toBeUndefined();
    // Real wire id keys the token/cost rollup; the display label never does.
    expect(session?.tokensByModel["claude-opus-4"]).toBeDefined();
    expect(session?.tokensByModel).not.toHaveProperty("Opus 4.8 (1M context)");
  });
});

// ISS-5292 Packet C: Branch 0[0] — extractModelSwitchLabel returns null when
// the regex does not match (stdout is NOT a model-switch echo).
describe("extractModelSwitchLabel — non-matching input (Branch 0[0])", () => {
  it("returns null for arbitrary non-model-switch stdout", () => {
    // Branch 0[0]: !match → return null.
    expect(
      extractModelSwitchLabel(
        "<local-command-stdout>git status</local-command-stdout>"
      )
    ).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractModelSwitchLabel("")).toBeNull();
  });
});
