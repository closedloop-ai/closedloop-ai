import { describe, expect, it } from "vitest";
import { catalogTargetKindToComponentKind } from "./catalog-component-kind";
import { AgentComponentKind } from "./types/agent-component";

describe("catalogTargetKindToComponentKind", () => {
  it("canonicalizes the catalog's `agent` to AgentComponentKind.Subagent", () => {
    // The catalog stores a subagent's kind as the literal `"agent"`; the F1
    // fingerprint/registry must see the canonical `subagent` so a pack-imported
    // agent dedupes with a device-synced subagent of identical bytes.
    expect(catalogTargetKindToComponentKind("agent")).toBe(
      AgentComponentKind.Subagent
    );
  });

  it("passes through catalog kinds that already equal their AgentComponentKind value", () => {
    // Every non-agent catalog kind already matches its canonical value.
    expect(catalogTargetKindToComponentKind("skill")).toBe(
      AgentComponentKind.Skill
    );
    expect(catalogTargetKindToComponentKind("command")).toBe(
      AgentComponentKind.Command
    );
    expect(catalogTargetKindToComponentKind("hook")).toBe(
      AgentComponentKind.Hook
    );
    expect(catalogTargetKindToComponentKind("mcp")).toBe(
      AgentComponentKind.Mcp
    );
  });

  it("folds an unrecognized kind under its own literal (never crashes an import/backfill)", () => {
    expect(catalogTargetKindToComponentKind("totally-unknown")).toBe(
      "totally-unknown"
    );
  });

  it("does not resolve inherited object keys (prototype-pollution-safe alias table)", () => {
    // The alias table is a null-prototype object, so a `targetKind` of
    // `"constructor"`/`"__proto__"` falls through to the passthrough branch
    // instead of hitting an inherited property.
    expect(catalogTargetKindToComponentKind("constructor")).toBe("constructor");
    expect(catalogTargetKindToComponentKind("__proto__")).toBe("__proto__");
  });
});
