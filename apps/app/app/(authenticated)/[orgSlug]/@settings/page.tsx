/**
 * The `@settings` slot at the org root, `/{orgSlug}` itself (ISS-8370 D2).
 * Nothing, like `[...unmatched]` — which needs at least one segment and so
 * cannot answer this one URL. Without a match here a soft navigation from the
 * intercepted modal to the org root keeps the slot's previous state and the
 * modal stays open over the redirect.
 */
export default function SettingsSlotRoot() {
  return null;
}
