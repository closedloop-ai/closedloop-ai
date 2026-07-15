// Intentionally NOT `import "server-only"`. These are pure, side-effect-free
// comparison helpers (no DB / env / secret / Next.js access) that sit in the
// Desktop gateway's import graph (agent-sessions/service → here). The gateway
// runs under tsx outside Next.js, where `server-only` throws at import time —
// see scripts/smoke-desktop-gateway-import.ts. Enforcement lives in WHERE these
// are called (the server-side read services), not in making the module
// un-importable; the helpers carry no tenant data of their own to protect.

/**
 * PRD-510 FR3 (D4) + FR13 org-scoping enforcement (FEA-2734).
 *
 * Single owner of the rule "a resolved entity — or a join-reached child whose
 * org lives on a resolved ancestor — must belong to the authenticated
 * organization" for the cloud read surfaces. Deep-link / by-id read services
 * resolve an entity by id (or reach a child via its parent) and then call
 * `resolveOrgScope` / `resolveOrgScopeVia` BEFORE returning or aggregating, so a
 * cross-org id can never leak data.
 *
 * These are named `resolve*`, not `assert*`: unlike the codebase's throwing
 * `assert*` helpers they RETURN a discriminated `OrgScopeResult` the caller must
 * inspect via `isOrgScopeOwned()` (or by narrowing on `outcome`) — the name is
 * the reminder that a discarded return value is a bug on a tenancy boundary.
 *
 * D4 boundary principle: org is validated once, at the query boundary. Org-wide
 * list/aggregate entry points (the Branches list, token analytics) filter by a
 * direct `organizationId` predicate and do not need this helper; the by-id and
 * join-reached deep-link reads do, because a caller supplies an arbitrary id and
 * the owning org must be proven before any child rows are hydrated.
 *
 * Not-found and cross-org deliberately collapse to a single `NotOwned` outcome
 * that the route maps to 404 — never a 403 and never a distinct "belongs to
 * another org" signal. Existence is itself org-scoped information; a 404 for
 * both means an attacker probing another org's ids learns nothing.
 *
 * This is NOT RBAC ("who *within* an org may see what" — PRD-512 / PRD-511 #7).
 * It enforces only the org tenancy boundary.
 */

export const OrgScopeOutcome = {
  Owned: "owned",
  NotOwned: "not_owned",
} as const;
export type OrgScopeOutcome =
  (typeof OrgScopeOutcome)[keyof typeof OrgScopeOutcome];

/**
 * Discriminated result. On `Owned` the resolved entity is narrowed non-null so
 * callers use `result.value` without re-checking; `NotOwned` carries no payload
 * — the caller maps it to a 404, and existence is itself org-scoped information
 * so the outcome deliberately says nothing about which entity or org.
 */
export type OrgScopeResult<T> =
  | { outcome: typeof OrgScopeOutcome.Owned; value: T }
  | { outcome: typeof OrgScopeOutcome.NotOwned };

function owned<T>(value: T): OrgScopeResult<T> {
  return { outcome: OrgScopeOutcome.Owned, value };
}

function notOwned<T>(): OrgScopeResult<T> {
  return { outcome: OrgScopeOutcome.NotOwned };
}

/**
 * Resolve whether a fetched entity that carries its own `organizationId` belongs
 * to the authenticated org, returning an `OrgScopeResult` the caller must check.
 * Used by direct by-id reads over org-anchored tables (`BranchDetail`/its
 * Artifact, `CommitDetail`, `ArtifactLink`, …). A null / undefined `resource`
 * (id did not resolve) collapses to the same `NotOwned` outcome as a cross-org
 * row.
 */
export function resolveOrgScope<T extends { organizationId: string }>(
  authOrganizationId: string,
  resource: T | null | undefined
): OrgScopeResult<T> {
  if (resource === null || resource === undefined) {
    return notOwned();
  }
  if (resource.organizationId !== authOrganizationId) {
    return notOwned();
  }
  return owned(resource);
}

/**
 * Resolve whether a join-reached child belongs to the authenticated org via its
 * resolved ancestor (e.g. `AgentSessionTokenEvent` → session → artifact,
 * `CommitDetail` → branch artifact, `SessionDetail` → artifact), returning an
 * `OrgScopeResult` the caller must check. The child row itself may not carry
 * `organizationId` (D4: it is reached, not scanned) — the caller passes the
 * already-resolved ANCESTOR (the row whose `organizationId` is the SSOT for this
 * subtree), never a bare org id.
 *
 * Taking the ancestor object rather than a second `organizationId: string` is
 * deliberate misuse-proofing on a tenancy boundary. When the check passes
 * legitimately, `ancestor.organizationId === authOrganizationId` — which is
 * exactly what a bug that passed the auth org for BOTH args would produce, so an
 * `input === input` no-op is indistinguishable from a real match at runtime (it
 * only diverges on the cross-org case, silently marking it owned) and no test
 * can catch it. Requiring the fetched ancestor row makes passing the auth org
 * here a type error instead. A missing child, a missing ancestor, or a
 * mismatched ancestor org all collapse to `NotOwned`.
 */
export function resolveOrgScopeVia<T>(
  authOrganizationId: string,
  ancestor: { organizationId: string } | null | undefined,
  child: T | null | undefined
): OrgScopeResult<T> {
  if (child === null || child === undefined) {
    return notOwned();
  }
  const ancestorOrganizationId = ancestor?.organizationId;
  if (
    ancestorOrganizationId === null ||
    ancestorOrganizationId === undefined ||
    ancestorOrganizationId !== authOrganizationId
  ) {
    return notOwned();
  }
  return owned(child);
}

/** Type guard: narrows an `OrgScopeResult<T>` to its `Owned` branch. */
export function isOrgScopeOwned<T>(
  result: OrgScopeResult<T>
): result is { outcome: typeof OrgScopeOutcome.Owned; value: T } {
  return result.outcome === OrgScopeOutcome.Owned;
}
