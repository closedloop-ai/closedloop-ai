/**
 * `notFound()` signals by throwing, and a page that has LOST its guard throws
 * too — a `TypeError` off the now-undefined record, one line later. A bare
 * `rejects.toThrow()` cannot tell those apart, so every 404 assertion matches
 * this digest instead.
 */
export const NOT_FOUND_DIGEST = "NEXT_HTTP_ERROR_FALLBACK;404";
