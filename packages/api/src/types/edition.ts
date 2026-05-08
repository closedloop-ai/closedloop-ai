/**
 * Edition discriminant for Community vs Enterprise feature gating.
 */
export const Edition = {
  Community: "community",
  Enterprise: "enterprise",
} as const;
export type Edition = (typeof Edition)[keyof typeof Edition];

/**
 * Read the current edition from the CLOSEDLOOP_EDITION environment variable.
 * Defaults to Community when unset.
 */
export function getEdition(): Edition {
  const raw = process.env.CLOSEDLOOP_EDITION;
  if (raw === Edition.Enterprise) {
    return Edition.Enterprise;
  }
  return Edition.Community;
}

export function isEnterprise(): boolean {
  return getEdition() === Edition.Enterprise;
}
