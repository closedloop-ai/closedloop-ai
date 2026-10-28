/**
 * Route paths for the Packs surface, org-relative — the cross-surface route
 * language of the navigation port (FEA-1518), so web prefixes the org slug
 * through `useOrgPath()` and the desktop renderer consumes them unchanged.
 *
 * Declared here rather than beside either shell's routing so the shared
 * selection hook has one owner for the shape. The two ROUTES do not consume it
 * — the desktop route table spells the `/packs/:id` pattern itself and the web
 * route is an `[id]` directory — so the agreement is pinned by a test
 * (`route-table.test.ts`, "agrees with the shared path builder both shells link
 * through"), not enforced by construction. Renaming this constant moves neither
 * route; changing the SHAPE must update both, and that test is what catches it.
 */

/** The Packs discovery grid. */
export const PACKS_ROUTE_PATH = "/packs";

/** The addressable detail view for one pack. */
export function packDetailPath(packId: string): string {
  return `${PACKS_ROUTE_PATH}/${encodeURIComponent(packId)}`;
}
