/**
 * ISS-5548: the single cross-surface flag key that grows a Session Timeline
 * bar's click target to the full height of its own column, so a low-value
 * bucket is no harder to hit than a tall one. The bar itself is untouched — it
 * stays the visual encoding of magnitude; only the hit area (and the hover
 * stroke that advertises it) moves out to the column.
 *
 * The expansion is keyed off the bucket having a transcript anchor, not off its
 * value, so this flag can never manufacture a larger DEAD target — which keeps
 * ISS-5479's UNREACHABLE vs REACHABLE-BUT-INERT distinction intact under every
 * combination of the two flags.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) precisely so BOTH surfaces import the SAME literal
 * instead of redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop main process registers it as a Labs toggle via
 *    `DESKTOP_SESSION_TIMELINE_COLUMN_HIT_TARGET_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`). `SessionActivityTimeline`
 *    mounts on the desktop renderer too, and the packaged renderer has no
 *    PostHog wiring, so without that Labs entry desktop would keep the ~6px
 *    slivers and the fix would be web-only.
 *
 * Importing one constant on both sides means a future rename touches a single
 * definition; it cannot silently split PostHog and Desktop the way two parallel
 * string literals could. The desktop parity test asserts each surface alias
 * resolves to this constant. Off by default on both surfaces (ISS-4779
 * closed-by-default).
 */
export const SESSION_TIMELINE_COLUMN_HIT_TARGET_FLAG_KEY =
  "session-timeline-column-hit-target" as const;
