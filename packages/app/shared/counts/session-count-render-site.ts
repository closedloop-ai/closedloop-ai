/**
 * @file session-count-render-site.ts
 * @description Which production modules declare each render site (ISS-10585).
 *
 * Nothing tied a member to the code that draws it, so twelve of fourteen were
 * reachable only from the registry and its own tests. Why these live at the HOST
 * rather than in the shared component, and what the accompanying guard does and
 * does not prove, is stated once in `__tests__/session-count-site-wiring.test.ts`.
 *
 * A member maps to MANY modules, never exactly one, so a guard must never assume
 * 1:1. Paths are repo-root-relative because `apps/app` and `apps/desktop` do not
 * depend on each other, so no single suite can import both shells' hosts.
 */
import {
  SESSION_COUNT_SITE,
  type SessionCountSite,
} from "./session-count-population-reconciliation";

/**
 * The modules that name each site. `Record` over the union on purpose: a member
 * added to the enum with no entry here does not typecheck, and an entry for a
 * member the enum no longer has does not either.
 */
export const SESSION_COUNT_SITE_DECLARING_MODULES: Record<
  SessionCountSite,
  readonly string[]
> = {
  [SESSION_COUNT_SITE.SessionsListFooterOrg]: [
    "apps/app/components/agent-sessions/sessions-list-v2-host.tsx",
  ],
  [SESSION_COUNT_SITE.SessionsListFooterThisDevice]: [
    "apps/desktop/src/renderer/components/sessions/sessions-v2-view.tsx",
  ],
  [SESSION_COUNT_SITE.DashboardKpiTileOrg]: [
    "packages/app/insights/components/insights-data-source-provider.tsx",
  ],
  [SESSION_COUNT_SITE.DashboardKpiTileThisDevice]: [
    "apps/desktop/src/renderer/components/insights/desktop-insights-provider.tsx",
  ],
};
