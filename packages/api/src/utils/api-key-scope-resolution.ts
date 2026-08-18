/**
 * ISS-4905: the single source of truth for turning a *stored* API-key scope
 * array into an authorization grant.
 *
 * The rule this module exists to enforce is that an empty, absent, or
 * all-unrecognized scope array is **missing data, not a grant**. Before this
 * module, `effectiveKeyScopes` in `apps/mcp` read `[]` as "every scope" and the
 * `apps/api` scope checks fell back to full access when the scope list was
 * absent — a fail-OPEN authorization default in which the least-specified
 * credential received the most privilege. That inverts the repo's standing
 * rule (`apps/desktop/AGENTS.md`: "Gateway auth must fail closed").
 *
 * The sharp edge is the sanitizer: unrecognized scope strings are dropped, so a
 * key written by a version-skewed peer carrying only scopes this server does not
 * know about sanitizes down to `[]`. Under the old default that minted a
 * full-access credential; here it resolves to `Unresolvable`, which every caller
 * must reject or degrade from. Unknown scope values therefore degrade to a safe
 * default and never widen privilege, and nothing here throws.
 *
 * Callers own the reporting: `resolveApiKeyScopes` stays pure so each surface
 * can log `API_KEY_SCOPES_UNRESOLVABLE_EVENT` with the context it actually has
 * (key id, org, OAuth grant). Every surface emits the same event name so one
 * monitor catches a corrupt credential row wherever it surfaces.
 */

import { API_KEY_SCOPES, type ApiKeyScope } from "../types/api-key.ts";

/**
 * Structured-log event name emitted server-side whenever a stored scope array
 * cannot be resolved to a grant. Keep it identical across surfaces: it is the
 * query key for the corrupt-credential monitor.
 */
export const API_KEY_SCOPES_UNRESOLVABLE_EVENT = "api_key_scopes_unresolvable";

/**
 * Wire `code` on the 401 the internal key-verification endpoint returns when it
 * refuses a key specifically because its stored scope set is unresolvable.
 *
 * Without it the refusal is indistinguishable from "no such key", and the MCP
 * server answers a corrupt credential row with a generic `invalid_client` and
 * revokes the caller's whole refresh-token family — remedies that do not apply.
 * The literal deliberately matches the monitored event name above so one search
 * finds both the log and the response; they stay separate constants because a
 * Datadog event name and an HTTP wire code are independently versioned.
 *
 * Additive and optional: an older client that ignores `code` still sees a 401
 * and degrades to its generic refusal.
 */
export const API_KEY_SCOPES_UNRESOLVABLE_CODE = "api_key_scopes_unresolvable";

export const ApiKeyScopeResolutionStatus = {
  Resolved: "resolved",
  Unresolvable: "unresolvable",
} as const;
export type ApiKeyScopeResolutionStatus =
  (typeof ApiKeyScopeResolutionStatus)[keyof typeof ApiKeyScopeResolutionStatus];

export const ApiKeyScopeUnresolvableReason = {
  /** The column/field was null, undefined, or not an array at all. */
  Absent: "absent",
  /** An array was present but carried zero entries (the DB column default). */
  Empty: "empty",
  /** Entries were present but none survived sanitization (version skew). */
  AllUnrecognized: "all_unrecognized",
} as const;
export type ApiKeyScopeUnresolvableReason =
  (typeof ApiKeyScopeUnresolvableReason)[keyof typeof ApiKeyScopeUnresolvableReason];

export type ApiKeyScopeResolution =
  | {
      status: typeof ApiKeyScopeResolutionStatus.Resolved;
      scopes: ApiKeyScope[];
    }
  | {
      status: typeof ApiKeyScopeResolutionStatus.Unresolvable;
      reason: ApiKeyScopeUnresolvableReason;
      /** How many raw entries were stored, for the monitored log. */
      rawScopeCount: number;
    };

const RECOGNIZED_API_KEY_SCOPES = new Set<string>(API_KEY_SCOPES);

/**
 * Drop unrecognized and duplicate scope strings. Returns `[]` for any input
 * that is not an array — this is a normalizer, never an authorization decision.
 * Use `resolveApiKeyScopes` to decide what a key may actually do.
 */
export function sanitizeApiKeyScopes(scopes: unknown): ApiKeyScope[] {
  if (!Array.isArray(scopes)) {
    return [];
  }
  const recognized = scopes.filter(
    (scope): scope is ApiKeyScope =>
      typeof scope === "string" && RECOGNIZED_API_KEY_SCOPES.has(scope)
  );
  return [...new Set(recognized)];
}

/**
 * Fail-closed resolution of a stored scope array into a privilege grant.
 *
 * Returns `Resolved` only when at least one recognized scope survives. Empty,
 * absent, and all-unrecognized inputs return `Unresolvable` — callers must
 * reject the credential (or drop it to the least privilege they support), never
 * substitute a full-access default.
 */
export function resolveApiKeyScopes(scopes: unknown): ApiKeyScopeResolution {
  if (!Array.isArray(scopes)) {
    return {
      status: ApiKeyScopeResolutionStatus.Unresolvable,
      reason: ApiKeyScopeUnresolvableReason.Absent,
      rawScopeCount: 0,
    };
  }

  const sanitized = sanitizeApiKeyScopes(scopes);
  if (sanitized.length > 0) {
    return {
      status: ApiKeyScopeResolutionStatus.Resolved,
      scopes: sanitized,
    };
  }

  return {
    status: ApiKeyScopeResolutionStatus.Unresolvable,
    reason:
      scopes.length === 0
        ? ApiKeyScopeUnresolvableReason.Empty
        : ApiKeyScopeUnresolvableReason.AllUnrecognized,
    rawScopeCount: scopes.length,
  };
}

/**
 * Whether an already-resolved grant covers every required scope. Kept separate
 * from resolution so the fail-closed branch cannot be skipped by accident.
 */
export function apiKeyScopesInclude(
  granted: readonly ApiKeyScope[],
  required: readonly ApiKeyScope[]
): boolean {
  return required.every((scope) => granted.includes(scope));
}
