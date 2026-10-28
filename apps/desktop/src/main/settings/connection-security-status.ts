/**
 * @file connection-security-status.ts
 * @description The Settings → Connection Status security verdict, as a pure
 * decision over its two inputs.
 *
 * Lifted out of `DesktopApplication` (ISS-11426 review): it is a four-branch
 * derivation with no `this` in it beyond two reads, and it was the only thing
 * standing between the verdict and a unit test. `DesktopCredentialStoreAdapter`
 * owns the two reads and calls this (ISS-11681); the ordering — unconfigured,
 * then non-managed, then signing availability — lives here, where it can be
 * exercised without booting an Electron app.
 *
 * `isSigningAvailable` is a THUNK, not a boolean: loading the gateway signing
 * key pair touches the key store, and the first two branches must not pay for
 * a verdict they do not depend on.
 */

import {
  ConnectionSecurityMode,
  type ConnectionSecurityStatus,
} from "../../shared/connection-security.js";
import type { ApiKeyStatus } from "./api-key-store.js";

/** Provenance of a key the desktop minted and manages for itself. */
const DESKTOP_MANAGED_PROVENANCE = "DESKTOP_MANAGED";

export function resolveConnectionSecurityStatus(
  apiKeyStatus: ApiKeyStatus,
  isSigningAvailable: () => boolean
): ConnectionSecurityStatus {
  if (!apiKeyStatus.hasApiKey) {
    return {
      mode: ConnectionSecurityMode.Unconfigured,
      detail: "No cloud API key is configured.",
    };
  }
  if (apiKeyStatus.provenance !== DESKTOP_MANAGED_PROVENANCE) {
    return {
      mode: ConnectionSecurityMode.Standard,
      detail: "Using a manually configured bearer key.",
    };
  }
  if (!isSigningAvailable()) {
    return {
      mode: ConnectionSecurityMode.SigningUnavailable,
      detail: "Managed key is present but request signing is unavailable.",
    };
  }
  return {
    mode: ConnectionSecurityMode.Enhanced,
    detail: "Managed key with request signing is configured.",
  };
}
