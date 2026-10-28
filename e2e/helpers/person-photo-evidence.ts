/**
 * ISS-12341: the browser evidence that a person avatar drew the PHOTO it was
 * given, and fell back to initials when that photo lost.
 *
 * Every surface this fix touched mounts the same `PersonAvatar`, so the proof
 * shapes live here once rather than per surface: the Details person rows
 * (`details-person-row-photo-fixture.ts`) and the guided-onboarding invite
 * roster (`onboarding-roster-photo-fixture.ts`) both read these. Two copies
 * would let one surface's coverage be weakened without the other's going red,
 * which is the drift this module exists to prevent.
 *
 * The colocated jsdom cases for this fix cannot reach any of it: Radix commits
 * `AvatarImage` only on a real image LOAD, jsdom supplies none, and the shared
 * `avatarImageMockModule` stand-in forwards `alt` and `src` and nothing else.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { AVATAR_IMAGE_BODY } from "./branch-owner-avatar-fixture";

export type PhotoRouteCounts = {
  failed: number;
  loadable: number;
  /**
   * How many times ONE url was requested.
   *
   * The aggregate tallies cannot say which row lost its photo, so a fallback
   * assertion that means "this row tried and failed" reads this instead: an
   * initials-only row whose own url was never requested is the no-photo row, a
   * different contract that would otherwise satisfy the same assertion.
   */
  requestsFor: (url: string) => number;
};

/**
 * Serves each url for the whole page lifetime — the loadable set with a real
 * image body, the failed set 404 — and tallies both.
 *
 * Distinct urls per state rather than one url flipped between 200 and 404, so
 * neither state can be answered out of the other's HTTP cache, and a single
 * launched app can drive both by swapping which set its payload names.
 */
export async function installCountedPhotoRoutes(
  page: Page,
  urls: { failed: readonly string[]; loadable: readonly string[] }
): Promise<PhotoRouteCounts> {
  const perUrl = new Map<string, number>();
  const counts: PhotoRouteCounts = {
    failed: 0,
    loadable: 0,
    requestsFor: (url) => perUrl.get(url) ?? 0,
  };
  for (const url of urls.loadable) {
    await page.route(url, async (route) => {
      counts.loadable += 1;
      perUrl.set(url, (perUrl.get(url) ?? 0) + 1);
      await route.fulfill({
        body: AVATAR_IMAGE_BODY,
        contentType: "image/svg+xml",
      });
    });
  }
  for (const url of urls.failed) {
    await page.route(url, async (route) => {
      counts.failed += 1;
      perUrl.set(url, (perUrl.get(url) ?? 0) + 1);
      await route.fulfill({ body: "", status: 404 });
    });
  }
  return counts;
}

/**
 * One row drew the photo its payload named, and drew it LOADED.
 *
 * `naturalWidth` is the whole point: a present `src` with a zero width is the
 * jsdom state this coverage exists to get past. The initials assertion is the
 * other half — Radix unmounts the fallback once the photo commits, so initials
 * still on screen means the row is showing a placeholder over a photo it holds.
 */
export async function expectPersonPhotoLoaded(
  row: Locator,
  person: { initials: string; name: string; photoUrl: string }
): Promise<void> {
  await expect(row.getByText(person.name, { exact: true })).toBeVisible();
  const photo = row.locator('img[data-slot="avatar-image"]');
  await expect(photo).toHaveAttribute("src", person.photoUrl);
  await expect
    .poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(row.getByText(person.initials, { exact: true })).toHaveCount(0);
}

/**
 * One row lost its photo and fell back to initials beside the name.
 *
 * The caller owns the request-count half, because only it knows which url this
 * row was given and how many rows are on screen.
 */
export async function expectPersonPhotoFellBack(
  row: Locator,
  person: { initials: string; name: string }
): Promise<void> {
  await expect(row.getByText(person.initials, { exact: true })).toBeVisible();
  await expect(row.getByText(person.name, { exact: true })).toBeVisible();
  await expect(row.locator("img")).toHaveCount(0);
}
