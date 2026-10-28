/**
 * PRD-730 `batch-fs-agent-ops` (ISS-4779 closed-by-default policy): the single
 * cross-surface key gating the agent-operations surfaces' move to
 * complete-surface ownership.
 *
 * ## What it gates
 *
 * OFF — the default — each agent-operations route keeps the composition that
 * ships today: the shells mount the existing workspace component and supply the
 * slots and seeds it exposes. ON, the route mounts the batch's named complete
 * surface instead, which owns its toolbar, filters, metric strip, table, state
 * ladder and pagination outright and takes only host-boundary seams. ISS-9398
 * establishes the key for `AgentsListSurfaceV2`.
 *
 * ## Why ONE key for the batch, and not one per ticket
 *
 * The batch's value is that a reader gets the SAME surface on web and desktop,
 * so the thing that must flip together is the ownership change, not each
 * ticket's slice of it. A per-ticket key would produce builds where one
 * agent-operations route is a complete surface and its sibling is still
 * host-composed — combinations nobody designed or reviewed, and exactly the
 * cross-surface divergence PRD-730 exists to end.
 *
 * It is deliberately NOT `grid-table-v2`. That key gates the shared
 * `GridTable` primitive's BEHAVIOR for every consumer in the repo (Grid Parity);
 * this one gates WHICH COMPONENT a route mounts. Reusing it would tie an
 * unrelated table-primitive rollout to this batch's cutover in both directions.
 *
 * ## One key, both shells
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so both shells import the SAME literal instead of
 * redeclaring it. Web reads it as a PostHog flag via
 * `AGENT_OPS_COMPLETE_SURFACE_FEATURE_FLAG_KEY`; the desktop renderer resolves
 * the signed-in account's PostHog assignment from the same key space and
 * nothing else, so there is no desktop alias, no Labs toggle and no
 * flag-registry entry beside this key. ISS-9398 records why.
 */
export const AGENT_OPS_COMPLETE_SURFACE_FLAG_KEY =
  "agent-ops-complete-surface" as const;
