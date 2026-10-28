/**
 * ISS-6384 — the single cross-surface flag key gating ADOPTION of the shared
 * artifact cell primitives (`CountCell`, `MonoIdCell`, `InlineScalarCell`) by
 * the production tables that were hand-rolling those same data types.
 *
 * ## Why ONE key for every call site
 *
 * The point of the ticket is that four surfaces render the same data type four
 * different ways. Gating them apart would ship exactly that: a build where the
 * Branches linked-sessions count is a shared primitive while the Agents
 * invocations count beside it is still its own private `NumberCell`, which is
 * the drift the primitives exist to remove. One key flips the convergence, or
 * none of it.
 *
 * ## What flipping it ON changes on screen
 *
 * - **Agents catalog** (Invocations, Sessions): a count of exactly `0` renders
 *   the shared em-dash named "No invocations" instead of a literal `0`. This is
 *   the house rule ISS-6384 set, taken from Branches, which already renders the
 *   dash. A `null` count is unchanged — it dashed before and dashes now, with
 *   the wording that distinguishes "none" from "unavailable".
 * - **Branches** (Linked sessions): no perceivable change. The behaviour it
 *   already had — a 0-count is the empty value, never a dead link — is the rule
 *   the primitive was built around; the cell is now the shared one.
 * - **Agent detail, Sessions tab** (Version): the version label renders
 *   monospaced with an accessible name naming it a version, instead of a bare
 *   `<span>` whose text announces as an unexplained token.
 * - **Documents grid** (Due date): the due-date cell is the shared inline date
 *   primitive over `DatePickerPopover` rather than its own read-only/editable
 *   pair of near-identical branches.
 *
 * OFF (the default, per the ISS-4779 closed-by-default policy) every one of
 * those surfaces renders exactly as it does today.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop renderer resolves it from the signed-in account's PostHog
 *    assignment, delivered over the IPC bridge, under the byte-equal alias
 *    `DESKTOP_ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags-labs-surfaces.ts`).
 *
 * Every one of these surfaces mounts on BOTH platforms, so a rename must touch
 * one definition — two parallel string literals could silently light the
 * primitives on web while the desktop kept its hand-rolls.
 */
export const ARTIFACT_CELL_PRIMITIVES_FLAG_KEY =
  "artifact-cell-primitives" as const;
