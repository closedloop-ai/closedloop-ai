/**
 * ISS-5808 (ISS-4779 closed-by-default): desktop-only Labs flag (camelCase,
 * persisted `DesktopSettings` field) gating the Requests view's LIVE behavior —
 * the while-mounted re-read of events and jobs, and the copy that distinguishes
 * a failed read from a genuinely empty list.
 *
 * Off by default. With it off the view keeps its previous mount-time-snapshot
 * behavior exactly, so the change cannot reach an installed build until someone
 * opts in. Desktop-only surface: `apps/app` has no Gateway Requests analogue, so
 * per `apps/desktop/AGENTS.md` there is no PostHog counterpart to
 * keep in parity — the Labs toggle is the whole gate.
 *
 * Declared in this LEAF module — no imports, no registry — rather than inline in
 * `feature-flags.ts`, for the same reason as `desktop-docs-help-flag.ts`
 * (ISS-5145): the Electron E2E spec needs this key, and `feature-flags.ts`
 * reaches it through extensionless `@repo/api/src/types/…` specifiers that
 * Playwright's ESM loader cannot resolve — importing the registry from a spec
 * aborts the whole file at load. A leaf keeps the constant reachable from the
 * harness without duplicating the string into a test.
 *
 * IMPORT IT FROM HERE, not from `feature-flags.ts`: `noBarrelFile` forbids that
 * module re-exporting it, so it only imports it (for its registry entry).
 */
export const DESKTOP_REQUESTS_LIVE_REFRESH_FEATURE_FLAG_KEY =
  "requestsLiveRefresh";
