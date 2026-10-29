/**
 * ISS-12341: the guided-onboarding invite step's "your team is already here"
 * roster, its image evidence, and its assertions, shared by the web Playwright
 * spec and the Electron spec.
 *
 * The proof shapes come from `person-photo-evidence.ts` rather than from a copy
 * here, so this roster and the Details person rows cannot drift onto different
 * evidence for the same `PersonAvatar`.
 *
 * FOUR URLS, NONE OF THEM THE DETAILS SPECS'. The loadable pair and the failing
 * pair are distinct so neither state can be answered out of the other's HTTP
 * cache, and all four differ from `details-person-row-photo-fixture.ts`'s so one
 * surface's state cannot be answered out of the other surface's either.
 *
 * TWO TEAMMATES, because the roster reads `avatarUrl` per person: a
 * single-member fixture cannot tell a per-person read from a strip that draws
 * whatever the first member had.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { User } from "@repo/api/src/types/user";
import { currentUser } from "./mock-users";
import {
  expectPersonPhotoFellBack,
  expectPersonPhotoLoaded,
  installCountedPhotoRoutes,
  type PhotoRouteCounts,
} from "./person-photo-evidence";

/** The eyebrow the step states only once the roster read found teammates. */
export const ROSTER_EYEBROW = "Your team is already here";

export const ROSTER_FIRST_NAME = "Rosa Parks";
// One initial on every person avatar (ISS-12576, #9170: `avatarInitial`).
export const ROSTER_FIRST_INITIALS = "R";
export const ROSTER_SECOND_NAME = "Wes Montgomery";
export const ROSTER_SECOND_INITIALS = "W";

/** Always answered with a real image body. */
export const ROSTER_FIRST_PHOTO_URL =
  "https://img.clerk.com/iss-12341-roster-first.png";
export const ROSTER_SECOND_PHOTO_URL =
  "https://img.clerk.com/iss-12341-roster-second.png";
/** Always answered 404, so the chip falls back to initials. */
export const ROSTER_FIRST_FAILED_PHOTO_URL =
  "https://img.clerk.com/iss-12341-roster-first-failed.png";
export const ROSTER_SECOND_FAILED_PHOTO_URL =
  "https://img.clerk.com/iss-12341-roster-second-failed.png";

/** Which pair a roster read carries; the URLs themselves never change behaviour. */
export const RosterPhotoState = {
  Failed: "failed",
  Loadable: "loadable",
} as const;
export type RosterPhotoState =
  (typeof RosterPhotoState)[keyof typeof RosterPhotoState];

/** Serves all four roster URLs for the whole page lifetime. */
export function installRosterPhotoRoutes(
  page: Page
): Promise<PhotoRouteCounts> {
  return installCountedPhotoRoutes(page, {
    failed: [ROSTER_FIRST_FAILED_PHOTO_URL, ROSTER_SECOND_FAILED_PHOTO_URL],
    loadable: [ROSTER_FIRST_PHOTO_URL, ROSTER_SECOND_PHOTO_URL],
  });
}

/**
 * What `GET /users` answers: the signer plus the two teammates the strip names.
 *
 * The signer is in the payload because the fold SUBTRACTS them —
 * `foldOnboardingOrganizationMembers` reports `unknown` for a roster it cannot
 * tell apart from a team of one, so a payload carrying only the teammates draws
 * no roster at all and every assertion below would fail on the eyebrow.
 *
 * `signer` is passed in rather than built here, and the caller serves the SAME
 * row on `/me`: the two ids must agree or the fold subtracts nobody, and the
 * strip then names the reader to themselves — a different defect, which every
 * assertion here would still pass through. The teammates come from
 * `currentUser`, the suite's one `User` factory; its overrides make it the
 * general one, and a second factory here would be the duplicate this suite
 * keeps consolidating away.
 */
export function rosterUsersPayload(
  state: RosterPhotoState,
  signer: User
): User[] {
  return [
    signer,
    currentUser({
      avatarUrl:
        state === RosterPhotoState.Loadable
          ? ROSTER_FIRST_PHOTO_URL
          : ROSTER_FIRST_FAILED_PHOTO_URL,
      createdAt: new Date("2024-01-02T00:00:00.000Z"),
      firstName: "Rosa",
      id: "iss-12341-roster-first",
      lastName: "Parks",
    }),
    currentUser({
      avatarUrl:
        state === RosterPhotoState.Loadable
          ? ROSTER_SECOND_PHOTO_URL
          : ROSTER_SECOND_FAILED_PHOTO_URL,
      createdAt: new Date("2024-01-03T00:00:00.000Z"),
      firstName: "Wes",
      id: "iss-12341-roster-second",
      lastName: "Montgomery",
    }),
  ];
}

/**
 * One roster chip, reached from the name it is labelled with.
 *
 * The chip carries no id of its own, and the name's element is its only stable
 * landmark: Playwright's text engine matches the SMALLEST element holding the
 * string, so the parent of that match is the chip that also holds the avatar.
 * Callers assert the chip is present before reading a photo out of it, so a
 * restructured strip fails naming the chip rather than the photo.
 */
export function rosterChip(dialog: Locator, name: string): Locator {
  return dialog.getByText(name, { exact: true }).locator("..");
}

/** Both chips drew the photo the roster read carried, and drew it LOADED. */
export async function expectRosterPhotosLoaded(dialog: Locator): Promise<void> {
  await expect(dialog.getByText(ROSTER_EYEBROW)).toBeVisible();
  for (const member of [
    {
      initials: ROSTER_FIRST_INITIALS,
      name: ROSTER_FIRST_NAME,
      photoUrl: ROSTER_FIRST_PHOTO_URL,
    },
    {
      initials: ROSTER_SECOND_INITIALS,
      name: ROSTER_SECOND_NAME,
      photoUrl: ROSTER_SECOND_PHOTO_URL,
    },
  ]) {
    const chip = rosterChip(dialog, member.name);
    await expect(chip).toHaveCount(1);
    await expectPersonPhotoLoaded(chip, member);
  }
}

/**
 * Both chips lost their photo and fell back to initials beside the name.
 *
 * The per-URL request count is load-bearing: without it an initials-only chip
 * whose photo was never requested — a teammate the roster read carried no
 * `avatarUrl` for, which is the pre-fix render — satisfies every other
 * assertion here.
 */
export async function expectRosterPhotosFellBack(
  dialog: Locator,
  counts: PhotoRouteCounts
): Promise<void> {
  await expect(dialog.getByText(ROSTER_EYEBROW)).toBeVisible();
  for (const member of [
    {
      initials: ROSTER_FIRST_INITIALS,
      name: ROSTER_FIRST_NAME,
      photoUrl: ROSTER_FIRST_FAILED_PHOTO_URL,
    },
    {
      initials: ROSTER_SECOND_INITIALS,
      name: ROSTER_SECOND_NAME,
      photoUrl: ROSTER_SECOND_FAILED_PHOTO_URL,
    },
  ]) {
    await expect
      .poll(() => counts.requestsFor(member.photoUrl))
      .toBeGreaterThanOrEqual(1);
    const chip = rosterChip(dialog, member.name);
    await expect(chip).toHaveCount(1);
    await expectPersonPhotoFellBack(chip, member);
  }
}
