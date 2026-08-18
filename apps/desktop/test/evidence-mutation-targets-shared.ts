/**
 * @file evidence-mutation-targets-shared.ts
 * @description FEA-4010: the tiny session/tool builders the evidence-model tests
 * share. Extracted when the AA-09 C1 mutation-target suites moved into their own
 * file (`evidence-model.test.ts` reached the 1,000-line ceiling), so the two files
 * build fixtures identically instead of drifting apart on a one-sided edit.
 */
import { buildSessionEvidence } from "../src/main/collectors/evidence/build-session-evidence.js";
import {
  TOOL_CATEGORY_VALUES,
  ToolCategory,
} from "../src/main/collectors/evidence/evidence-model.js";
import {
  createNormalizedSession,
  type Harness,
  type NormalizedSession,
  type NormalizedToolUse,
} from "../src/main/collectors/types.js";

/** The fixed timestamp every builder stamps, so ordering is deterministic. */
export const TS = "2026-06-07T00:00:00.000Z";

export function tool(
  name: string,
  extra?: Partial<NormalizedToolUse>
): NormalizedToolUse {
  return { name, timestamp: TS, ...extra };
}

export function sessionWith(
  overrides?: Partial<NormalizedSession>
): NormalizedSession {
  return createNormalizedSession({ sessionId: "s", ...overrides });
}

/** The category a single tool lands in, run through the full harness-blind core. */
export function categoryOf(
  harness: Harness,
  t: NormalizedToolUse
): ToolCategory | null {
  const mix = buildSessionEvidence(sessionWith({ toolUses: [t] }), harness)
    .structural.categoryMix;
  const hit = TOOL_CATEGORY_VALUES.filter(
    (c) =>
      c !== ToolCategory.HumanTurn &&
      c !== ToolCategory.DeclaredIntent &&
      c !== ToolCategory.DeclaredPlan &&
      c !== ToolCategory.DeclaredUtility &&
      mix[c] > 0
  );
  return hit.length === 1 ? hit[0] : null;
}
