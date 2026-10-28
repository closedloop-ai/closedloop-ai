/**
 * ISS-12056 and ISS-12135: the seeded organization and the person a vibe
 * session signs in as. Kept free of imports because `pnpm vibe up` (a tsx
 * script outside this package) reads it with `require` to name its web stack's
 * session, and this package is CommonJS to that loader.
 */

export const VIBE_SEED_ORGANIZATION = {
  name: "Acme Co",
  slug: "acme-co",
} as const;

/**
 * ISS-12135: the signed-in person, an admin of the seeded org (the owner is a
 * separate seeded teammate, `VIBE_SEED_OWNER`). On the staff domain, because
 * `just vibe-up` signs in as this person and Dev Mode is offered only to a
 * staff email (`isStaffEmail`), in the browser and in the api's override check
 * alike.
 */
export const VIBE_SEED_SIGNED_IN_PROFILE = {
  email: "jordan.avery@closedloop.ai",
  firstName: "Jordan",
  lastName: "Avery",
} as const;
