/**
 * ISS-12341: the same two Details person rows, the same image evidence, and the
 * same assertions, shared by the web Playwright spec and the Electron spec.
 *
 * Four photo URLs rather than two flipped between 200 and 404: the loadable
 * pair and the failing pair are distinct, so neither state can be answered out
 * of the other's HTTP cache, and the Electron spec can drive both in one
 * launched app by swapping which pair the payload carries.
 *
 * The route tallying and the per-row proof shapes come from
 * `person-photo-evidence.ts`, which the invite-roster fixture reads too: the
 * two surfaces mount the same `PersonAvatar` and must not drift onto different
 * evidence for it.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { BasicUser } from "@repo/api/src/types/user";
import { DetailsFieldId } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import {
  expectPersonPhotoFellBack,
  expectPersonPhotoLoaded,
  installCountedPhotoRoutes,
  type PhotoRouteCounts,
} from "./person-photo-evidence";

export const DETAILS_OWNER_NAME = "Ada Lovelace";
// One initial on every person avatar (ISS-12576, #9170: `avatarInitial`).
export const DETAILS_OWNER_INITIALS = "A";
export const DETAILS_CREATOR_NAME = "Grace Hopper";
export const DETAILS_CREATOR_INITIALS = "G";

/** Always answered with a real image body. */
export const DETAILS_OWNER_PHOTO_URL =
  "https://img.clerk.com/iss-12341-owner.png";
export const DETAILS_CREATOR_PHOTO_URL =
  "https://img.clerk.com/iss-12341-creator.png";
/** Always answered 404, so the row falls back to initials. */
export const DETAILS_OWNER_FAILED_PHOTO_URL =
  "https://img.clerk.com/iss-12341-owner-failed.png";
export const DETAILS_CREATOR_FAILED_PHOTO_URL =
  "https://img.clerk.com/iss-12341-creator-failed.png";

/** Which pair a payload carries; the URLs themselves never change behaviour. */
export const DetailsPhotoState = {
  Failed: "failed",
  Loadable: "loadable",
} as const;
export type DetailsPhotoState =
  (typeof DetailsPhotoState)[keyof typeof DetailsPhotoState];

/**
 * Serves all four URLs for the whole page lifetime.
 *
 * The returned counts are what makes a fallback assertion about a photo the
 * browser actually TRIED and lost: an initials-only row whose URL was never
 * requested is the no-photo row, a different contract.
 */
export function installDetailsPersonPhotoRoutes(
  page: Page
): Promise<PhotoRouteCounts> {
  return installCountedPhotoRoutes(page, {
    failed: [DETAILS_OWNER_FAILED_PHOTO_URL, DETAILS_CREATOR_FAILED_PHOTO_URL],
    loadable: [DETAILS_OWNER_PHOTO_URL, DETAILS_CREATOR_PHOTO_URL],
  });
}

/** The Owner row's person, carrying the pair `state` names. */
export function detailsOwnerFixture(state: DetailsPhotoState): BasicUser {
  return {
    avatarUrl:
      state === DetailsPhotoState.Loadable
        ? DETAILS_OWNER_PHOTO_URL
        : DETAILS_OWNER_FAILED_PHOTO_URL,
    email: "ada@example.test",
    firstName: "Ada",
    id: "iss-12341-owner",
    lastName: "Lovelace",
  };
}

/** The Created by row's person, carrying the pair `state` names. */
export function detailsCreatorFixture(state: DetailsPhotoState): BasicUser {
  return {
    avatarUrl:
      state === DetailsPhotoState.Loadable
        ? DETAILS_CREATOR_PHOTO_URL
        : DETAILS_CREATOR_FAILED_PHOTO_URL,
    email: "grace@example.test",
    firstName: "Grace",
    id: "iss-12341-creator",
    lastName: "Hopper",
  };
}

/**
 * One drawn Details row's VALUE cell. `DetailsTabSections` stamps the id on the
 * whole row, label first, so the last child is the value.
 */
export function detailsRow(panel: Locator, fieldId: DetailsFieldId): Locator {
  return panel.locator(`[data-details-field="${fieldId}"] > :last-child`);
}

/** Both person rows drew the photo the payload named, and drew it LOADED. */
export async function expectDetailsPersonPhotosLoaded(
  panel: Locator
): Promise<void> {
  for (const row of [
    {
      initials: DETAILS_OWNER_INITIALS,
      name: DETAILS_OWNER_NAME,
      photoUrl: DETAILS_OWNER_PHOTO_URL,
      value: detailsRow(panel, DetailsFieldId.Owner),
    },
    {
      initials: DETAILS_CREATOR_INITIALS,
      name: DETAILS_CREATOR_NAME,
      photoUrl: DETAILS_CREATOR_PHOTO_URL,
      value: detailsRow(panel, DetailsFieldId.CreatedBy),
    },
  ]) {
    await expectPersonPhotoLoaded(row.value, row);
  }
}

/** Both person rows lost their photo and fell back to initials beside the name. */
export async function expectDetailsPersonPhotosFellBack(
  panel: Locator,
  counts: PhotoRouteCounts
): Promise<void> {
  await expect.poll(() => counts.failed).toBeGreaterThanOrEqual(2);
  for (const row of [
    {
      initials: DETAILS_OWNER_INITIALS,
      name: DETAILS_OWNER_NAME,
      value: detailsRow(panel, DetailsFieldId.Owner),
    },
    {
      initials: DETAILS_CREATOR_INITIALS,
      name: DETAILS_CREATOR_NAME,
      value: detailsRow(panel, DetailsFieldId.CreatedBy),
    },
  ]) {
    await expectPersonPhotoFellBack(row.value, row);
  }
}

/**
 * The Session's recording user (`user`), a third person beside the Owner and
 * the creator: the Session Owner row reads the assignee (ISS-12251 D-1), so a
 * row still on `user` names this person and fails the Owner assertions.
 */
export const DETAILS_SESSION_UPLOADER: BasicUser = {
  avatarUrl: null,
  email: "sam@example.test",
  firstName: "Sam",
  id: "iss-12251-uploader",
  lastName: "Uploader",
};
