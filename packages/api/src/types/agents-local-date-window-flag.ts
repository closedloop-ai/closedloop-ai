/**
 * ISS-6888 (ISS-4779 closed-by-default policy): the flag key gating the Agents
 * workspace's date-window comparisons on the DESKTOP LOCAL inventory source —
 * the prior-period delta on the summary cards, and the unwindowed facet universe
 * that keeps an owner or source listed as a zero-count option once the window
 * narrows past its last activity. Default OFF.
 *
 * It gates a ROLLOUT, not a capability. The capability is
 * `AgentComponentsDataSource.honorsDateWindow`, which the local source declares
 * `true` because FEA-3196 made it true: the renderer passes the bounds over IPC
 * unchanged, the main process keeps them, and the usage SQL applies them. This
 * key only withholds that declaration from the shared list until the comparison
 * has been confirmed against real local inventories — with it off, the desktop
 * list renders exactly what it rendered before.
 *
 * WEB IS NOT GATED, deliberately, and this is the one place to say why. The HTTP
 * source has honored the window since FEA-3178 and already renders both, so
 * putting web behind this key would REMOVE a shipped capability rather than
 * withhold a new one. Nothing perceivable changes on web in the change that
 * introduced this key, so web needs no gate and must not get one.
 *
 * WEB-SIDE POSTHOG ONLY, by operator directive (2026-08-30): Labs toggles are
 * deprecated, so this key has no `apps/desktop` alias and the desktop registers
 * no toggle for it. That costs nothing here, because ISS-8753 (2026-09-01) made
 * `DesktopFeatureFlagProvider` resolve the signed-in user's PostHog assignment —
 * the same per-user evaluation the web app reads — so this single key gates the
 * desktop surface directly and cannot drift from a second declaration.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so a `"use client"` renderer can import the literal
 * without pulling a parser in, matching its sibling flag-key modules.
 */
export const AGENTS_LOCAL_DATE_WINDOW_FLAG_KEY =
  "agents-local-date-window" as const;
