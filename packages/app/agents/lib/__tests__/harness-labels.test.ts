import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARNESS_ID,
  resolveHarnessDisplayConfig,
  resolveHarnessLabel,
} from "../harness-labels";

describe("resolveHarnessDisplayConfig", () => {
  it("resolves claude to its label and tone", () => {
    expect(resolveHarnessDisplayConfig("claude")).toEqual({
      label: "Claude",
      tone: "accent",
    });
  });

  it("resolves codex to its label and tone", () => {
    expect(resolveHarnessDisplayConfig("codex")).toEqual({
      label: "Codex",
      tone: "info",
    });
  });

  it("resolves cursor to its label and tone", () => {
    expect(resolveHarnessDisplayConfig("cursor")).toEqual({
      label: "Cursor",
      tone: "warning",
    });
  });

  it("resolves copilot to its label and tone", () => {
    expect(resolveHarnessDisplayConfig("copilot")).toEqual({
      label: "Copilot",
      tone: "success",
    });
  });

  it("resolves opencode to its label and tone", () => {
    expect(resolveHarnessDisplayConfig("opencode")).toEqual({
      label: "OpenCode",
      tone: "muted",
    });
  });

  it("looks up a known harness case-insensitively", () => {
    expect(resolveHarnessDisplayConfig("Claude")).toEqual({
      label: "Claude",
      tone: "accent",
    });
    expect(resolveHarnessDisplayConfig("CODEX")).toEqual({
      label: "Codex",
      tone: "info",
    });
  });

  it("degrades an unrecognized harness to the raw string, not a fabricated label", () => {
    expect(resolveHarnessDisplayConfig("some-future-harness")).toEqual({
      label: "some-future-harness",
      tone: "accent",
    });
  });

  it("falls back to the default harness for null", () => {
    expect(resolveHarnessDisplayConfig(null)).toEqual({
      label: "Claude",
      tone: "accent",
    });
  });

  it("falls back to the default harness for undefined", () => {
    expect(resolveHarnessDisplayConfig(undefined)).toEqual({
      label: "Claude",
      tone: "accent",
    });
  });

  it("falls back to the default harness for an empty string", () => {
    expect(resolveHarnessDisplayConfig("")).toEqual({
      label: "Claude",
      tone: "accent",
    });
  });
});

describe("resolveHarnessLabel", () => {
  it("returns just the label for a known harness", () => {
    expect(resolveHarnessLabel("codex")).toBe("Codex");
  });

  it("returns just the raw string for an unknown harness", () => {
    expect(resolveHarnessLabel("mystery")).toBe("mystery");
  });

  it("returns the default harness's label when given no harness", () => {
    expect(resolveHarnessLabel(undefined)).toBe("Claude");
  });
});

describe("DEFAULT_HARNESS_ID", () => {
  it("is claude", () => {
    expect(DEFAULT_HARNESS_ID).toBe("claude");
  });
});
