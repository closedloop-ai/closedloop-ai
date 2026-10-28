import type { GitHubDirtyScope } from "@repo/api/src/types/github-dirty-scope";
import {
  GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO,
  GitHubDirtyScopeKind,
  gitHubDirtyScopesValidator,
} from "@repo/api/src/types/github-dirty-scope";

/**
 * The scope-set algebra one dirty-scope row's `dirtyScopes` column is written
 * through: parse an unknown stored value into scopes, merge a publish's scopes
 * into the ones already there, and collapse to the generic refresh when the set
 * stops being worth enumerating.
 *
 * Extracted from `dirty-scope-service.ts` (ISS-10050) to keep that file under
 * the per-file ceiling. Pure and I/O-free — no Prisma, no logging — so the
 * publish path's merge is testable without a database, exactly as
 * `hash-scope-predicates.ts` is on the desktop side.
 */

/** Parse a stored `dirtyScopes` value, falling back to the generic refresh. */
export function normalizeDirtyScopes(value: unknown): GitHubDirtyScope[] {
  const parsed = gitHubDirtyScopesValidator.safeParse(value);
  if (!parsed.success) {
    return [{ kind: GitHubDirtyScopeKind.Generic }];
  }
  return parsed.data;
}

/**
 * Union a publish's scopes with the row's, deduplicated by a key that does not
 * depend on property order. Either side already being generic, or the union
 * outgrowing `GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO`, collapses the whole set
 * to the generic refresh rather than shipping a truncated enumeration.
 */
export function mergeDirtyScopes(
  existingValue: unknown,
  nextScopes: GitHubDirtyScope[]
): GitHubDirtyScope[] {
  const existingScopes =
    existingValue === undefined || existingValue === null
      ? []
      : normalizeDirtyScopes(existingValue);
  if (existingScopes.some(isGenericScope) || nextScopes.some(isGenericScope)) {
    return [{ kind: GitHubDirtyScopeKind.Generic }];
  }
  const byKey = new Map<string, GitHubDirtyScope>();
  for (const scope of [...existingScopes, ...nextScopes]) {
    byKey.set(stableScopeKey(scope), scope);
    if (byKey.size > GITHUB_DIRTY_SCOPE_MAX_SCOPES_PER_REPO) {
      return [{ kind: GitHubDirtyScopeKind.Generic }];
    }
  }
  return [...byKey.values()];
}

export function isGenericScopeSet(
  scopes: readonly GitHubDirtyScope[]
): boolean {
  return scopes.some(isGenericScope);
}

function isGenericScope(scope: GitHubDirtyScope): boolean {
  return scope.kind === GitHubDirtyScopeKind.Generic;
}

function stableScopeKey(scope: GitHubDirtyScope): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(scope).sort(([left], [right]) => left.localeCompare(right))
    )
  );
}
