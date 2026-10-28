/**
 * ISS-10467 / ISS-10468 — the single cross-surface flag key gating the agent
 * component detail's per-CONTENT-VERSION drill-down and the side-by-side
 * version compare built on it.
 *
 * ONE KEY FOR BOTH TICKETS, DELIBERATELY. Each ticket asks for "its own
 * closed-by-default flag", and two keys would be the wrong reading of that: the
 * compare is not a second surface, it is the same drill-down panel showing two
 * columns instead of one, off the same read and the same version selection.
 * Two keys would make a half-open state reachable — a compare column with no
 * drill-down to open it from, or a drill-down whose compare control resolves to
 * nothing — and would give one feature two rollout ledgers to reconcile. So the
 * panel is gated once, and the compare ships inside the gate it already has.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so BOTH surfaces import the SAME literal instead of
 * redeclaring it. `AgentDetail` mounts on the web app AND the packaged desktop
 * renderer, and the desktop renderer resolves the byte-for-byte-equal key from
 * the signed-in account's PostHog assignment — there is no second desktop key,
 * no Labs toggle to pair with it, and no desktop registry entry (the ISS-8024
 * local-registry cutover is retired). PostHog is the whole gate.
 */
export const AGENTS_VERSION_USAGE_FLAG_KEY =
  "agents-version-usage-drilldown" as const;
