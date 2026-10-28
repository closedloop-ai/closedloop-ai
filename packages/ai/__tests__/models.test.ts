import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAnthropic: vi.fn(),
}));

vi.mock("server-only", () => ({}));
// Spy on the provider factory while still constructing a real provider, so the
// suite can assert the apiKey wiring without stubbing away the module under test.
vi.mock("@ai-sdk/anthropic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ai-sdk/anthropic")>();
  mocks.createAnthropic.mockImplementation(actual.createAnthropic);
  return { ...actual, createAnthropic: mocks.createAnthropic };
});

/** Satisfies the `sk-` prefix `ANTHROPIC_API_KEY` carries in keys.ts. */
const TEST_API_KEY = "sk-ant-iss7084-fixture";
/** Matches the `opus` getter in lib/models.ts. */
const EXPECTED_OPUS_MODEL_ID = "claude-opus-4-5";
/** Matches the `sonnet` getter in lib/models.ts. */
const EXPECTED_SONNET_MODEL_ID = "claude-sonnet-4-6";

describe("packages/ai anthropic provider memoization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // Pin both keys so inherited local or CI env cannot fail keys() validation
    // for a variable this suite does not exercise.
    vi.stubEnv("ANTHROPIC_API_KEY", TEST_API_KEY);
    vi.stubEnv("OPENAI_API_KEY", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("constructs the provider once and returns the cached instance afterwards", async () => {
    const { getAnthropic } = await import("../lib/models");

    const first = getAnthropic();
    const second = getAnthropic();

    expect(first).toBeTypeOf("function");
    expect(second).toBe(first);
    expect(mocks.createAnthropic).toHaveBeenCalledTimes(1);
  });

  it("threads the validated ANTHROPIC_API_KEY into the provider factory", async () => {
    const { getAnthropic } = await import("../lib/models");

    getAnthropic();

    expect(mocks.createAnthropic).toHaveBeenCalledWith({
      apiKey: TEST_API_KEY,
    });
  });

  it("passes an absent ANTHROPIC_API_KEY through as undefined", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    const { getAnthropic } = await import("../lib/models");

    getAnthropic();

    expect(mocks.createAnthropic).toHaveBeenCalledWith({ apiKey: undefined });
  });

  it("builds opus and sonnet from the one shared provider", async () => {
    const { getAnthropic, models } = await import("../lib/models");

    expect(models.opus.modelId).toBe(EXPECTED_OPUS_MODEL_ID);
    expect(models.sonnet.modelId).toBe(EXPECTED_SONNET_MODEL_ID);
    expect(mocks.createAnthropic).toHaveBeenCalledTimes(1);
    expect(getAnthropic()).toBe(mocks.createAnthropic.mock.results[0]?.value);
  });

  it("returns a fresh model object on every getter access", async () => {
    const { models } = await import("../lib/models");

    // Pins current behavior; looks odd because the file exists to memoize, yet
    // only the provider is cached — each `models.opus` read allocates a new
    // model wrapper. Harmless today (the wrapper is stateless), but it means
    // callers must not use identity to compare models.
    expect(models.opus).not.toBe(models.opus);
    expect(mocks.createAnthropic).toHaveBeenCalledTimes(1);
  });
});
