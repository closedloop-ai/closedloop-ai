/**
 * @file managed-pop-signing-readiness.ts
 * @description The pure mapping from a connection's security mode (plus the
 * stored API key's provenance) to the managed proof-of-possession signing
 * readiness a loop command is prepared with.
 *
 * Extracted from `app.ts` (ISS-5387) because it is a total, side-effect-free
 * function of two inputs that had no reason to live inside the application
 * class, and `app.ts` is a grandfathered shrink-only file. Here it is unit
 * testable on its own and the exhaustive `switch` over
 * {@link ConnectionSecurityMode} keeps a newly added mode a compile error rather
 * than a silent fall-through.
 */

import { ConnectionSecurityMode } from "../../shared/connection-security.js";
import type { ApiKeyProvenance } from "../../shared/contracts.js";
import type { ManagedPopSigningReadiness } from "../loop/loop-command-preparer.js";

/**
 * Readiness per security mode, expressed as a total lookup rather than a
 * `switch`.
 *
 * The `satisfies Record<ConnectionSecurityMode, …>` is what keeps this
 * exhaustive: a newly added mode fails `tsc` here until it is deliberately
 * mapped. A `switch` would have needed a `default` clause (Biome's
 * `useDefaultSwitchClause`), and a default is precisely what silently absorbs a
 * new mode into whatever the fallback happens to be.
 *
 * The stored key's own provenance is consulted ONLY in the `Unconfigured` case —
 * in every other mode the security mode already determines the provenance the
 * command must be prepared under — so the table is keyed by a function of it.
 */
const READINESS_BY_MODE = {
  [ConnectionSecurityMode.Enhanced]: () => ({
    provenance: "DESKTOP_MANAGED" as const,
    signingReady: true,
    reason: "ready" as const,
  }),
  [ConnectionSecurityMode.SigningUnavailable]: () => ({
    provenance: "DESKTOP_MANAGED" as const,
    signingReady: false,
    reason: "signing_unavailable" as const,
  }),
  [ConnectionSecurityMode.Unconfigured]: (provenance: ApiKeyProvenance) => ({
    provenance,
    signingReady: false,
    reason: "missing_signer" as const,
  }),
  [ConnectionSecurityMode.Standard]: () => ({
    provenance: "USER_CREATED" as const,
    signingReady: false,
    reason: "user_created_key" as const,
  }),
} satisfies Record<
  ConnectionSecurityMode,
  (provenance: ApiKeyProvenance) => ManagedPopSigningReadiness
>;

/** Resolve signing readiness for the active connection. */
export function resolveManagedPopSigningReadiness(input: {
  mode: ConnectionSecurityMode;
  provenance: ApiKeyProvenance;
}): ManagedPopSigningReadiness {
  return READINESS_BY_MODE[input.mode](input.provenance);
}
