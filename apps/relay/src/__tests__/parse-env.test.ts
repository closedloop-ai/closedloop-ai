/**
 * Coverage for the relay's binding of the shared timer clamp.
 *
 * The clamp algorithm itself is owned and exhaustively covered by
 * `packages/shared-platform/src/__tests__/parse-env-ms.test.ts`. What is
 * relay-specific, and what these cases pin, is the WIRING: the invalid-value
 * warning must reach the structured, Datadog-exported `log.warn`, not bare
 * stderr, and the binding must pass the name/default through untouched so the
 * returned value still bounds the `setTimeout`/`setInterval` delay it feeds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePositiveEnvMs } from "../parse-env.js";

const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }));

vi.mock("@repo/observability/log", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    log: {
      ...(actual.log as object),
      warn: (...args: unknown[]) => mockLogWarn(...args),
    },
  };
});

const ENV_NAME = "RELAY_TEST_THRESHOLD_MS";
const DEFAULT_MS = 60_000;

describe("parsePositiveEnvMs (relay binding)", () => {
  let previous: string | undefined;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    previous = process.env[ENV_NAME];
    mockLogWarn.mockReset();
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // Present only to prove the binding does NOT fall through to it.
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, ENV_NAME);
    } else {
      process.env[ENV_NAME] = previous;
    }
  });

  it("returns the default and stays quiet when the variable is unset", () => {
    Reflect.deleteProperty(process.env, ENV_NAME);

    expect(parsePositiveEnvMs(ENV_NAME, DEFAULT_MS)).toBe(DEFAULT_MS);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("passes a valid override through untouched", () => {
    process.env[ENV_NAME] = "1500";

    expect(parsePositiveEnvMs(ENV_NAME, DEFAULT_MS)).toBe(1500);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it.each([
    ["empty string (Number('') === 0, which `??` cannot catch)", ""],
    ["non-numeric", "abc"],
    ["negative", "-1"],
    ["past the 32-bit timer ceiling, which fires immediately", "2147483648"],
  ])(
    "falls back to the default and warns via log.warn, not console, for %s",
    (_label, raw) => {
      process.env[ENV_NAME] = raw;

      expect(parsePositiveEnvMs(ENV_NAME, DEFAULT_MS)).toBe(DEFAULT_MS);
      expect(mockLogWarn).toHaveBeenCalledWith(
        `Invalid ${ENV_NAME}, defaulting to ${DEFAULT_MS}`,
        { value: raw }
      );
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    }
  );
});
