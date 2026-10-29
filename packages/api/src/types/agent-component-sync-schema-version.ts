/**
 * @file ISS-8609: which component-inventory batch versions the CLOUD ACCEPTS on
 * `POST /desktop/components/sync`, as opposed to the single version a current
 * desktop STAMPS.
 *
 * A sibling of `agent-session-sync-schema-version.ts`, built to the same rule
 * because the component lane carried the same hazard. Each version is its own
 * NAMED HISTORICAL LITERAL and the accepted tuple is built from those names,
 * never from the "current" alias: a tuple written `[CURRENT]` carries the
 * accepted set along with the next bump and silently drops the version every
 * installed desktop still stamps — ISS-6886 reproduced with nothing red. Adding
 * a version means adding a `_V<n>` here AND deciding, in this file, whether the
 * oldest one leaves the tuple.
 *
 * WHY IT LIVES IN `packages/api` rather than in either app. The cloud must accept
 * a version before a desktop sends it, so the accepted set and the stamped
 * version are halves of ONE cross-repo contract and cannot be two declarations.
 * Both halves read this module — `apps/api`'s Zod boundary via
 * `desktop-agent-sessions-schema.ts`, and the desktop producer in
 * `apps/desktop/src/main/agent-sync/agent-session-sync-source.ts`. A bump is
 * therefore: add `_V<n>` to {@link ACCEPTED_AGENT_COMPONENT_SYNC_SCHEMA_VERSIONS},
 * deploy the cloud, and only THEN move
 * {@link AGENT_COMPONENT_SYNC_SCHEMA_VERSION}. Doing those in one commit is the
 * breaking change the split exists to prevent.
 */

/**
 * The first component-inventory batch version, and the only one so far.
 *
 * Named rather than inlined so the tuple below can be built from history instead
 * of from whatever is current — see this file's header for why that distinction
 * is the whole point.
 */
export const AGENT_COMPONENT_SYNC_SCHEMA_VERSION_V1 = 1 as const;

/**
 * Every `schemaVersion` the cloud accepts on `POST /desktop/components/sync`,
 * newest last. One canonical tuple, so the Zod boundary, the skew predicate, and
 * the compile-time agreement guard in
 * `apps/api/lib/desktop-agent-sessions-schema-guards.ts` cannot drift.
 *
 * A version outside this tuple fails closed: a well-formed one is SKEW and earns
 * the cursor-holding, coded 400 an API deploy clears; anything else is a batch no
 * deploy will ever accept and takes the 422 an installed desktop dead-letters.
 */
export const ACCEPTED_AGENT_COMPONENT_SYNC_SCHEMA_VERSIONS = [
  AGENT_COMPONENT_SYNC_SCHEMA_VERSION_V1,
] as const;

export type AcceptedAgentComponentSyncSchemaVersion =
  (typeof ACCEPTED_AGENT_COMPONENT_SYNC_SCHEMA_VERSIONS)[number];

/**
 * The version a current desktop STAMPS on the payload it sends.
 *
 * An ALIAS of a named literal, never a second declaration of `1`: that is what
 * lets {@link currentAgentComponentSyncSchemaVersion} hold the two in agreement
 * at compile time.
 */
export const AGENT_COMPONENT_SYNC_SCHEMA_VERSION =
  AGENT_COMPONENT_SYNC_SCHEMA_VERSION_V1;

/**
 * SSOT guard, not a runtime constant. `tsc` fails if
 * {@link AGENT_COMPONENT_SYNC_SCHEMA_VERSION} stops being the named literal it
 * aliases, so bumping the stamped version forces the author to add a `_V<n>`
 * above and decide, here, whether the previous one stays accepted.
 */
export const currentAgentComponentSyncSchemaVersion: typeof AGENT_COMPONENT_SYNC_SCHEMA_VERSION_V1 =
  AGENT_COMPONENT_SYNC_SCHEMA_VERSION;

/**
 * Is `version` a value the wire contract can even carry — a positive safe
 * integer?
 *
 * Everything else (absent, `null`, `"1"`, an object, `1.5`, `0`, a negative, a
 * magnitude past the safe range) is a batch no redeploy will ever make valid, so
 * it must never be mistaken for skew.
 */
function isWireSchemaVersion(version: unknown): version is number {
  return (
    typeof version === "number" && Number.isSafeInteger(version) && version > 0
  );
}

/**
 * Does the cloud accept this `schemaVersion`?
 *
 * `accepted` is a PARAMETER rather than a closed-over constant so the membership
 * branch can be driven at a cardinality the shipped tuple does not yet have. With
 * one accepted version, set membership and equality with a single literal are
 * behaviourally identical, and a test that can only pass the live tuple cannot
 * tell them apart — which is the coverage hole that would surface on the first
 * bump, when nobody can afford it.
 */
export function isAcceptedAgentComponentSyncSchemaVersion(
  version: unknown,
  accepted: readonly number[] = ACCEPTED_AGENT_COMPONENT_SYNC_SCHEMA_VERSIONS
): boolean {
  return (
    isWireSchemaVersion(version) &&
    accepted.some((candidate) => candidate === version)
  );
}

/**
 * Is this `schemaVersion` evidence of version SKEW rather than poison?
 *
 * Skew means "a newer desktop is waiting on an API deploy": a version the wire
 * contract could carry, that this build does not accept. It is the one rejection
 * a deploy can fix, which is what earns it the cursor-holding 400 (ISS-7978).
 * A malformed version is NOT skew — no deploy will ever accept it, so holding the
 * lane for it stalls the lane forever.
 */
export function isAgentComponentSyncSchemaVersionSkew(
  version: unknown,
  accepted: readonly number[] = ACCEPTED_AGENT_COMPONENT_SYNC_SCHEMA_VERSIONS
): boolean {
  return (
    isWireSchemaVersion(version) &&
    !isAcceptedAgentComponentSyncSchemaVersion(version, accepted)
  );
}
