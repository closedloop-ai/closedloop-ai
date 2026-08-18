/**
 * The single cross-surface flag key gating the GridTable v2 pass — the shared
 * `GridTable` enhancements hoisted out of the `generic-artifact` prototype:
 * the per-column options menu (sort / filter / group / move), hover-revealed
 * sort affordances, row selection and row activation, click-to-keyboard cell
 * navigation, the leading utility column, and the rows-per-page control.
 *
 * ## Why ONE key for the whole pass, and not one per ticket
 *
 * These enhancements ship on the SHARED `GridTable` primitive, which Sessions,
 * Branches, Agents, Routines, Packs, Documents, and the Compliance tab all
 * render. A per-ticket key would mean a build where a table has the new column
 * menu but the old sort affordance, or selection styling with no keyboard
 * navigation to reach it — combinations nobody designed, tested, or reviewed.
 * Divergent table behavior across surfaces is a worse failure than one larger,
 * deliberate flip, so the whole pass flips together.
 *
 * The corollary is that this key gates the shared component's BEHAVIOR, not any
 * single screen: every consumer inherits the same state at the same time. That
 * is the intent, not an accident of implementation.
 *
 * ## Relationship to `sessions-grid-fold-legibility`
 *
 * The two are INDEPENDENT and compose: that key governs how the Sessions grid's
 * columns are FITTED (fold snapping, settle damping, scroll affordance); this
 * one governs what a column HEADER and a ROW can do. Neither is inert without
 * the other and neither modulates the other's template maths — they can be on
 * or off in any combination.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `GRID_TABLE_V2_FEATURE_FLAG_KEY` (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_GRID_TABLE_V2_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`).
 *
 * Importing one constant on both sides means a future rename touches a single
 * definition — it can't silently split PostHog and Desktop the way two parallel
 * string literals could. The desktop parity tests assert each surface alias
 * resolves to this constant, and that the desktop default is OFF.
 */
export const GRID_TABLE_V2_FLAG_KEY = "grid-table-v2" as const;
