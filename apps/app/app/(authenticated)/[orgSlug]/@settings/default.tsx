/**
 * What the `@settings` slot renders on a hard load of any route under
 * `[orgSlug]` that the slot does not itself match (ISS-8370 D2). Nothing: the
 * slot only ever carries the intercepted Settings modal.
 */
export default function SettingsSlotDefault() {
  return null;
}
