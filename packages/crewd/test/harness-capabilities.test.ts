/**
 * The pure `HARNESS_CAPABILITIES` map (used by the renderer-safe broker) must
 * agree with the concrete drivers' own `capabilities`, so the two SSOTs cannot
 * drift. This is a Node-only test (it imports the concrete drivers), separate
 * from the renderer-safety guard.
 */
import { describe, expect, it } from "vitest";
import {
  availableModelsOf,
  HARNESS_CAPABILITIES,
  nativeScheduleOf,
} from "../src/harness/capabilities.js";
import { defaultRegistry } from "../src/harness/index.js";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  HarnessName,
  NativeSchedule,
} from "../src/model.js";

describe("harness capability parity", () => {
  it("mirrors every concrete driver's declared nativeSchedule", () => {
    for (const name of Object.values(HarnessName)) {
      expect(HARNESS_CAPABILITIES[name].nativeSchedule).toBe(
        defaultRegistry[name].capabilities.nativeSchedule
      );
      expect(nativeScheduleOf(name)).toBe(
        defaultRegistry[name].capabilities.nativeSchedule
      );
    }
  });

  it("exposes the pure model maps as each harness's capabilities", () => {
    for (const name of Object.values(HarnessName)) {
      expect(HARNESS_CAPABILITIES[name].availableModels).toEqual(
        AVAILABLE_MODELS[name]
      );
      expect(HARNESS_CAPABILITIES[name].defaultModel).toBe(DEFAULT_MODEL[name]);
      // The pure lookup agrees with the concrete driver's declared capability.
      expect(availableModelsOf(name)).toEqual(
        defaultRegistry[name].capabilities.availableModels
      );
      // A harness's default model must be a member of its enumerated models,
      // so a UI picker never lands on an out-of-list default.
      expect(HARNESS_CAPABILITIES[name].availableModels).toContain(
        DEFAULT_MODEL[name]
      );
    }
  });

  it("enumerates a non-empty model list per harness (UI picker source)", async () => {
    for (const name of Object.values(HarnessName)) {
      const models = await defaultRegistry[name].listModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models).toEqual(AVAILABLE_MODELS[name]);
    }
  });

  it("pins codex to NativeSchedule.None — no native-local scheduler by design (FEA-4070)", () => {
    // Codex is `codex exec` (one-shot) with only a CLOUD scheduling surface, so it
    // has no native-local scheduling target and must stay daemon-driven. The first
    // assertion is the invariant: codex's declared capability is `None`, so
    // reintroducing a codex-native schedule fails this contract test as well as the
    // broker's `defaultTaskRoute` never-guard. The remaining two are access-path
    // checks — `nativeScheduleOf` and the concrete `codexHarness.capabilities` both
    // read the same `HARNESS_CAPABILITIES[Codex]` object, so they assert those
    // accessors resolve to that pinned value, not an independent SSOT.
    expect(HARNESS_CAPABILITIES[HarnessName.Codex].nativeSchedule).toBe(
      NativeSchedule.None
    );
    expect(nativeScheduleOf(HarnessName.Codex)).toBe(NativeSchedule.None);
    expect(defaultRegistry[HarnessName.Codex].capabilities.nativeSchedule).toBe(
      NativeSchedule.None
    );
  });
});
