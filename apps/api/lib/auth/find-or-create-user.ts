import "server-only";

import type { User } from "@repo/api/src/types/user";
import { BoundedMap } from "@repo/lib/bounded-map";
import { log } from "@repo/observability/log";
import { organizationsService } from "@/app/organizations/service";
import { usersService } from "@/app/users/service";
import { clerkService } from "@/lib/auth/clerk-service";

/**
 * Resolves a Clerk user plus organization into the corresponding internal user.
 *
 * If the user has not been synced into the current org yet, this helper pulls
 * the profile from Clerk and upserts the missing row before returning it.
 */
export async function findOrCreateUser(
  clerkUserId: string,
  clerkOrgId: string
): Promise<User | null> {
  const organization =
    await organizationsService.findOrCreateByClerkId(clerkOrgId);

  const existingUser = await usersService.findByClerkIdAndOrg(
    clerkUserId,
    organization.id
  );

  if (existingUser) {
    return existingUser;
  }

  const key = `${clerkUserId}:${organization.id}`;
  const inFlight = syncFromClerkInFlight.get(key);
  if (inFlight) {
    return await inFlight;
  }

  const sync = syncUserFromClerk(clerkUserId, organization.id).finally(() => {
    // Identity-checked: a key that was evicted under the cap and re-admitted by
    // a later miss belongs to that later caller, whose own settlement clears it.
    if (syncFromClerkInFlight.get(key) === sync) {
      syncFromClerkInFlight.delete(key);
    }
  });
  syncFromClerkInFlight.set(key, sync);
  return await sync;
}

/** The hard cap on {@link syncFromClerkInFlight}; see its contract below. */
export const IN_FLIGHT_SYNC_MAX_KEYS = 1000;

/**
 * The misses in flight right now, keyed by Clerk user and organization.
 *
 * ISS-10335: a fresh deployment's first burst of parallel requests all miss the
 * same row, and each one was fetching the same user from Clerk — 10 to 14 reads
 * against a rate limit shared by every caller. One per key instead.
 *
 * An entry is deleted the moment its promise settles, so the map holds only
 * concurrent misses and a rejection leaves nothing behind for the next caller
 * to inherit. The cap is the second bound the serverless-state rule in
 * `apps/api/AGENTS.md` asks for: a burst of DISTINCT users can open that many
 * entries before any settles, and past {@link IN_FLIGHT_SYNC_MAX_KEYS} the
 * oldest is evicted. Eviction degrades to one duplicate Clerk read for that key
 * — the pre-single-flight behavior — never to a wrong or lost result.
 */
const syncFromClerkInFlight = new BoundedMap<string, Promise<User | null>>(
  IN_FLIGHT_SYNC_MAX_KEYS
);

/** The Clerk read plus upsert behind one miss. */
async function syncUserFromClerk(
  clerkUserId: string,
  organizationId: string
): Promise<User | null> {
  log.info("User not found, fetching from Clerk", { clerkUserId });

  const clerkUser = await clerkService.getUser(clerkUserId);

  const user = await usersService.upsertByClerkIdAndOrg({
    clerkId: clerkUserId,
    organizationId,
    email: clerkUser.email,
    firstName: clerkUser.firstName,
    lastName: clerkUser.lastName,
    avatarUrl: clerkUser.imageUrl,
    phoneNumber: clerkUser.phoneNumber,
  });

  log.info("Created/updated user from Clerk", {
    userId: user.id,
    clerkUserId,
    organizationId,
  });

  return user;
}
