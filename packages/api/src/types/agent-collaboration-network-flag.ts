/**
 * The single cross-surface flag key that gates the "Agent Collaboration
 * Network" row on the Insights overview dashboard.
 *
 * History — this gate is DELIBERATELY RE-INTRODUCED. ISS-5061 first shipped it
 * closed-by-default; ISS-5280 (#4482) then retired it to its enabled state as
 * an approved rollout, deleting this module along with the Labs toggle. The
 * operator has since asked for this ONE flag of that batch to come back: the
 * row ships gated again, default OFF, on both surfaces. The other ten flags
 * ISS-5280 retired stay retired — do not treat this file as licence to revive
 * them.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_AGENT_COLLABORATION_NETWORK_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * The overview dashboard is shared through `packages/app`, so both shells draw
 * the same row: one constant on both sides means a rename touches a single
 * definition and cannot silently split PostHog from the desktop Labs toggle.
 */
export const AGENT_COLLABORATION_NETWORK_FLAG_KEY =
  "agent-collaboration-network" as const;
