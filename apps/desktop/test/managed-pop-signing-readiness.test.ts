/**
 * ISS-5302 — behavioral coverage for `resolveManagedPopSigningReadiness`
 * (`src/main/auth/managed-pop-signing-readiness.ts`), the pure mapper from a
 * connection's security mode plus the stored key's provenance to the managed
 * proof-of-possession readiness a loop command is prepared with.
 *
 * Its docstring says it was extracted from the grandfathered `app.ts` precisely
 * so it could be unit tested; this suite is that extraction paying off. It also
 * loads `src/shared/connection-security.ts` into the node lane, which no other
 * node-lane test does.
 *
 * There is deliberately NO default/unknown arm to cover: the module is a total
 * lookup table guarded by `satisfies Record<ConnectionSecurityMode, …>`, so a
 * newly added mode is a typecheck failure rather than a silent fall-through.
 * The "every arm" assertion below is therefore written as a sweep over
 * `Object.values(ConnectionSecurityMode)`, which fails the moment a mode exists
 * that this suite has no expectation for.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { resolveManagedPopSigningReadiness } from "../src/main/auth/managed-pop-signing-readiness.js";
import type { ManagedPopSigningReadiness } from "../src/main/loop/loop-command-preparer.js";
import { ConnectionSecurityMode } from "../src/shared/connection-security.js";
import type { ApiKeyProvenance } from "../src/shared/contracts.js";

// `ApiKeyProvenance` and `ManagedPopSigningReadinessReason` are bare string
// unions with no runtime const to import, so these annotated constants are the
// closest available contract binding: a renamed member fails typecheck here
// instead of living on as a stale literal inside an assertion.
const USER_CREATED: ApiKeyProvenance = "USER_CREATED";
const DESKTOP_MANAGED: ApiKeyProvenance = "DESKTOP_MANAGED";

/**
 * The expected readiness for every mode, given a `USER_CREATED` stored key.
 * Typed as a total record so a newly added `ConnectionSecurityMode` fails
 * typecheck here too, not only in the production module.
 */
const EXPECTED_FOR_USER_CREATED_KEY: Record<
  ConnectionSecurityMode,
  ManagedPopSigningReadiness
> = {
  [ConnectionSecurityMode.Enhanced]: {
    provenance: DESKTOP_MANAGED,
    signingReady: true,
    reason: "ready",
  },
  [ConnectionSecurityMode.SigningUnavailable]: {
    provenance: DESKTOP_MANAGED,
    signingReady: false,
    reason: "signing_unavailable",
  },
  [ConnectionSecurityMode.Standard]: {
    provenance: USER_CREATED,
    signingReady: false,
    reason: "user_created_key",
  },
  // Only this arm consults the stored key's own provenance; the others are
  // fully determined by the mode.
  [ConnectionSecurityMode.Unconfigured]: {
    provenance: USER_CREATED,
    signingReady: false,
    reason: "missing_signer",
  },
};

describe("resolveManagedPopSigningReadiness", () => {
  test("maps every connection security mode", () => {
    for (const mode of Object.values(ConnectionSecurityMode)) {
      assert.deepEqual(
        resolveManagedPopSigningReadiness({
          mode,
          provenance: USER_CREATED,
        }),
        EXPECTED_FOR_USER_CREATED_KEY[mode],
        `unexpected readiness for mode ${mode}`
      );
    }
  });

  test("only Enhanced reports signing as ready", () => {
    const readyModes = Object.values(ConnectionSecurityMode).filter(
      (mode) =>
        resolveManagedPopSigningReadiness({ mode, provenance: USER_CREATED })
          .signingReady
    );

    assert.deepEqual(readyModes, [ConnectionSecurityMode.Enhanced]);
  });

  test("Unconfigured passes the stored key provenance straight through", () => {
    const managed = resolveManagedPopSigningReadiness({
      mode: ConnectionSecurityMode.Unconfigured,
      provenance: DESKTOP_MANAGED,
    });
    const userCreated = resolveManagedPopSigningReadiness({
      mode: ConnectionSecurityMode.Unconfigured,
      provenance: USER_CREATED,
    });

    // A managed key with no signer must NOT be reported as signing-ready — the
    // provenance travels, the readiness does not.
    assert.deepEqual(managed, {
      provenance: DESKTOP_MANAGED,
      signingReady: false,
      reason: "missing_signer",
    });
    assert.equal(userCreated.provenance, USER_CREATED);
    assert.equal(userCreated.reason, managed.reason);
  });

  test("every other mode ignores the stored key provenance", () => {
    for (const mode of Object.values(ConnectionSecurityMode)) {
      if (mode === ConnectionSecurityMode.Unconfigured) {
        continue;
      }
      assert.deepEqual(
        resolveManagedPopSigningReadiness({
          mode,
          provenance: DESKTOP_MANAGED,
        }),
        resolveManagedPopSigningReadiness({ mode, provenance: USER_CREATED }),
        `mode ${mode} must not vary with the stored key provenance`
      );
    }
  });
});
