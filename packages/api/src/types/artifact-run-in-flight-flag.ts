/**
 * The single PostHog key gating the artifact in-flight run treatment, across
 * every surface it appears on.
 *
 * ONE key rather than one per surface: a run in flight is a single idea, and
 * splitting the gate would let the artifact detail page and the project row
 * disagree about whether the same run is worth mentioning.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module — no Zod, no
 * lucide, no design system — so anything that wants only the KEY can import it
 * without pulling the treatment component's transitive graph: the
 * `apps/app` alias (`ARTIFACT_RUN_IN_FLIGHT_FEATURE_FLAG_KEY` in
 * `packages/app/shared/lib/feature-flags.ts`), a Playwright route fixture, and
 * the project-row follow-up all read the same literal instead of redeclaring
 * it. That is the same reason `artifact-flags.ts` exists.
 *
 * Web-only today: `apps/desktop` has no artifact detail route (its route table
 * covers sessions, branches, agents, insights, and routines), so there is no
 * desktop Labs analogue to keep in parity.
 */
export const ARTIFACT_RUN_IN_FLIGHT_FLAG_KEY =
  "artifact-run-in-flight" as const;
