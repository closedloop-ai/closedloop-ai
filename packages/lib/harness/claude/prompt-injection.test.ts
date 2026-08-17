/**
 * ISS-5292 Packet C: branch coverage for `prompt-injection.ts`.
 *
 * The existing `parse-claude-sentinel.test.ts` already covers the common
 * paths. This file covers the three remaining branches:
 *
 * - Branch 7[0] (line 184): `consumeScheduledPrompt(registry, trimmed)`
 *   returns true — the exact text match path that is exercised ONLY when the
 *   raw trimmed text equals a registered prompt.
 *
 * - Branches 10[1] / 11[1] (lines 208-209): no `<command-args>` tag present,
 *   so `argsMatch` is null → args = "" (false arm of ternary) and
 *   typedForm = name (false arm of the args ternary).
 *
 * - Branches 12[1] / 12[2] (lines 212-213): the `||` short-circuits on the
 *   false arm (first consume failed) and the `&&` succeeds on both sides
 *   (slash-prefixed typedForm → strip leading "/" and retry).
 */
import { describe, expect, it } from "vitest";
import type { NormalizedToolUse } from "../types";
import {
  isAutomatedPromptInjection,
  recordScheduledPrompt,
  type ScheduledPromptRegistry,
} from "./prompt-injection";

function makeRegistry(): ScheduledPromptRegistry {
  return { scheduledPrompts: [] };
}

function makeTu(): NormalizedToolUse {
  return { name: "ScheduleWakeup", timestamp: null };
}

describe("isAutomatedPromptInjection — exact text match (Branch 7[0])", () => {
  it("consumes a registered prompt when the raw text matches exactly", () => {
    const registry = makeRegistry();
    const tu = makeTu();
    recordScheduledPrompt(registry, "run the build", tu);

    // Branch 7[0]: consumeScheduledPrompt returns true → true returned immediately.
    expect(isAutomatedPromptInjection(registry, "run the build")).toBe(true);
  });

  it("only consumes once — a second identical injection is NOT suppressed", () => {
    const registry = makeRegistry();
    const tu = makeTu();
    recordScheduledPrompt(registry, "run the build", tu);

    isAutomatedPromptInjection(registry, "run the build"); // consumes the registration
    // Second call: no remaining registration → NOT suppressed.
    expect(isAutomatedPromptInjection(registry, "run the build")).toBe(false);
  });

  it("does not suppress a failed ScheduleWakeup (isError=true skips the registration)", () => {
    const registry = makeRegistry();
    const tu = makeTu();
    tu.isError = true; // FEA-3595: failed call never fires, so the prompt is real
    recordScheduledPrompt(registry, "wakeup prompt", tu);

    expect(isAutomatedPromptInjection(registry, "wakeup prompt")).toBe(false);
  });
});

describe("isAutomatedPromptInjection — slash-command form without args (Branches 10[1], 11[1], 12[1], 12[2])", () => {
  it("strips leading slash and matches when args tag is absent", () => {
    const registry = makeRegistry();
    const tu = makeTu();
    // Register "buildfix" WITHOUT the leading slash (the recorded prompt form).
    recordScheduledPrompt(registry, "buildfix", tu);

    // The harness injects <command-name>/buildfix</command-name> with NO args tag.
    // Inside consumeExactSlashCommandForm:
    //   name = "/buildfix", argsMatch = null → args = "" (Branch 10[1])
    //   typedForm = "/buildfix"              (Branch 11[1], args is falsy)
    //   consumeScheduledPrompt(registry, "/buildfix") → false (Branch 12[1])
    //   typedForm.startsWith("/") → true
    //   consumeScheduledPrompt(registry, "buildfix")  → true  (Branch 12[2])
    const text = "<command-name>/buildfix</command-name>";
    expect(isAutomatedPromptInjection(registry, text)).toBe(true);
  });

  it("does NOT match a second injection after the registration is consumed", () => {
    const registry = makeRegistry();
    const tu = makeTu();
    recordScheduledPrompt(registry, "buildfix", tu);

    const text = "<command-name>/buildfix</command-name>";
    isAutomatedPromptInjection(registry, text); // consumes
    expect(isAutomatedPromptInjection(registry, text)).toBe(false);
  });
});
