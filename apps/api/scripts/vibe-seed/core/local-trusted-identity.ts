import { Result } from "@repo/api/src/types/result";
import {
  E2E_LOCAL_TRUSTED_ORG_ID_ENV,
  E2E_LOCAL_TRUSTED_ORG_SLUG_ENV,
  E2E_LOCAL_TRUSTED_USER_ID_ENV,
  LOCAL_TRUSTED_ORG_ID,
} from "@repo/auth/auth-mode";
import { withDb } from "@repo/database";
import { usersService } from "@/app/users/service";
import { refuse, type VibeSeedRefusal, VibeSeedRefusalCode } from "../guards";
import { vibeSeedAvatar } from "./person-avatars";
import { VIBE_SEED_ORGANIZATION } from "./seed-identity";
import { VIBE_SEED_SIGNED_IN_PERSON } from "./seed-people";

/**
 * ISS-12017: the org and user a stack running `AUTH_MODE=local_trusted` lands
 * every request in. On that stack's first request `withAuth` reads the
 * synthetic session's ids and calls `findOrCreateUser(userId, orgId)`, which
 * creates the org through `organizationsService.findOrCreateByClerkId` (a plain
 * create of `clerkId`, `name`, `slug`, with name and slug read from
 * `local-trusted-clerk-service.ts`) and the user through
 * `usersService.upsertByClerkIdAndOrg` with the stand-in's profile. Writing the
 * same rows here means that first request finds them and serves the seeded org.
 *
 * `findOrCreateUser` itself cannot be loaded in a script: its Clerk boundary
 * imports `@clerk/nextjs/server`, which fails to load outside Next under either
 * export condition (`createContext` is missing under `react-server`, and
 * `server-only` throws without it). The org row is therefore written directly,
 * and the user row through the same `usersService` writer `findOrCreateUser`
 * calls. `findOrCreateUser` returns an existing org or user unchanged, so the
 * seeded names are the ones the app shows.
 *
 * ISS-12056 and ISS-12135: the org is "Acme Co" and the seeded user is the
 * signed-in person, Jordan Avery, who administers it; its owner is the seeded
 * teammate Maya Okafor (`seed-people.ts`, `org-people.ts`). For a vibe
 * environment on Vercel the stage API's finalize step rebinds this org's
 * `clerk_id` to the person's stage Clerk org
 * (`app/preview-schemas/vibe-environment/service.ts`) and hands this seeded
 * user to them (`service/adopt-person.ts`): their first request resolves that
 * org by `clerk_id`, finds Acme Co, and `findOrCreateUser` finds this row under
 * their Clerk id. Admin is their Clerk role in that org, which no seed can
 * grant; finalize requires it.
 */

export type LocalTrustedSeedIdentity = {
  organizationId: string;
  userId: string;
};

const OVERRIDE_ENV_KEYS = [
  E2E_LOCAL_TRUSTED_ORG_ID_ENV,
  E2E_LOCAL_TRUSTED_ORG_SLUG_ENV,
  E2E_LOCAL_TRUSTED_USER_ID_ENV,
] as const;

/**
 * Refuse when an identity override is set: the vibe stack runs local trusted
 * auth with the default ids (it overrides only the slug and display fields, in
 * its servers' env, ISS-12135), so seeding under an override would describe an
 * org the stack never resolves to.
 */
export function checkNoLocalTrustedOverride(
  env: NodeJS.ProcessEnv
): Result<true, VibeSeedRefusal> {
  const set = OVERRIDE_ENV_KEYS.filter((key) => env[key]?.trim());
  if (set.length > 0) {
    return refuse(
      VibeSeedRefusalCode.LocalTrustedOverrideSet,
      `unset ${set.join(", ")}: the vibe stack runs local_trusted with the default ids, so the seed must target them too.`
    );
  }
  return Result.ok(true);
}

/**
 * The seed's org and signed-in person, under the default local-trusted ids, which is
 * what the local stack resolves once {@link checkNoLocalTrustedOverride} has
 * ruled out an override. Reruns rename an org an older seed created.
 */
export async function ensureSeedIdentity(): Promise<LocalTrustedSeedIdentity> {
  const naming = {
    name: VIBE_SEED_ORGANIZATION.name,
    slug: VIBE_SEED_ORGANIZATION.slug,
  };
  const organization = await withDb((db) =>
    db.organization.upsert({
      where: { clerkId: LOCAL_TRUSTED_ORG_ID },
      create: { clerkId: LOCAL_TRUSTED_ORG_ID, ...naming },
      update: naming,
      select: { id: true },
    })
  );
  const user = await usersService.upsertByClerkIdAndOrg({
    clerkId: VIBE_SEED_SIGNED_IN_PERSON.clerkId,
    organizationId: organization.id,
    email: VIBE_SEED_SIGNED_IN_PERSON.email,
    firstName: VIBE_SEED_SIGNED_IN_PERSON.firstName,
    lastName: VIBE_SEED_SIGNED_IN_PERSON.lastName,
    avatarUrl: vibeSeedAvatar(VIBE_SEED_SIGNED_IN_PERSON.githubUsername),
    phoneNumber: null,
    role: VIBE_SEED_SIGNED_IN_PERSON.role,
  });
  return { organizationId: organization.id, userId: user.id };
}
