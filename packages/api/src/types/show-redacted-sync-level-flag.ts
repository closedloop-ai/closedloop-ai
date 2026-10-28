/**
 * The single cross-surface flag key that decides whether the "Redacted
 * sessions" level is OFFERED in a data-sync picker.
 *
 * OFF by default (ISS-4779 closed-by-default): the redaction lane is not
 * plumbed yet — `dataSyncLevelToBooleans` derives the same booleans for
 * `redacted` as for `metadata` — so offering a level that cannot do what its
 * name implies misstates what leaves the device. The `redacted` VALUE stays
 * valid everywhere else (copy map, boolean mapping, migration); only the
 * rendered option set is gated.
 *
 * Lives in this dependency-free `@repo/api` leaf, on the same reasoning as
 * {@link import("./agents-source-provenance-flag")}, precisely so BOTH readers
 * import the SAME literal instead of redeclaring it:
 *  - the desktop Settings "Data & Sync" tab, through
 *    `DESKTOP_SHOW_REDACTED_SYNC_LEVEL_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags-labs-detail.ts`), which also
 *    registers the Labs toggle.
 *  - the Settings v2 Connected Devices panel (PLN-1915 Step 4), in
 *    `packages/app`, which cannot import from `apps/desktop` at all.
 *
 * Both surfaces offer the same choice about the same machine, so a second
 * literal would let them show different option sets for one profile — with one
 * of them wrong about what a user may pick.
 *
 * camelCase, unlike the kebab-case PostHog keys around it, because this key
 * predates the shared reader as a desktop Labs settings key and renaming it
 * would orphan every profile that has already opted in.
 */
export const SHOW_REDACTED_SYNC_LEVEL_FLAG_KEY =
  "showRedactedSyncLevel" as const;
