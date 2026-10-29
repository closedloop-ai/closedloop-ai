/**
 * ISS-5529: the single cross-surface flag key gating the Agents component-detail
 * Branches tab telling the truth about a branch set it never measured.
 *
 * The tab shipped two arms — an attributed `branchName`, or "No branches
 * reference this component yet." — so a payload carrying no complete branch
 * attribution lands on the denial. Same conflation ISS-5363 removed from the
 * Sessions tab and the token-trend chart, missed here because this signal rides
 * a nested field rather than the top-level count that pass was hunting. ON, the
 * tab routes through the shared `resolveUsageSignal` and keeps the unmeasured
 * case apart from the measured zero; OFF (default) it renders exactly as
 * shipped.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module — no Zod, no
 * heavy transitive graph — precisely so every surface imports the SAME literal
 * instead of redeclaring it. That is not hypothetical here: the Electron E2E
 * spec cannot import `packages/app/shared/lib/feature-flags.ts` at all, because
 * that module pulls dozens of extension-less `@repo/api/src/types/*` specifiers
 * and a spec-level import failure aborts the WHOLE desktop-e2e suite at load.
 * A module like this one resolves there (eighteen sibling specs import from
 * `@repo/api/src/types/*.ts`), so both shells' regressions name one constant and
 * a rename cannot silently split them.
 *
 * ONE key for both shells, and only PostHog reads it. `AgentDetail` mounts on
 * the web app AND the packaged desktop renderer, and the renderer resolves the
 * signed-in account's PostHog assignment from this same key space — the ISS-8024
 * local-registry cutover is retired, so there is no Labs toggle to pair with
 * this and no desktop registry shadow entry to add.
 */
export const AGENTS_BRANCH_USAGE_SIGNAL_STATES_FLAG_KEY =
  "agents-branch-usage-signal-states" as const;
