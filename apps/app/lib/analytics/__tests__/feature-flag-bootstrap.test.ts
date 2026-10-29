/**
 * ISS-9244 — the SSR feature-flag bootstrap can be suppressed for the deployed
 * E2E lane, and only on a target that declares itself non-production AND is not
 * the canonical production host.
 *
 * The decision is executed against synthetic inputs rather than asserted to
 * exist: the whole value of this switch is which of two boots a given
 * (signal, declaration, url) triple selects, and a test that only proved the
 * predicate is called would stay green if it returned a constant.
 */

import { PRODUCTION_APP_HOST } from "@repo/analytics/environment";
import { describe, expect, it } from "vitest";
import { bootstrapsFeatureFlags } from "@/lib/analytics/feature-flag-bootstrap";

const STAGE_URL = "https://app.stage.example";
const PRODUCTION_URL = `https://${PRODUCTION_APP_HOST}`;

describe("bootstrapsFeatureFlags", () => {
  it("bootstraps when no suppression signal is set — the production boot", () => {
    expect(bootstrapsFeatureFlags(undefined, "stage", STAGE_URL)).toBe(true);
    expect(
      bootstrapsFeatureFlags(undefined, "production", PRODUCTION_URL)
    ).toBe(true);
    expect(bootstrapsFeatureFlags(undefined, "development", STAGE_URL)).toBe(
      true
    );
    expect(bootstrapsFeatureFlags(undefined, undefined, STAGE_URL)).toBe(true);
  });

  it("suppresses the bootstrap on a target that declares itself non-production", () => {
    expect(bootstrapsFeatureFlags("true", "stage", STAGE_URL)).toBe(false);
    expect(bootstrapsFeatureFlags("true", "development", STAGE_URL)).toBe(
      false
    );
  });

  it("refuses to suppress in production, so a misplaced env var cannot take effect", () => {
    expect(bootstrapsFeatureFlags("true", "production", PRODUCTION_URL)).toBe(
      true
    );
  });

  it("refuses to suppress on the canonical production host even when the deployment declares itself stage", () => {
    // whitlockk, PR #6683: `NEXT_PUBLIC_APP_ENVIRONMENT` is a hand-set Vercel
    // project setting, so a "stage" marker mis-scoped onto the production
    // project would satisfy the declaration check on its own and open the
    // localStorage fixture window to real visitors on the production host. The
    // host refuses on its own evidence, so the label alone never decides.
    expect(bootstrapsFeatureFlags("true", "stage", PRODUCTION_URL)).toBe(true);
    expect(bootstrapsFeatureFlags("true", "development", PRODUCTION_URL)).toBe(
      true
    );
  });

  it("matches the production host exactly, so a lookalike host is still suppressible", () => {
    // The refusal reuses `isProductionHost`, whose match is an exact hostname
    // and not a substring: a stage preview whose host merely CONTAINS the
    // production host is a legitimate E2E target and must stay suppressible.
    expect(
      bootstrapsFeatureFlags(
        "true",
        "stage",
        `https://${PRODUCTION_APP_HOST}.preview.stage.example`
      )
    ).toBe(false);
  });

  it("refuses to suppress on an UNDECLARED deployment, failing toward the bootstrap", () => {
    // The reason this predicate takes the raw declaration and not
    // `getAppEnvironment()`: that helper answers "stage" for a deployment it
    // could not classify, so keying on it would suppress on exactly the
    // deployment nobody has checked. Absent is not a declaration.
    expect(bootstrapsFeatureFlags("true", undefined, STAGE_URL)).toBe(true);
    expect(bootstrapsFeatureFlags("true", "", STAGE_URL)).toBe(true);
    // A value the schema does not know is likewise not a declaration, so a
    // future environment member stays un-suppressible until added deliberately.
    expect(bootstrapsFeatureFlags("true", "preview", STAGE_URL)).toBe(true);
    expect(bootstrapsFeatureFlags("true", "staging", STAGE_URL)).toBe(true);
  });

  it("treats an explicit 'false' and any other signal value as no signal at all", () => {
    expect(bootstrapsFeatureFlags("false", "stage", STAGE_URL)).toBe(true);
    // The env schema admits only "true" | "false" | undefined, but the value
    // arrives from `process.env` and this predicate is the last thing between it
    // and the boot: anything that is not the exact opt-in keeps the bootstrap.
    expect(bootstrapsFeatureFlags("TRUE", "stage", STAGE_URL)).toBe(true);
    expect(bootstrapsFeatureFlags("1", "stage", STAGE_URL)).toBe(true);
    expect(bootstrapsFeatureFlags("", "stage", STAGE_URL)).toBe(true);
  });
});
