/**
 * localStorage key for the "last time this user opened Agents" marker, per org.
 * The Agents sidebar badge counts sessions finished since this instant, so
 * clearing it on visit is what makes the badge drain to zero.
 *
 * Split out of `use-agents-nav-activity` as a lightweight constants module so
 * a test harness can name the exact key without importing the React hook — a
 * desktop Playwright spec seeds this key before the renderer mounts, and pulling
 * the hook (and React with it) into the spec loader is not an option.
 */
const AGENTS_LAST_VISITED_KEY_PREFIX = "closedloop.app.agents.lastVisitedAt";

/**
 * The marker key for an org, or the un-namespaced key when there is no org. A
 * shared machine with more than one org never drains one person's badge with
 * another's visit; a signed-out surface (the desktop renderer's default) takes
 * the bare-prefix arm.
 */
export function agentsLastVisitedKey(orgId: string | null): string {
  return orgId
    ? `${AGENTS_LAST_VISITED_KEY_PREFIX}.${orgId}`
    : AGENTS_LAST_VISITED_KEY_PREFIX;
}
