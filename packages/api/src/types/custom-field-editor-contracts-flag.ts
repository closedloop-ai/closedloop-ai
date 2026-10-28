/**
 * ISS-8215 / ISS-8214 (ISS-4779 closed-by-default policy) — ONE shared
 * web+desktop key over the two custom-field editor contract corrections
 * deferred from PR #6074.
 *
 * ## What flipping it ON changes on screen
 *
 * 1. An enum option created from the Sessions add-field dialog persists the
 *    CANONICAL colour id (`green`, `yellow`, `blue`) the rest of the
 *    custom-field UI reads, instead of the design-system dialog's Tailwind
 *    class (`bg-success`, …). OFF, that class is stored and every other host
 *    resolves it to the unknown-colour grey. The same gate makes the colour
 *    picker resolve a row already persisted with a class, so options written
 *    before the flip read back in the colour they were given.
 * 2. The reference picker in a custom-field table cell stops offering the row
 *    that OWNS the value. `resolveAndValidateReferenceTargets` rejects a
 *    self-reference unconditionally, so that option could only ever fail to
 *    save; OFF, it is still listed.
 *
 * Nothing is removed either way: every other option, colour and target is
 * offered identically, and the API's behaviour is untouched by both halves.
 *
 * ## Why ONE key for both, and not one per ticket
 *
 * They are the same contract on the same editor: a field's options are created
 * in the dialog half and read in the cell half, and both were deferred from one
 * review of one file. A per-ticket key would allow a build where the picker is
 * corrected and the colour is not — a combination nobody designed or reviewed —
 * for no rollout benefit, since neither half modulates the other.
 *
 * ## Both platforms, because the surface exists on both
 *
 * `CustomFieldTableCell` and `SessionsAddFieldDialog` live in `@repo/app`, which
 * both surfaces render; the desktop renderer reaches them through a RENDER path
 * rather than an import, so grepping `apps/desktop/src` for the component names
 * is the wrong question. Web reads this as a PostHog flag via
 * `CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY`
 * (`packages/app/shared/lib/feature-flags.ts`); the desktop renderer resolves
 * the byte-identical key from the signed-in account's PostHog assignment,
 * delivered over the IPC bridge, under the alias
 * `DESKTOP_CUSTOM_FIELD_EDITOR_CONTRACTS_FEATURE_FLAG_KEY`
 * (`apps/desktop/src/shared/feature-flags-labs-surfaces.ts`), default OFF.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module so both sides
 * alias ONE literal and a rename cannot split the two surfaces' reads of it.
 */
export const CUSTOM_FIELD_EDITOR_CONTRACTS_FLAG_KEY =
  "custom-field-editor-contracts" as const;
