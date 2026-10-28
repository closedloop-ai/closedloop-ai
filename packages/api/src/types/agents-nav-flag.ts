/**
 * The single cross-surface flag key gating the Agents DESTINATION — the nav
 * entry and the routes behind it — on both the web app and the packaged
 * desktop renderer.
 *
 * ## Why the literal is camelCase
 *
 * `agentsNav` is a persisted `DesktopSettings` field name (ISS-5310), so it is
 * already written into every desktop user's settings store. Renaming it to
 * match the kebab-case PostHog convention would strand each user who has
 * already opted in — their stored `agentsNav: true` would stop being read and
 * the workspace they enabled would silently close. Keeping one literal that
 * both surfaces import is worth more than key-casing consistency, so the
 * desktop spelling wins and PostHog uses the same string.
 *
 * ## Why ONE key, shared, rather than one per surface
 *
 * ISS-4779 requires a UI change reachable on both surfaces to be gated on both,
 * and two parallel string literals are exactly how a feature leaks on one while
 * hidden on the other. Both surfaces alias THIS constant:
 *  - web (`apps/app`) resolves it as a PostHog flag via
 *    `AGENTS_NAV_FEATURE_FLAG_KEY` (`packages/app/shared/lib/feature-flags.ts`),
 *    which reaches the nav registry, the sidebar, the command palette, the
 *    mobile bottom nav, and the `/agents` route gates.
 *  - the desktop main process registers it as an off-by-default Labs toggle via
 *    `DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`), nested inside the `labsNav`
 *    container gate.
 *
 * A rename therefore touches one definition and cannot split the two REGISTRY
 * halves. It does NOT reach the persisted half, and that asymmetry is the part
 * to know before renaming anything here (ISS-8020). The desktop settings FIELD
 * is a hand-written literal in five places that import nothing from this module
 * — `DesktopSettings.agentsNav` and its `DEFAULT_DESKTOP_SETTINGS` entry
 * (`apps/desktop/src/shared/contracts.ts`), `LABS_SETTING_KEY_LEDGER`, that
 * ledger's witness in `test/labs-setting-key-ledger.test.ts`, and the E2E
 * settings seed — and `SettingsStore.getFlag` reaches the store through
 * `key as keyof DesktopSettings`. The cast is what makes the failure silent: a
 * rename here would compile, and `getFlag` would then read a key no profile has
 * ever written and fall back to the registry default `false`, closing the
 * desktop workspace for every user who had opted in. Renaming means renaming the
 * persisted field too, which is exactly the stranding ISS-5310 warns about.
 *
 * WEB ALSO NEEDS THE POSTHOG FLAG TO EXIST. ISS-8020: this gate shipped against
 * a key that had never been created in PostHog, so every web read was
 * `undefined`, every `?.enabled === true` was false, and Agents was closed for
 * every web user with no way to open it. The key is recorded in
 * `scripts/lint/posthog-flag-registration-ledger.ts`. ISS-8034 and ISS-8117
 * replaced that check's single-module read with a walk of `FLAG_SOURCE_ROOTS`,
 * which covers this package and the server trees too; ISS-8676 then removed the
 * blocking half, so a key declared anywhere the scan reads — this one included —
 * ships whether or not a row exists, and `posthog-flag-checklist.ts` reports the
 * ones nobody has claimed.
 *
 * ## Why it must stay CLIENT-evaluated on web
 *
 * ISS-7835: dev mode OFF is the customer view, and it works by suppressing
 * CLIENT PostHog flag reads (`suppressesFeatureFlag`,
 * `packages/analytics/customer-view.tsx`). A gate resolved server-side per
 * viewer — an org entitlement, say — would correctly keep Agents on for an
 * entitled customer but would NOT be reachable by that suppression, so a staff
 * viewer turning dev mode off would still see Agents and the bug would survive
 * its own fix. Per-org targeting belongs in this flag's PostHog rollout, not in
 * a second server-side gate.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so both surfaces can import the same
 * literal without dragging a transitive dependency into the desktop shared
 * layer.
 */
export const AGENTS_NAV_FLAG_KEY = "agentsNav" as const;
