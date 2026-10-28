import { ApproverRole } from "@repo/api/src/types/user";
import {
  VIBE_SEED_CORPUS_NAMED_TEAMMATE,
  VIBE_SEED_SIGNED_IN_LOGIN,
} from "@repo/api/src/vibe-seed-corpus";
import { LOCAL_TRUSTED_USER_ID } from "@repo/auth/auth-mode";
import { VIBE_SEED_SIGNED_IN_PROFILE } from "./seed-identity";

/**
 * ISS-12056 (Seed quality): the people the vibe seed shows (the organization
 * and the owner's profile are in `seed-identity.ts`).
 * Emails use the reserved `.example` TLD (RFC 2606), so no seeded address can
 * ever route to a real inbox. The signed-in person is the one exception
 * (ISS-12135).
 */

export type VibeSeedPerson = {
  /** Internal identity key; never rendered. */
  readonly clerkId: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: ApproverRole;
  readonly githubUsername: string;
};

const EMAIL_DOMAIN = "acmeco.example";

/**
 * ISS-12135: the org's owner, a fake-named teammate who owns the home team.
 * Not the signed-in person: that is {@link VIBE_SEED_SIGNED_IN_PERSON}.
 */
export const VIBE_SEED_OWNER: VibeSeedPerson = {
  clerkId: "user_vibe_seed_maya_okafor",
  email: `maya.okafor@${EMAIL_DOMAIN}`,
  firstName: "Maya",
  lastName: "Okafor",
  role: ApproverRole.TechLead,
  githubUsername: "mayaokafor",
};

/**
 * ISS-12135: the signed-in person, an ADMIN of the home team. It keeps the
 * local-trusted user id, so the `AUTH_MODE=local_trusted` stack resolves its
 * session to this row (the seed's `context.userId`); a seeded Vercel preview
 * adopts this row for the person running the session at finalize, so its
 * handle names no one (`VIBE_SEED_SIGNED_IN_LOGIN`).
 */
export const VIBE_SEED_SIGNED_IN_PERSON: VibeSeedPerson = {
  clerkId: LOCAL_TRUSTED_USER_ID,
  ...VIBE_SEED_SIGNED_IN_PROFILE,
  role: ApproverRole.Pm,
  githubUsername: VIBE_SEED_SIGNED_IN_LOGIN,
};

export const VIBE_SEED_TEAMMATES: readonly VibeSeedPerson[] = [
  {
    clerkId: "user_vibe_seed_daveth_reyes",
    email: `daveth.reyes@${EMAIL_DOMAIN}`,
    firstName: "Daveth",
    lastName: "Reyes",
    role: ApproverRole.Engineer,
    githubUsername: "dreyes",
  },
  {
    clerkId: "user_vibe_seed_priya_raman",
    email: `priya.raman@${EMAIL_DOMAIN}`,
    firstName: "Priya",
    lastName: "Raman",
    role: ApproverRole.Pm,
    githubUsername: "priyaraman",
  },
  {
    clerkId: "user_vibe_seed_tomas_lindqvist",
    email: `tomas.lindqvist@${EMAIL_DOMAIN}`,
    ...VIBE_SEED_CORPUS_NAMED_TEAMMATE,
    role: ApproverRole.Engineer,
  },
  {
    clerkId: "user_vibe_seed_grace_chen",
    email: `grace.chen@${EMAIL_DOMAIN}`,
    firstName: "Grace",
    lastName: "Chen",
    role: ApproverRole.Designer,
    githubUsername: "gracechen",
  },
  {
    clerkId: "user_vibe_seed_samuel_adeyemi",
    email: `samuel.adeyemi@${EMAIL_DOMAIN}`,
    firstName: "Samuel",
    lastName: "Adeyemi",
    role: ApproverRole.Engineer,
    githubUsername: "sadeyemi",
  },
];

/** Golden-corpus identities whose imported display names describe fixture users. */
export const VIBE_GOLDEN_USERS = [
  {
    sourceFirstName: "testuser2",
    firstName: "Amara",
    lastName: "Diallo",
    email: `amara.diallo@${EMAIL_DOMAIN}`,
    avatarHandle: "amaradiallo",
  },
  {
    sourceFirstName: "testuser4",
    firstName: "Elena",
    lastName: "Morales",
    email: `elena.morales@${EMAIL_DOMAIN}`,
    avatarHandle: "elenamorales",
  },
  {
    sourceFirstName: "testuser5",
    firstName: "Kai",
    lastName: "Nakamura",
    email: `kai.nakamura@${EMAIL_DOMAIN}`,
    avatarHandle: "kainakamura",
  },
  {
    sourceFirstName: "testuser6",
    firstName: "Leila",
    lastName: "Haddad",
    email: `leila.haddad@${EMAIL_DOMAIN}`,
    avatarHandle: "leilahaddad",
  },
] as const;
