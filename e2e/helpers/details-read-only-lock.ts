/**
 * ISS-12470: the derived row's lock wording as a user reaches it — hover the
 * value, read the tooltip.
 *
 * Shared by the web and Electron Session Details specs, which mount the same
 * `details-tab-sections.tsx` row. The colocated jsdom case reads the reason off
 * the FIELD CONFIG, so it stays green if the renderer stops drawing the tooltip
 * at all (whitlockk, PR #8810); this is the half that fails on that.
 *
 * The row renders the same wording a second time in an `sr-only` span, so the
 * assertion is scoped to the tooltip rather than to the row's text.
 */
import { expect, type Locator } from "@playwright/test";
import type { DetailsFieldId } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { automaticReason } from "@repo/app/shared/lib/details-lock-copy";

export async function expectDerivedRowLockWording(
  details: Locator,
  fieldId: DetailsFieldId
): Promise<void> {
  const row = details.locator(`[data-details-field="${fieldId}"]`);
  await row.locator('[data-slot="tooltip-trigger"]').first().hover();
  await expect(
    row.page().getByRole("tooltip").filter({ hasText: automaticReason })
  ).toBeVisible();
}
