/**
 * @file harness-name.ts
 * @description The harnesses Packs convert-install can target (claude | codex |
 * opencode). Moved here from `@repo/crewd/model` (PRD-797 FR-1) so the
 * convert-install contract survives crewd's removal. Distinct from
 * `@repo/lib/harness` `Harness` (the five collected CLIs) and
 * `agent-component.ts` `Harness` (which adds the synthetic `both`).
 */
import { z } from "zod";

export const HarnessName = {
  Claude: "claude",
  Codex: "codex",
  Opencode: "opencode",
} as const;
export type HarnessName = (typeof HarnessName)[keyof typeof HarnessName];
export const harnessNameSchema = z.enum([
  HarnessName.Claude,
  HarnessName.Codex,
  HarnessName.Opencode,
]);
