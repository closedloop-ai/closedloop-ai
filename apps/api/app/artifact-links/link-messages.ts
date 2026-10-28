/**
 * Kept free of `route-utils` so the request validator can import the self-link
 * wording without pulling the response layer in behind it.
 *
 * A self-link is rejected twice — by Zod on the raw body, and by the service
 * once slug resolution has collapsed an alias onto its own UUID — so both
 * rejections read from one string.
 */
export const SELF_ARTIFACT_LINK_MESSAGE =
  "An artifact cannot be linked to itself";

export const DUPLICATE_ARTIFACT_LINK_MESSAGE =
  "This artifact link already exists";
