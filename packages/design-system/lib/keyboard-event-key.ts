/**
 * Normalizing a keydown's `key` at the DOM trust boundary (ISS-7493).
 *
 * `KeyboardEvent.key` is typed `string` and a real keystroke honours that — but
 * a listener bound to `document` or `window` also receives events NOBODY on
 * this side constructed. Password managers and extensions dispatch synthetic
 * ones, and a shim that assembles its event by hand can leave `key` absent or
 * put a non-string on it. The DOM type describes what the browser emits, not
 * what reaches a global listener, so it cannot constrain this: production RUM
 * caught the unguarded form throwing `Cannot read properties of undefined
 * (reading 'toLowerCase')` out of the command palette's document listener, on
 * whatever route the user happened to be on.
 *
 * ONE MODULE, EVERY CHORD MATCHER. Five call sites across four packages had the
 * same unguarded `.toLowerCase()` shape, and the guard is a validator — the
 * kind of thing this repo re-declares by copy and then lets drift. It lives
 * here rather than in `@repo/app` because `packages/design-system` is gated
 * from importing that, and every other consumer already depends on this
 * package.
 */

/**
 * The lowercased key this event carries, or `null` when it carries none a chord
 * can be matched against.
 *
 * `null` rather than `""`: an absent key must match NO chord, while an empty
 * string is a value a chord could legitimately be declared for.
 *
 * TAKES THE EVENT, NOT THE KEY, and the difference is a caught bug rather than
 * a preference (tamsinb review, PR #7424). A `key: unknown` parameter is
 * honest about the runtime, but it also accepts the whole event by mistake —
 * that compiles, returns `null`, and silently kills every chord with nothing
 * going red. Reading `key` here makes both halves type errors instead: a bare
 * `event.key` is a `string` with no properties in common with this weak type,
 * and the event it came from is what the signature actually wants.
 *
 * The property stays `unknown` inside that shape, because that is the half the
 * DOM genuinely lies about.
 */
export function normalizedEventKey(source: {
  readonly key?: unknown;
}): string | null {
  return typeof source.key === "string" ? source.key.toLowerCase() : null;
}
