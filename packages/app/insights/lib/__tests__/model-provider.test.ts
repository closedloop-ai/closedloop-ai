import { describe, expect, it } from "vitest";
import { OTHER_MODEL_PROVIDER, providerOf } from "../model-provider";

describe("providerOf", () => {
  it("attributes Claude models to Anthropic", () => {
    expect(providerOf("claude-3-opus")).toBe("Anthropic");
  });

  it("attributes gpt models to OpenAI", () => {
    expect(providerOf("gpt-4")).toBe("OpenAI");
  });

  it("attributes codex models to OpenAI", () => {
    expect(providerOf("codex-mini")).toBe("OpenAI");
  });

  it("attributes o1 models to OpenAI", () => {
    expect(providerOf("o1-preview")).toBe("OpenAI");
  });

  it("attributes o3 models to OpenAI", () => {
    expect(providerOf("o3-mini")).toBe("OpenAI");
  });

  it("does not attribute an embedded o1/o3 to OpenAI — the check is startsWith, not includes", () => {
    expect(providerOf("studio1-model")).toBe(OTHER_MODEL_PROVIDER);
    expect(providerOf("piano3-model")).toBe(OTHER_MODEL_PROVIDER);
  });

  it("attributes gemini models to Google", () => {
    expect(providerOf("gemini-pro")).toBe("Google");
  });

  it("falls back to Other for an unrecognized model", () => {
    expect(providerOf("llama-3")).toBe("Other");
  });

  it("matches case-insensitively", () => {
    expect(providerOf("CLAUDE-3")).toBe("Anthropic");
  });

  it("exports the Other bucket as a constant equal to the fallback value", () => {
    expect(OTHER_MODEL_PROVIDER).toBe("Other");
    expect(providerOf("llama-3")).toBe(OTHER_MODEL_PROVIDER);
  });
});
