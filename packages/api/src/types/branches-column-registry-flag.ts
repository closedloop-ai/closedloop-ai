/**
 * ISS-9316 (PRD-716 phase 06, ISS-4779 closed-by-default policy): the single
 * cross-surface flag key that moves the Branches list's column layout onto the
 * shared column registry.
 *
 * With the flag OFF `BranchesGridV2` derives its columns, its
 * `gridTemplateColumns` string, its visible order and its widths in four places
 * beside each other, which is the arrangement PRD-716 exists to remove. With it
 * ON all four come out of one `resolveColumnLayout` call over one declaration
 * set, so a column and its track cannot come apart. Nothing the reader sees
 * changes either way — every Branches column declares the same capabilities and
 * the same pixel width it ships today — so the gate is a rollback control for
 * the derivation, not a switch between two products.
 *
 * ONE THING IT DOES NOT ROLL BACK, deliberately:
 * - A registry column publishes a resolved `align` into the cell-alignment
 *   context that a hand-built column does not. Inert today: every Branches
 *   column resolves `start`, and no Branches cell uses a primitive that
 *   defaults to end-aligned. Put a Branches value on `TableNumberCell` or
 *   `TableChangeCell` and that stops being true, and this key starts deciding
 *   an alignment as well as a derivation.
 *
 * ONE key, both shells. The Branches list is one shared component mounted by
 * `apps/app` and by the desktop renderer, and `DesktopFeatureFlagProvider`
 * resolves the signed-in account's PostHog assignment and nothing else, so this
 * key is the whole gate. There is no desktop Labs toggle to pair with it and no
 * desktop flag-registry shadow entry to add — the ISS-8024 `desktopPosthogFlags`
 * cutover is retired, which is what removed the second gate.
 *
 * Deliberately NOT folded into `grid-table-v2`: that key gates the PRIMITIVE —
 * what a header and a row may do on every surface rendering the shared grid —
 * and this changes where ONE list's column facts are derived. Riding that key
 * would move Sessions, the artifact sandbox and the project board onto a
 * registry none of them declares, the same reason
 * `branches-pinned-name-column` and `agent-ops-complete-surface` each kept their
 * own key.
 */
export const BRANCHES_COLUMN_REGISTRY_FLAG_KEY =
  "branches-column-registry" as const;
