import { InsightsScope } from "@closedloop-ai/loops-api/insights";

/**
 * The scope toggle's visible strings, kept in a module that pulls in no
 * component runtime.
 *
 * `DashboardScopeControl` renders them and the Electron E2E
 * (`dashboard-scope-organization-read.spec.ts`) locates the control through
 * them, so neither holds its own copy of the words — and so does the web
 * Dashboard suite, since both shells mount the same control. They live HERE
 * rather than beside the component because importing the `.tsx` into an E2E
 * spec aborts the
 * whole suite at load time — the design-system subpath it pulls in resolves in
 * the app bundler and not under the spec loader (apps/desktop/test/AGENTS.md,
 * "Import hazard").
 */
export const DASHBOARD_SCOPE_LABEL = "Scope";

export const SCOPE_TOGGLE_OPTIONS: { label: string; value: InsightsScope }[] = [
  { label: "Me", value: InsightsScope.Me },
  { label: "Organization", value: InsightsScope.Org },
];
