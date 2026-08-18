/**
 * FEA-3982 (PLN-1494 Slice 1) — SourceOccurrenceType extension + skew-safe
 * normalization contract. Asserts the const object carries the new provenance
 * kinds AND that an unknown/absent value degrades to `Local` (never crashes,
 * never surfaces a raw unknown provenance), per the version-skew guardrail.
 */
import { describe, expect, it } from "vitest";
import {
  DefinitionVersionEditorRole,
  normalizeSourceOccurrenceType,
  SourceOccurrenceType,
} from "./agent-component";
import { ComponentScope } from "./component-scope";

describe("SourceOccurrenceType", () => {
  it("carries the FEA-3290 trio plus the four FEA-3982 provenance kinds", () => {
    expect(SourceOccurrenceType).toMatchObject({
      Repository: "repository",
      Local: "local",
      Pack: "pack",
      StaticFile: "static_file",
      Distributed: "distributed",
      BuiltinClaude: "builtin_claude",
      BuiltinCodex: "builtin_codex",
    });
  });
});

describe("normalizeSourceOccurrenceType (skew-safe)", () => {
  it("passes through every known value unchanged", () => {
    for (const value of Object.values(SourceOccurrenceType)) {
      expect(normalizeSourceOccurrenceType(value)).toBe(value);
    }
  });

  it("degrades an unknown, empty, null, or undefined value to Local", () => {
    expect(normalizeSourceOccurrenceType("something_from_a_newer_peer")).toBe(
      SourceOccurrenceType.Local
    );
    expect(normalizeSourceOccurrenceType("")).toBe(SourceOccurrenceType.Local);
    expect(normalizeSourceOccurrenceType(null)).toBe(
      SourceOccurrenceType.Local
    );
    expect(normalizeSourceOccurrenceType(undefined)).toBe(
      SourceOccurrenceType.Local
    );
  });
});

describe("DefinitionVersionEditorRole", () => {
  it("mirrors the DB enum literals", () => {
    expect(DefinitionVersionEditorRole).toMatchObject({
      Discoverer: "discoverer",
      Editor: "editor",
    });
  });
});

describe("ComponentScope (ISS-5009)", () => {
  it("mirrors the scope tokens the desktop deriver writes to agent_components.scope", () => {
    // The literals are load-bearing, not cosmetic: the honest Source projection
    // EMITS `ComponentScope.Project` as a user-visible value and COMPARES
    // `scope === ComponentScope.Project` against rows the desktop wrote with
    // `deriveComponentScope`. A drift here silently reclassifies every
    // project-scoped component and prints the wrong word in the Source column.
    expect(ComponentScope).toMatchObject({
      User: "user",
      Project: "project",
      Plugin: "plugin",
    });
  });
});
