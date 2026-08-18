import { describe, expect, it } from "vitest";
import {
  ContextKind,
  capabilitiesForProvider,
  connectorsForProvider,
  fallbackProviderCapabilities,
  modelsForProvider,
  PermissionMode,
  permissionModeOptions,
  providerCapabilities,
  ReasoningEffort,
  RoutineProvider,
  reasoningEffortOptions,
} from "../routine-provider";

describe("providerCapabilities gating", () => {
  it("exposes every Claude-only surface for Claude", () => {
    const claude = providerCapabilities[RoutineProvider.Claude];

    expect(claude.manualTrigger).toBe(true);
    expect(claude.worktree).toBe(true);
    expect(claude.connectors).toBe(true);
    expect(claude.behaviorAutoFix).toBe(true);
    expect(claude.permissionModes).not.toBeNull();
    // Options carry a typed domain value + display label, not display copy as
    // the value: the value is the Claude SDK wire token, the label is UI copy.
    expect(claude.permissionModes).toContainEqual({
      value: PermissionMode.Default,
      label: "Settings default",
    });
    expect(claude.permissionModes?.map((option) => option.value)).not.toContain(
      "Settings default"
    );
    expect(claude.contextKind).toBe(ContextKind.Folder);
    // Claude has no reasoning-effort concept.
    expect(claude.reasoningEffortOptions).toBeNull();
  });

  it("hides every Claude-only surface for Codex and exposes reasoning effort", () => {
    const codex = providerCapabilities[RoutineProvider.Codex];

    expect(codex.manualTrigger).toBe(false);
    expect(codex.worktree).toBe(false);
    expect(codex.connectors).toBe(false);
    expect(codex.behaviorAutoFix).toBe(false);
    expect(codex.permissionModes).toBeNull();
    expect(codex.contextKind).toBe(ContextKind.Project);
    // Codex-only reasoning-effort selector. Options carry the lowercase
    // `model_reasoning_effort` domain value plus display label copy.
    expect(codex.reasoningEffortOptions).not.toBeNull();
    expect(codex.reasoningEffortOptions).toContainEqual({
      value: ReasoningEffort.Medium,
      label: "Medium",
    });
    expect(codex.reasoningEffortOptions?.map((option) => option.value)).toEqual(
      ["minimal", "low", "medium", "high"]
    );
  });

  it("Claude-only fields present for Claude are absent for Codex", () => {
    const claude = capabilitiesForProvider(RoutineProvider.Claude);
    const codex = capabilitiesForProvider(RoutineProvider.Codex);

    const claudeOnly = [
      "manualTrigger",
      "worktree",
      "connectors",
      "behaviorAutoFix",
    ] as const;
    for (const field of claudeOnly) {
      expect(claude[field]).toBe(true);
      expect(codex[field]).toBe(false);
    }

    // permission modes: a non-null list for Claude, null for Codex.
    expect(Array.isArray(claude.permissionModes)).toBe(true);
    expect(codex.permissionModes).toBeNull();
  });

  it("covers both providers exhaustively", () => {
    expect(Object.keys(providerCapabilities).sort()).toEqual(
      Object.values(RoutineProvider).sort()
    );
  });

  it("degrades an unknown provider to the conservative fallback, never undefined", () => {
    // A crewd cascade can drive an execution harness (e.g. `opencode`) that has
    // no Routine provider surface, or a newer build may add a provider this one
    // doesn't know. The lookup must hide every conditional surface rather than
    // return undefined and crash the callers that read `capabilities.<field>`.
    const unknown = capabilitiesForProvider("opencode");

    expect(unknown).toEqual(fallbackProviderCapabilities);
    expect(unknown.manualTrigger).toBe(false);
    expect(unknown.worktree).toBe(false);
    expect(unknown.connectors).toBe(false);
    expect(unknown.behaviorAutoFix).toBe(false);
    expect(unknown.permissionModes).toBeNull();
    expect(unknown.reasoningEffortOptions).toBeNull();
    expect(unknown.contextKind).toBe(ContextKind.Folder);
  });

  it("still resolves known providers to their own record, not the fallback", () => {
    // Guard against the fallback shadowing a real provider.
    expect(capabilitiesForProvider(RoutineProvider.Claude)).toBe(
      providerCapabilities[RoutineProvider.Claude]
    );
    expect(capabilitiesForProvider(RoutineProvider.Codex)).toBe(
      providerCapabilities[RoutineProvider.Codex]
    );
  });
});

describe("modelsForProvider", () => {
  it("returns only Claude models for Claude", () => {
    const models = modelsForProvider(RoutineProvider.Claude);

    expect(models.length).toBeGreaterThan(0);
    expect(
      models.every((model) => model.provider === RoutineProvider.Claude)
    ).toBe(true);
    expect(models.map((model) => model.id)).toContain("opus-4-8");
    expect(models.map((model) => model.id)).not.toContain("gpt-5-6-sol");
  });

  it("returns only Codex models for Codex", () => {
    const models = modelsForProvider(RoutineProvider.Codex);

    expect(models.length).toBeGreaterThan(0);
    expect(
      models.every((model) => model.provider === RoutineProvider.Codex)
    ).toBe(true);
    expect(models.map((model) => model.id)).toContain("gpt-5-6-sol");
    expect(models.map((model) => model.id)).not.toContain("opus-4-8");
  });
});

describe("connectorsForProvider", () => {
  it("returns Claude connectors for Claude", () => {
    const connectors = connectorsForProvider(RoutineProvider.Claude);

    expect(connectors.length).toBeGreaterThan(0);
    expect(
      connectors.every((connector) =>
        connector.availableFor.includes(RoutineProvider.Claude)
      )
    ).toBe(true);
    expect(connectors.map((connector) => connector.id)).toContain("closedloop");
  });

  it("returns no connectors for Codex (connectors are Claude-only)", () => {
    const connectors = connectorsForProvider(RoutineProvider.Codex);

    expect(connectors).toEqual([]);
    // Consistent with the capability gate.
    expect(capabilitiesForProvider(RoutineProvider.Codex).connectors).toBe(
      false
    );
  });
});

describe("permission/reasoning options carry a domain value distinct from the label", () => {
  it("permission-mode option values are the Claude SDK wire tokens", () => {
    expect(permissionModeOptions.map((option) => option.value)).toEqual([
      PermissionMode.Default,
      PermissionMode.Plan,
      PermissionMode.AcceptEdits,
      PermissionMode.BypassPermissions,
    ]);
    // The label is display copy; it is never used AS the domain value.
    for (const option of permissionModeOptions) {
      expect(option.value).not.toBe(option.label);
      expect(Object.values(PermissionMode)).toContain(option.value);
    }
  });

  it("reasoning-effort option values are the model_reasoning_effort tokens", () => {
    expect(reasoningEffortOptions.map((option) => option.value)).toEqual([
      ReasoningEffort.Minimal,
      ReasoningEffort.Low,
      ReasoningEffort.Medium,
      ReasoningEffort.High,
    ]);
    // No display-only tier ("Extra High") that would not survive the boundary.
    for (const option of reasoningEffortOptions) {
      expect(Object.values(ReasoningEffort)).toContain(option.value);
    }
  });
});

describe("capability records are immutable (shared-by-reference safety)", () => {
  it("freezes the Claude capability record and its nested option lists", () => {
    const claude = capabilitiesForProvider(RoutineProvider.Claude);

    // A caller cannot flip a capability for every later reader.
    expect(() => {
      // @ts-expect-error — deeply readonly; runtime must also reject the write.
      claude.connectors = false;
    }).toThrow();
    expect(capabilitiesForProvider(RoutineProvider.Claude).connectors).toBe(
      true
    );

    expect(() => {
      // @ts-expect-error — nested option arrays are frozen too.
      claude.permissionModes?.push({
        value: PermissionMode.Default,
        label: "x",
      });
    }).toThrow();
  });

  it("freezes the fallback capability record", () => {
    expect(() => {
      // @ts-expect-error — the shared fallback floor must not be mutable.
      fallbackProviderCapabilities.worktree = true;
    }).toThrow();
    expect(fallbackProviderCapabilities.worktree).toBe(false);
  });
});
