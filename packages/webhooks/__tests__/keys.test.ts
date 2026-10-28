import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "../keys";

describe("packages/webhooks keys", () => {
  const originals = new Map<string, string | undefined>();
  let consoleError: ReturnType<typeof spyOnValidationReport>;

  beforeEach(() => {
    for (const name of MANAGED_VARS) {
      originals.set(name, process.env[name]);
      Reflect.deleteProperty(process.env, name);
    }
    consoleError = spyOnValidationReport();
  });

  afterEach(() => {
    for (const [name, value] of originals) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
    originals.clear();
    consoleError.mockRestore();
  });

  it.each(["sk_live_abc123", "testsk_abc123"])(
    "accepts the %s token shape",
    (token) => {
      process.env.SVIX_TOKEN = token;

      expect(keys().SVIX_TOKEN).toBe(token);
      expect(consoleError).not.toHaveBeenCalled();
    }
  );

  // A token with the wrong prefix is the reachable failure: an operator pasting
  // a key from a different service would otherwise be handed to the Svix client
  // and fail at request time instead of at boot.
  it.each(["whsec_abc123", "sk-abc123", "abc123"])(
    "rejects the %s token shape",
    (token) => {
      process.env.SVIX_TOKEN = token;

      expect(() => keys()).toThrow("Invalid environment variables");
      expect(consoleError).toHaveBeenCalled();
    }
  );

  it("treats an unset token as undefined so the package can degrade", () => {
    expect(keys().SVIX_TOKEN).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("treats an empty string as unset rather than as a validation failure", () => {
    process.env.SVIX_TOKEN = "";

    expect(keys().SVIX_TOKEN).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

// `SKIP_ENV_VALIDATION` is cleared alongside the token: inherited from the shell
// or a CI lane it short-circuits `createEnv`, and every rejection case above
// would stop exercising the schema.
const MANAGED_VARS = ["SVIX_TOKEN", "SKIP_ENV_VALIDATION"] as const;

/**
 * t3-env's default handler prints the per-field issues and then throws a generic
 * `Invalid environment variables`, so the console call is the only signal that
 * the schema — rather than something ambient — rejected the value.
 */
function spyOnValidationReport() {
  return vi.spyOn(console, "error").mockImplementation(() => {
    // silence the expected validation report
  });
}
