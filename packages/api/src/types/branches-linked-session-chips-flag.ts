/**
 * ISS-8972 / ISS-10816 (ISS-4779 closed-by-default): the single cross-surface
 * flag key gating the Branches list's `sessions` column rendering ONE CHIP PER
 * CANONICAL LINKED SESSION instead of a single count chip.
 *
 * WHAT IT GATES. Presentation only. The additive
 * `canonicalProjection.common.membership.sessions` identities ride the Branch
 * list response in either state and describe the same Wrote population as the
 * count, detail timeline, and combined trace. ON renders those identities with
 * `RelatedSessionsTableCell`; descriptions remain capped while the uncapped
 * count drives `+N`. OFF renders the existing count chip. Both arms keep the
 * approved "Linked sessions" label and issue no extra provenance request.
 *
 * WHY THE CELL IS NOT NEW. `RelatedSessionsTableCell`
 * (`@repo/app/shared/components/generic-artifact-surface`) already existed,
 * already matched the approved prototype, and was already covered by stories and
 * unit tests. This key gates its canonical Branch-membership wiring.
 *
 * WHAT A LOCAL-ONLY DESKTOP ROW DOES. The desktop's local SQLite branch read
 * cannot provide cloud membership identities. Such a row keeps the COUNT chip
 * with this flag on rather than rendering an em-dash over Sessions it can prove
 * exist. The optional wire shape remains for version-skewed producers/clients;
 * ISS-10816 supersedes ISS-10712's retirement premise for this Branch surface.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so both surfaces import the SAME literal instead of
 * redeclaring it — the ISS-5841 arrangement, where byte-equality is a fact of
 * the import rather than a comment two files must keep agreeing on:
 *  - the web app resolves it per-viewer through PostHog, via
 *    `BRANCHES_LINKED_SESSION_CHIPS_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`);
 *  - the desktop renderer resolves THAT SAME literal from the signed-in
 *    account's PostHog assignment — the same key space the web app reads — so
 *    the two surfaces cannot diverge. There is no desktop registry entry and no
 *    Labs toggle beside it: since ISS-8753 `DesktopFeatureFlagProvider` reads
 *    the PostHog assignment and nothing else, so this key is the whole gate.
 *
 * The column mounts on BOTH shells through `@repo/app/branches`, so one key is
 * the gate of record on both. Default OFF on both (ISS-4779).
 */
export const BRANCHES_LINKED_SESSION_CHIPS_FLAG_KEY =
  "branches-linked-session-chips" as const;
