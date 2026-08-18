/**
 * Pure, transport-neutral harness capability data (no `node:` imports).
 *
 * The scheduling broker only needs to know WHERE a harness can natively hold a
 * schedule — static data, not the runnable driver. Keeping this map here (model
 * types only) lets the broker default to it without importing the concrete
 * `defaultRegistry`, whose drivers reach `harness/exec.ts` → `node:child_process`
 * / `node:fs`. That is what keeps the root barrel (`@repo/crewd`) renderer-safe.
 *
 * This is the single source of truth for each harness's `nativeSchedule`; the
 * concrete drivers (`claudeHarness`, …) declare the same value, and
 * `harness-capabilities.test.ts` pins them in agreement so the two cannot drift.
 */
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  HarnessName,
  NativeSchedule,
} from "../model.js";
import type { HarnessCapabilities } from "./types.js";

export const HARNESS_CAPABILITIES: Record<HarnessName, HarnessCapabilities> = {
  [HarnessName.Claude]: {
    nativeSchedule: NativeSchedule.ClaudeScheduledTasks,
    availableModels: AVAILABLE_MODELS[HarnessName.Claude],
    defaultModel: DEFAULT_MODEL[HarnessName.Claude],
  },
  [HarnessName.Codex]: {
    // Codex has NO native-local scheduler by design (FEA-4070): `codex exec` is a
    // one-shot and its only scheduling surface is CLOUD app-server tasks, so there
    // is no local target to register into. It stays daemon-driven
    // (`TaskRoute.LocalCascade`) — still a valid cascade EXECUTION harness, never a
    // native SCHEDULING target. Keep this `None`; the `defaultTaskRoute` never-guard
    // fails typecheck if a codex-native schedule kind is reintroduced.
    nativeSchedule: NativeSchedule.None,
    availableModels: AVAILABLE_MODELS[HarnessName.Codex],
    defaultModel: DEFAULT_MODEL[HarnessName.Codex],
  },
  [HarnessName.Opencode]: {
    // Opencode likewise has no native-local scheduler — daemon-driven by design.
    nativeSchedule: NativeSchedule.None,
    availableModels: AVAILABLE_MODELS[HarnessName.Opencode],
    defaultModel: DEFAULT_MODEL[HarnessName.Opencode],
  },
};

/** The native-schedule capability of a harness (pure lookup). */
export function nativeScheduleOf(name: HarnessName): NativeSchedule {
  return HARNESS_CAPABILITIES[name].nativeSchedule;
}

/** The best-effort model list a harness can drive (pure lookup, UI picker). */
export function availableModelsOf(name: HarnessName): readonly string[] {
  return HARNESS_CAPABILITIES[name].availableModels;
}
