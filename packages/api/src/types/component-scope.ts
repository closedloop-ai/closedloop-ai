/**
 * @file component-scope.ts
 * @description The `agent_components.scope` cascade tokens, in their own leaf
 * module.
 *
 * Split out of `agent-component.ts` by ISS-6232 so `component-source.ts` — which
 * must know that a `plugin` scope is NOT local authorship — can name the member
 * without importing `agent-component.ts`, which imports `component-source.ts`
 * back. `agent-component.ts` re-exports it, so every existing importer is
 * unaffected.
 */

/**
 * ISS-5009: the cascade level a component's definition is installed at — the
 * exact string tokens written to `agent_components.scope` (desktop) and synced
 * to `AgentComponent.scope` (cloud).
 *
 * The scope token is a real, shareable provenance answer ("this came from your
 * user-global config", "this is checked into the project") in a way an install
 * PATH is not, so it is what `AgentComponentHonestSource.source` carries for a
 * scoped component. That makes it a cross-surface contract value rather than an
 * incidental string: it is compared (`scope === ComponentScope.Project`) and
 * emitted (`scope ?? ComponentScope.Project`) by the cloud resolver
 * (`apps/api/app/agent-components/identity.ts`), by the desktop resolver
 * (`apps/desktop/src/main/dashboard/agent-component-honest-source.ts`), and by
 * the fixtures on both sides. Import the member; never repeat the literal.
 *
 * The producing DERIVATION lives on the desktop
 * (`deriveComponentScope` in `apps/desktop/src/main/packs/definition-content-collector.ts`,
 * which still declares its own same-valued copy of this const); this is the
 * shared consumer-side home so `@repo/api`, `@repo/app` and `apps/api` can name
 * the tokens without importing desktop internals.
 *
 * NOT exhaustive over the column: `scope` stays `string | null` on the wire
 * (older desktop builds, and rows that predate the derivation, carry values this
 * const does not name), so consumers must compare against members rather than
 * narrow the column to this type.
 */
export const ComponentScope = {
  /** A user-global definition (e.g. under `<home>/.claude/`). */
  User: "user",
  /** A project-local definition (e.g. under `<project>/.claude/`). */
  Project: "project",
  /** A definition vendored by an installed plugin (`…/.claude/plugins/…`). */
  Plugin: "plugin",
} as const;
export type ComponentScope =
  (typeof ComponentScope)[keyof typeof ComponentScope];
