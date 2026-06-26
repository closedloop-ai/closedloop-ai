import { afterEach, describe, expect, it } from "vitest";
import {
  assertRunnerSecretConfigured,
  getRunnerSecret,
  MIN_SECRET_LENGTH,
  MIN_UNIQUE_SECRET_CHARS,
} from "../runner-jwt-base";

const TEST_ENV_VAR = "TEST_RUNNER_SECRET";
const TOO_WEAK_PATTERN = /too weak/;

function setSecret(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[TEST_ENV_VAR];
  } else {
    process.env[TEST_ENV_VAR] = value;
  }
}

describe("runner-jwt-base", () => {
  afterEach(() => {
    setSecret(undefined);
  });

  describe("assertRunnerSecretConfigured", () => {
    it("throws when the env var is unset", () => {
      setSecret(undefined);
      expect(() => assertRunnerSecretConfigured(TEST_ENV_VAR)).toThrow(
        `${TEST_ENV_VAR} is not configured`
      );
    });

    it("throws when the secret is shorter than the minimum length", () => {
      setSecret("a".repeat(MIN_SECRET_LENGTH - 1));
      expect(() => assertRunnerSecretConfigured(TEST_ENV_VAR)).toThrow(
        `${TEST_ENV_VAR} must be at least ${MIN_SECRET_LENGTH} characters`
      );
    });

    it("throws when the secret lacks character diversity", () => {
      setSecret("a".repeat(MIN_SECRET_LENGTH + 8));
      expect(() => assertRunnerSecretConfigured(TEST_ENV_VAR)).toThrow(
        `${TEST_ENV_VAR} is too weak (not enough character diversity)`
      );
    });

    it("returns void for a sufficiently strong secret", () => {
      setSecret("abcdefghijklmnopqrstuvwxyz123456");
      expect(() => assertRunnerSecretConfigured(TEST_ENV_VAR)).not.toThrow();
      expect(assertRunnerSecretConfigured(TEST_ENV_VAR)).toBeUndefined();
    });
  });

  describe("getRunnerSecret", () => {
    it("returns the encoded secret when valid", () => {
      const secret = "abcdefghijklmnopqrstuvwxyz123456";
      setSecret(secret);
      expect(getRunnerSecret(TEST_ENV_VAR)).toEqual(
        new TextEncoder().encode(secret)
      );
    });

    it("uses the same diversity threshold as the exported constant", () => {
      const justBelowDiverse = "ab".repeat(MIN_SECRET_LENGTH / 2);
      // 2 unique chars — far below MIN_UNIQUE_SECRET_CHARS
      expect(new Set(justBelowDiverse).size).toBeLessThan(
        MIN_UNIQUE_SECRET_CHARS
      );
      setSecret(justBelowDiverse);
      expect(() => getRunnerSecret(TEST_ENV_VAR)).toThrow(TOO_WEAK_PATTERN);
    });
  });
});
