import { patchCachedArtifactField } from "./patch-cached-artifact-field";

/**
 * ISS-8718 — the optimistic half of a session rename, over whatever list,
 * page-data or detail payload the query cache holds.
 *
 * The walk itself is {@link patchCachedArtifactField}, shared with the priority
 * write; everything that walk documents about shape-agnostic matching, never
 * inventing an absent key, and returning the same reference on a miss holds
 * here unchanged.
 *
 * It rewrites the RENDERED name — `AgentSessionListItem.name`, which the API
 * projects as `nameOverride ?? artifacts.name` — and never a `nameOverride`
 * key, because no client shape carries one. That is the same value the write's
 * `expectedName` guard is compared against server-side, so the optimistic row,
 * the guard and the server's own comparison are all reading one field.
 */
export function patchCachedSessionName<T>(
  value: T,
  sessionId: string,
  name: string
): T {
  return patchCachedArtifactField(value, sessionId, "name", name);
}
