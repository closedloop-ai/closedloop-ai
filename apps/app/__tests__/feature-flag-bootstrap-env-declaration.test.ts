// @vitest-environment node

/**
 * ISS-9244 — the suppression ships INERT until both variables are DECLARED, and
 * "declared" is decided by `apps/app/env.ts`, not by the predicate.
 *
 * `lib/analytics/__tests__/feature-flag-bootstrap.test.ts` proves the predicate
 * against synthetic triples, and `feature-flag-bootstrap-layout-wiring.test.ts`
 * proves the layout hands it the two live `env` reads. Neither covers the layer
 * between a Vercel project setting and those reads: the schema is where an
 * absent, blank, or malformed value acquires the meaning the predicate then
 * acts on, and it answers the three differently. So this suite drives the real
 * schema and feeds its output to the real predicate — the whole chain the
 * ticket's "ships inert until two env vars are declared" claim is about.
 *
 * Three distinct states, because "not declared" is not one thing:
 *   absent     — no key at all; the schema's `.optional()` yields `undefined`.
 *   empty      — `FOO=""`; `emptyStringAsUndefined` normalizes it to the same
 *                `undefined`, which is why a blank Vercel value is genuinely
 *                equivalent to a commented-out one FOR THESE TWO KEYS.
 *   whitespace — `FOO=" "` survives the parser, and both keys are `z.enum`s, so
 *                it is REJECTED rather than ignored. That is not inertness: the
 *                app refuses to boot. Worth pinning precisely because the other
 *                two states make "undeclared is harmless" look like a rule.
 *
 * `SKIP_ENV_VALIDATION` is cleared for every case, and that is load-bearing
 * rather than hygiene. `vitest.setup.ts` sets it globally, and under it
 * `createEnv` returns `runtimeEnv` untouched — no enum check, no
 * empty-string normalization. A suite that inherited it would watch `""` stay
 * `""` and `" "` sail through, and would pass while proving nothing about the
 * shipped schema.
 *
 * The whitespace case is also this file's anti-vacuity control: it can only
 * throw the ZOD message if the enum is actually running. If
 * `SKIP_ENV_VALIDATION` leaked back in, or the keys stopped being enums, that
 * case fails rather than the negative cases quietly going trivially green —
 * which is why it matches the message and not merely "something threw".
 *
 * It runs under the NODE environment, matching the only place the shipped
 * decision is made: `app/layout.tsx` is a server component. Under the suite's
 * default jsdom, `t3-env` refuses to hand out a server-side variable at all, so
 * every case here would throw for a reason the production path never meets.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapsFeatureFlags } from "@/lib/analytics/feature-flag-bootstrap";

const SIGNAL_KEY = "E2E_SUPPRESS_FEATURE_FLAG_BOOTSTRAP";
const ENVIRONMENT_KEY = "NEXT_PUBLIC_APP_ENVIRONMENT";
const SKIP_KEY = "SKIP_ENV_VALIDATION";
const MANAGED_KEYS = [SIGNAL_KEY, ENVIRONMENT_KEY, SKIP_KEY] as const;

const STAGE_URL = "https://app.stage.example";
const DECLARED_SIGNAL = "true";
const DECLARED_ENVIRONMENT = "stage";
const BLANK = "";
const WHITESPACE = " ";
/** `t3-env`'s message when the schema rejects a value, not when it is absent. */
const INVALID_ENVIRONMENT_VARIABLES = /Invalid environment variables/;

type Declaration = {
  readonly signal?: string;
  readonly environment?: string;
};

let originalValues: ReadonlyMap<string, string | undefined>;

describe("the shipped bootstrap suppression, driven through the real env schema", () => {
  beforeEach(() => {
    originalValues = new Map(
      MANAGED_KEYS.map((key) => [key, process.env[key]])
    );
    // Cleared, not overwritten: under it `createEnv` skips the enum check and
    // the empty-string normalization this file exists to measure.
    Reflect.deleteProperty(process.env, SKIP_KEY);
  });

  afterEach(() => {
    for (const [key, value] of originalValues) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  it("suppresses the bootstrap once BOTH variables are declared — the pinned-flag state", async () => {
    // The positive sibling every negative case below is held against: same
    // subject, opposite state. Without it, "stays true" is satisfiable by a
    // chain that can no longer return false at all.
    await expect(
      bootDecisionFor({
        signal: DECLARED_SIGNAL,
        environment: DECLARED_ENVIRONMENT,
      })
    ).resolves.toBe(false);
  });

  it("keeps the bootstrap when neither variable is declared — inert on an untouched project", async () => {
    await expect(bootDecisionFor({})).resolves.toBe(true);
  });

  it("keeps the bootstrap when both variables are declared BLANK, and resolves them to undefined", async () => {
    await expect(
      bootDecisionFor({ signal: BLANK, environment: BLANK })
    ).resolves.toBe(true);

    // The decision alone cannot tell a normalized blank from a blank the
    // predicate happened to refuse, and they are different failures: only the
    // first makes `FOO=""` genuinely equivalent to a commented-out `FOO` here.
    const env = await loadEnv({ signal: BLANK, environment: BLANK });
    expect(env.E2E_SUPPRESS_FEATURE_FLAG_BOOTSTRAP).toBeUndefined();
    expect(env.NEXT_PUBLIC_APP_ENVIRONMENT).toBeUndefined();
  });

  it("keeps the bootstrap when only the suppression signal is declared", async () => {
    // AC1's "setting only the first leaves the fix inert": the predicate needs
    // an explicit environment too, so a half-applied declaration changes
    // nothing rather than half-engaging.
    await expect(bootDecisionFor({ signal: DECLARED_SIGNAL })).resolves.toBe(
      true
    );
  });

  it("keeps the bootstrap when only the environment is declared", async () => {
    await expect(
      bootDecisionFor({ environment: DECLARED_ENVIRONMENT })
    ).resolves.toBe(true);
  });

  it("REFUSES TO BOOT on a whitespace value rather than ignoring it", async () => {
    // Whitespace is not normalized, and both keys are enums, so this is the one
    // undeclared-looking state that is not inert. Matched on the validation
    // message, not merely "threw": under jsdom every case here throws a
    // server-variable access error instead, which would make a bare `toThrow`
    // green for a reason production never meets. Asserted on each key
    // separately so a schema that stopped validating either one fails here.
    await expect(
      loadEnv({ signal: WHITESPACE, environment: DECLARED_ENVIRONMENT })
    ).rejects.toThrow(INVALID_ENVIRONMENT_VARIABLES);
    await expect(
      loadEnv({ signal: DECLARED_SIGNAL, environment: WHITESPACE })
    ).rejects.toThrow(INVALID_ENVIRONMENT_VARIABLES);
  });
});

/** The two keys set to one declaration state, with absent meaning absent. */
function applyDeclaration(declaration: Declaration): void {
  for (const [key, value] of [
    [SIGNAL_KEY, declaration.signal],
    [ENVIRONMENT_KEY, declaration.environment],
  ] as const) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * The app's real `env` re-validated against one declaration state. `createEnv`
 * runs at module evaluation, so the registry has to be reset for each state —
 * a top-level import would pin whichever state loaded first.
 */
async function loadEnv(declaration: Declaration) {
  applyDeclaration(declaration);
  vi.resetModules();
  const module = await import("@/env");
  return module.env;
}

/** Whether the layout would bootstrap flags, decided by the shipped chain. */
async function bootDecisionFor(declaration: Declaration): Promise<boolean> {
  const env = await loadEnv(declaration);
  return bootstrapsFeatureFlags(
    env.E2E_SUPPRESS_FEATURE_FLAG_BOOTSTRAP,
    env.NEXT_PUBLIC_APP_ENVIRONMENT,
    STAGE_URL
  );
}
