/**
 * ISS-12056: why a `/preview-schemas/vibe-environment/*` request was refused or
 * failed, for the route to pick a status from. Not a wire value: the body
 * carries a message, and this is how the server tells the causes apart (the
 * same posture as `EnsureFailureReason` and `SeedFailureReason`).
 */
export const VibeEnvironmentFailureReason = {
  /** The deployment is not wired to the allowlisted non-production host. */
  HostNotAllowed: "host_not_allowed",
  /** The route ran on a branch preview deployment rather than on stage. */
  WrongDeployment: "wrong_deployment",
  /** The branch's schema is not a preview schema. */
  NotAPreviewSchema: "not_a_preview_schema",
  /** The schema is not a vibe environment in the state this request needs. */
  WrongState: "wrong_state",
  /** The request named something the schema refuses (a table, column, key). */
  Refused: "refused",
  Failed: "failed",
} as const;

export type VibeEnvironmentFailureReason =
  (typeof VibeEnvironmentFailureReason)[keyof typeof VibeEnvironmentFailureReason];

/**
 * The rows route's body cap. A batch carries seeded rows rather than a branch
 * name, so the surface's 2 KiB cap does not apply; this stays under Vercel's
 * 4.5 MB request body limit, and the workflow sizes its batches below it.
 */
export const VIBE_ENVIRONMENT_ROWS_MAX_BYTES = 4 * 1024 * 1024;

/** An S3 object key; S3 itself caps keys at 1024 bytes, prefix included. */
export const VIBE_ENVIRONMENT_OBJECT_KEY_MAX_LENGTH = 900;

/**
 * ISS-12056: the failure `code` when the person belongs to several stage
 * Clerk orgs and none was chosen; `details.clerkOrgs` lists `{ id, name }`
 * (and, since ISS-12135 bug 42, `isAdmin`; a seeded request lists only the
 * orgs the person administers).
 */
export const VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS = "clerk_org_ambiguous";

/**
 * ISS-12135 bug 42: the failure `code` when a seeded request needs an org the
 * person administers and they administer none of theirs; `details.clerkOrgs`
 * lists every org they belong to as `{ id, name, isAdmin }`.
 */
export const VIBE_ENVIRONMENT_CLERK_ORG_NO_ADMIN = "clerk_org_no_admin";

/**
 * ISS-12135 bug 42: the failure `code` when the chosen org is one the person
 * is not an admin of; `details.clerkOrgs` lists every org they belong to as
 * `{ id, name, isAdmin }`.
 */
export const VIBE_ENVIRONMENT_CLERK_ORG_NOT_ADMIN = "clerk_org_not_admin";

/**
 * ISS-12135: why the person check and finalize bound the org they did, on the
 * wire as `clerkOrgChosenBy` and `boundOrg.chosenBy` for the run's log. With
 * no `clerkOrgId` in the request, Daveth Oakhurst's rule: the person's only admin
 * org, else the org their Clerk session last had active when it is one they
 * administer, else the request is refused as `clerk_org_ambiguous`.
 */
export const VibeEnvironmentOrgChoice = {
  /** The request named it (`clerkOrgId`). */
  Requested: "requested",
  /** It is the only org the person belongs to. */
  OnlyOrg: "only_org",
  /** It is the only org the person administers. */
  OnlyAdminOrg: "only_admin_org",
  /** It is the org their Clerk session last had active. */
  LastActive: "last_active",
  /** The environment already holds it (the desktop session only). */
  AlreadyBound: "already_bound",
} as const;

export type VibeEnvironmentOrgChoice =
  (typeof VibeEnvironmentOrgChoice)[keyof typeof VibeEnvironmentOrgChoice];
