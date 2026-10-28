/**
 * ISS-8938 (PRD-695 §3, under the ISS-4779 closed-by-default policy): gates how
 * the one-field New Document dialog REPORTS a failed create. Off by default,
 * which leaves the dialog reporting a failure exactly as it does today.
 *
 * ## What it gates
 *
 * One failure, said once, in the place the reader is looking. Off, a rejected
 * create is announced TWICE — the dialog renders the raw `error.message` and the
 * shared `QueryClient` also toasts its generic "Operation failed", so the reader
 * is handed two different accounts of one rejection and neither names the other.
 * On, the create mutation opts out of the shared toast and the dialog owns the
 * whole message: what failed, what the server said, and a submit control that
 * says "Try again" while the typed title is still sitting in the field.
 *
 * The parts of the create flow that are NOT gated are the parts that already
 * ship: the dialog is already one field, already creates a project-less
 * organization-level DOC, and already lands in the editor with the cursor
 * placed. A gate over those would withdraw a live capability rather than roll
 * one out, which is not what a rollout key is for.
 *
 * ## Web-only, for a structural reason rather than a choice
 *
 * The same reason its sibling `documents-index-server-search-flag` gives: the
 * desktop shell has no Documents destination —
 * `DESKTOP_SHELL_ROUTE_NAV_IDS[ShellNavigationRouteId.Documents]` is `null` in
 * `apps/desktop/src/renderer/navigation/route-table.ts` — so no desktop route
 * resolves to this surface and there is no second surface for the gate to leak
 * on. A desktop key was ruled out, not forgotten: this is ONE PostHog key that
 * happens to have one surface, and per the operator directive (2026-08-30)
 * there is no Labs toggle and no desktop registry entry to pair with it.
 *
 * Lives in this dependency-free `@repo/api` module to match the convention its
 * sibling flag keys follow, so the literal has one definition a rename can
 * reach.
 */
export const DOCUMENTS_CREATE_FAILURE_RECOVERY_FLAG_KEY =
  "documents-create-failure-recovery" as const;
