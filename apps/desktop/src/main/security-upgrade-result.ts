import type { ApiKeyRecord } from "./api-key-store.js";

/**
 * Determines whether the security-upgrade provisioning step left Desktop with a
 * managed key. Idempotent cloud retries may return the same key value, so
 * success depends on the post-provisioning provenance rather than token change.
 */
export function isSecurityUpgradeProvisioned(
  currentKey: ApiKeyRecord | null
): boolean {
  return currentKey?.provenance === "DESKTOP_MANAGED";
}
