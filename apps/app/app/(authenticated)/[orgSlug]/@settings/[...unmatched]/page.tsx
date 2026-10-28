/**
 * Deactivates the slot on a SOFT navigation away from the intercepted Settings
 * route. Without it, Next keeps a parallel slot's previous state whenever the
 * new URL matches nothing in the slot — measured on Next 16.3: a `Link` from
 * the intercepted `/settings` to `/branches`, or a `router.replace`, left the
 * modal open over the new page. `default.tsx` only answers a hard load; this
 * catch-all matches every other URL with at least one segment and renders
 * nothing, and the slot's own `page.tsx` covers the org root it cannot.
 *
 * Named `[...unmatched]` to agree with the `children` slot's own catch-all:
 * parallel slots share one URL space, and `next build` refuses two catch-alls
 * at the same position under different names as ambiguous routes.
 */
export default function SettingsSlotInactive() {
  return null;
}
