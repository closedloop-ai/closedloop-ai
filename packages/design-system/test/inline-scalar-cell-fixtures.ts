/**
 * The sentence a test hands `InlineScalarCell` for an unparseable number.
 *
 * ISS-9590 made `invalidMessage` required on the `number` variant, so every
 * numeric fixture in this package needs one. It is a FIXTURE, not product copy:
 * this package carries no user-visible words, and the cell announces whatever
 * its adapter supplies. The approved string production shows is resolved by
 * `INLINE_SCALAR_NUMBER_INVALID_MESSAGE` in `packages/app`, which this package is
 * gated from importing.
 */
export const INVALID_MESSAGE = "Not a number";
