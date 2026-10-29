import type { ApiKey } from "@repo/api/src/types/api-key";
import { formatDate } from "../../shared/lib/date-utils";

/**
 * What a key's lifecycle amounts to at a point in time, for the Scope/Status
 * row both API-keys panels render.
 *
 * The STATUS is shared; the TREATMENT is not. The legacy Settings panel and the
 * Settings v2 panel deliberately spend different Badge variants on these three
 * (the v2 panel uses the low-tint set, so a list of ten live keys is not ten
 * saturated pills). Keeping the derivation here and the variant map at each
 * call site is what AGENTS.md asks for when two surfaces intentionally differ:
 * one helper decides the status, so the parallel switches cannot drift about
 * WHICH state a key is in even while they disagree about how to draw it.
 */
export const ApiKeyStatus = {
  Active: "active",
  Expired: "expired",
  Revoked: "revoked",
} as const;

export type ApiKeyStatus = (typeof ApiKeyStatus)[keyof typeof ApiKeyStatus];

export const API_KEY_STATUS_LABEL: Record<ApiKeyStatus, string> = {
  [ApiKeyStatus.Active]: "Active",
  [ApiKeyStatus.Expired]: "Expired",
  [ApiKeyStatus.Revoked]: "Revoked",
};

export function describeApiKeyStatus(key: ApiKey, now: Date): ApiKeyStatus {
  if (key.revokedAt !== null) {
    return ApiKeyStatus.Revoked;
  }
  if (key.expiresAt !== null && new Date(key.expiresAt) <= now) {
    return ApiKeyStatus.Expired;
  }
  return ApiKeyStatus.Active;
}

/**
 * Whether the key can still authenticate a request — the fact the Revoke
 * control is disabled on. Derived from the record rather than from a rendered
 * label, so the button cannot be re-wired by a copy change.
 */
export function isApiKeyActive(key: ApiKey, now: Date): boolean {
  return describeApiKeyStatus(key, now) === ApiKeyStatus.Active;
}

/**
 * A key's timestamp, or an em dash when the field is absent. `lastUsedAt` is
 * null until a key is used, which is a real "never" rather than a missing
 * measurement, so the dash is honest here.
 */
export function formatApiKeyDate(date: Date | null): string {
  return date === null ? "—" : formatDate(date);
}
