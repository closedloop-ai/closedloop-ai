/**
 * @file ISS-6886: which desktop → cloud agent-session batch versions the CLOUD
 * ACCEPTS, as opposed to the single version a current desktop STAMPS
 * (`AGENT_SESSION_SYNC_SCHEMA_VERSION`, which stays in `agent-session.ts` beside
 * the payload types so no consumer import path moved — it is an alias of
 * {@link AGENT_SESSION_SYNC_SCHEMA_VERSION_V2}, not a second declaration of 2).
 *
 * Each version is its own NAMED HISTORICAL LITERAL, and the accepted tuple is
 * built from those names rather than from the "current" alias. That distinction
 * is the whole point: if the tuple were `[V1, CURRENT]`, the next bump would
 * carry the accepted set along with it and silently drop the version every
 * installed client still stamps — reproducing ISS-6886 with nothing red. Adding
 * a version means adding a `_V<n>` constant AND deciding, explicitly, whether
 * the oldest one leaves the tuple.
 *
 * A sibling module for the same reason `session-status.ts` and
 * `session-status-display.ts` are siblings: this is one small, self-contained
 * cross-repo compatibility contract, and `agent-session.ts` is at the file-size
 * ceiling.
 */
import { AGENT_SESSION_SYNC_SCHEMA_VERSION } from "./agent-session.ts";

/**
 * ISS-6886: the pre-FEA-2718 batch version, still ACCEPTED on ingest.
 *
 * FEA-2718 pinned the API to the literal 2 so a deploy skew would be loud. That
 * assumed a lockstep fleet: an already-installed v1 desktop was rejected with
 * `schema_version_invalid` on every batch, which its sync lane classifies as a
 * lane-wide upgrade-only defer — so nothing it had captured ever reached the
 * cloud until someone upgraded it. The repository's cross-repo compatibility
 * contract forbids requiring installed clients to upgrade in lockstep.
 *
 * v1 differs from v2 in exactly one way: its events carry the turn-text fields
 * `summary` and `data`. Dropping those was always backward-compatible on its own
 * — the non-strict event `z.object` at the boundary strips both before any DB
 * write, so turn text from a stale desktop is never persisted — which is why a
 * v1 batch maps onto the v2 columnar shape with no other transformation and no
 * fabricated values. The version pin, not the field drop, is what broke skew.
 */
export const AGENT_SESSION_SYNC_SCHEMA_VERSION_V1 = 1 as const;

/**
 * The post-FEA-2718 batch version: events carry only columnar metadata, and the
 * cloud transcript archive (FEA-2717) is the sole source of turn/tool detail.
 * The version a current desktop stamps, aliased as
 * `AGENT_SESSION_SYNC_SCHEMA_VERSION` in `agent-session.ts` and mirrored by hand
 * in `apps/desktop/src/main/agent-sync/agent-session-sync-contract.ts`.
 */
export const AGENT_SESSION_SYNC_SCHEMA_VERSION_V2 = 2 as const;

/**
 * ISS-6886: every batch `schemaVersion` the cloud ingest boundary accepts,
 * newest last. One canonical tuple so the Zod boundary, the parsed payload type,
 * and the compile-time agreement guard in
 * `apps/api/lib/desktop-agent-sessions-schema-guards.ts` cannot drift.
 *
 * A version outside this tuple — a future one this build has never seen, or a
 * garbage value — still fails closed with `schema_version_invalid`, which the
 * desktop classifies as a lane-wide, budget-neutral defer.
 */
export const ACCEPTED_AGENT_SESSION_SYNC_SCHEMA_VERSIONS = [
  AGENT_SESSION_SYNC_SCHEMA_VERSION_V1,
  AGENT_SESSION_SYNC_SCHEMA_VERSION_V2,
] as const;

export type AcceptedAgentSessionSyncSchemaVersion =
  (typeof ACCEPTED_AGENT_SESSION_SYNC_SCHEMA_VERSIONS)[number];

/**
 * SSOT guard, not a runtime constant: `agent-session.ts` declares the current
 * version's literal (it is what ~40 consumers import, and moving that export
 * would be churn for no gain), so this annotation is what stops the two from
 * ever disagreeing — `tsc` fails if `AGENT_SESSION_SYNC_SCHEMA_VERSION` stops
 * being {@link AGENT_SESSION_SYNC_SCHEMA_VERSION_V2}. Bumping the current
 * version therefore forces the author to add a `_V<n>` here and decide, in this
 * file, whether the previous one stays accepted — which is exactly the decision
 * FEA-2718 made implicitly and ISS-6886 had to undo.
 */
export const currentAgentSessionSyncSchemaVersion: typeof AGENT_SESSION_SYNC_SCHEMA_VERSION_V2 =
  AGENT_SESSION_SYNC_SCHEMA_VERSION;
