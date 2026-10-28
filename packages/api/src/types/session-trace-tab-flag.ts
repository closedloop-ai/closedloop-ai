/**
 * @file session-trace-tab-flag.ts
 * @description Shared key for the closed-by-default session Trace tab
 * (ISS-10737, under the ISS-4779 closed-by-default UI policy).
 *
 * The Trace tab is net-new end-user-perceivable UI on the Sessions detail
 * surface, and that surface is ONE shared component
 * (`SessionDetailWorkspace`) mounted by both `apps/app` and the desktop
 * renderer. So ONE key gates both shells: the desktop renderer resolves the
 * signed-in account's PostHog assignment from the same key space `apps/app`
 * reads, and there is no desktop Labs toggle and no desktop registry shadow
 * entry to pair with it — the retired ISS-8024 cutover key
 * (`desktopPosthogFlags`) no longer selects a local registry path. A second,
 * desktop-named key would let the tab leak on one shell while hidden on the
 * other, which is the failure this single constant exists to make
 * unrepresentable.
 *
 * It lives in `@repo/api` because that is the only dependency-free module both
 * surfaces can import.
 */
export const SESSION_TRACE_TAB_FLAG_KEY = "session-trace-tab" as const;
