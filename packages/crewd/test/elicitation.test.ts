import { describe, expect, it } from "vitest";
import { detectElicitation } from "../src/harness/elicitation.js";

describe("detectElicitation", () => {
  it("flags a terminal question / awaiting-input ending", () => {
    const cases = [
      // The reviewer's missed case: a direct question as the final line.
      "Which directory should I audit?",
      "Before I proceed, could you tell me which directory you'd like audited?",
      "What would you like me to focus on?",
      "Let me confirm: should I audit the whole repo or just docs?",
      // Explicit interview framing, even phrased as a statement.
      "…then interview me to figure out what I need scheduled and when it should run.",
      // Explicit awaiting-input marker as the final line.
      "I'm blocked and waiting for your input before I begin.",
      "Let me know how you'd like me to proceed.",
      "Please advise which scope to review.",
    ];
    for (const tail of cases) {
      expect(detectElicitation(tail), tail).toBe(true);
    }
  });

  it("does not flag completion prose that merely mentions a question or offers help", () => {
    const cases = [
      // Reviewer's false-positive: a finished run politely offering more help.
      "Completed the audit. Findings written.\nPlease let me know if you want anything else.",
      "I'll confirm the findings file was written, then finish.",
      "Please clarify in the README whether X is supported — filed as a finding.",
      "scanning docs...\nwrote 3 findings to findings.jsonl",
      "Reviewed README.md and AGENTS.md; no mismatches found.",
      "Question of whether the flag is documented — it is, at line 12. No finding.",
      "Completed the audit. Findings written.",
      "",
      "   \n  ",
    ];
    for (const tail of cases) {
      expect(detectElicitation(tail), tail).toBe(false);
    }
  });

  it("only fires on a TERMINAL waiting state, not a mid-run question", () => {
    // A question buried above a large, benign completion tail must not trip the
    // guard — the concern is an attempt that FINISHES asking, so the LAST
    // non-empty line drives the classification.
    const benignTail = "x".repeat(200);
    const tail = `Which directory should I audit?\n${benignTail}\naudit complete. wrote findings.`;
    expect(detectElicitation(tail)).toBe(false);
  });

  it("only scans the trailing window, not an interview mention far above", () => {
    const benignTail = "x".repeat(2000);
    const tail = `let me interview you first\n${benignTail}\naudit complete`;
    expect(detectElicitation(tail)).toBe(false);
  });
});
