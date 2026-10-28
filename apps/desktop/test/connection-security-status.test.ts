/**
 * The Settings → Connection Status verdict, now that it is a pure decision
 * rather than four branches inside `DesktopApplication` (ISS-11426 review —
 * `app.ts` is grandfathered shrink-only, and this split is what paid for the
 * relink wiring it gained).
 *
 * The ORDER is the contract: an unconfigured key wins over provenance, and
 * provenance wins over signing availability. Each case below pins one rung and
 * supplies an input that would satisfy a later one, so a reordering cannot pass.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveConnectionSecurityStatus } from "../src/main/settings/connection-security-status.js";
import { ConnectionSecurityMode } from "../src/shared/connection-security.js";

const SIGNING_AVAILABLE = () => true;
const SIGNING_UNAVAILABLE = () => false;

describe("resolveConnectionSecurityStatus", () => {
  it("reports unconfigured before anything else, even with a managed provenance", () => {
    const status = resolveConnectionSecurityStatus(
      { hasApiKey: false, source: "none", provenance: "DESKTOP_MANAGED" },
      SIGNING_AVAILABLE
    );

    assert.equal(status.mode, ConnectionSecurityMode.Unconfigured);
  });

  it("reports standard for a user-created key, even with signing available", () => {
    const status = resolveConnectionSecurityStatus(
      { hasApiKey: true, source: "safeStorage", provenance: "USER_CREATED" },
      SIGNING_AVAILABLE
    );

    assert.equal(status.mode, ConnectionSecurityMode.Standard);
  });

  it("reports standard when the provenance is absent, not enhanced", () => {
    // An absent provenance is not a managed key, and reading it as one would
    // claim request signing on a connection that has none.
    const status = resolveConnectionSecurityStatus(
      { hasApiKey: true, source: "safeStorage" },
      SIGNING_AVAILABLE
    );

    assert.equal(status.mode, ConnectionSecurityMode.Standard);
  });

  it("reports signing-unavailable for a managed key whose key pair will not load", () => {
    const status = resolveConnectionSecurityStatus(
      { hasApiKey: true, source: "safeStorage", provenance: "DESKTOP_MANAGED" },
      SIGNING_UNAVAILABLE
    );

    assert.equal(status.mode, ConnectionSecurityMode.SigningUnavailable);
  });

  it("reports enhanced only when the key is managed AND signing loads", () => {
    const status = resolveConnectionSecurityStatus(
      { hasApiKey: true, source: "safeStorage", provenance: "DESKTOP_MANAGED" },
      SIGNING_AVAILABLE
    );

    assert.equal(status.mode, ConnectionSecurityMode.Enhanced);
  });

  it("does not load the key pair for a verdict that cannot depend on it", () => {
    // The thunk touches the gateway key store; the first two rungs must not
    // pay for it.
    let loads = 0;
    resolveConnectionSecurityStatus(
      { hasApiKey: false, source: "none" },
      () => {
        loads++;
        return true;
      }
    );

    assert.equal(loads, 0);
  });
});
