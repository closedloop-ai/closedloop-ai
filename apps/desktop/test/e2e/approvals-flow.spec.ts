/**
 * E2E deep flow: Approvals — approve and deny seeded pending requests.
 *
 * Seeds the main-process ApprovalStore by writing its electron-store file
 * (`<userData>/desktop-approvals.json`) before launch, so the Approvals panel
 * has a populated queue at boot. Then approves one request and denies another
 * and asserts the queue drains to its empty state.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import { type SeedApproval, seedPendingApprovals } from "./helpers/seed";

const SEEDED: SeedApproval[] = [
  {
    id: "approval-e2e-1",
    reason: "E2E approve: write workspace file",
    riskTier: "medium",
  },
  {
    id: "approval-e2e-2",
    reason: "E2E deny: run shell command",
    riskTier: "high",
  },
];

test.describe("Approvals flow", () => {
  test("approve one and deny another seeded request", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-approvals-e2e-",
      beforeLaunch: (userDataDir) => {
        seedPendingApprovals(userDataDir, SEEDED);
      },
    });

    try {
      await gotoNav(page, "approvals");
      await expect(
        page.getByRole("heading", { name: "Approvals", level: 2 })
      ).toBeVisible();

      // Both seeded requests are listed (each card shows its reason). Resolve
      // each card as the smallest element that holds both the unique reason
      // text and the action buttons, so the button click targets the right row.
      const cardFor = (reason: string) =>
        page
          .locator("div")
          .filter({ hasText: reason })
          .filter({ has: page.getByRole("button", { name: "Approve" }) })
          .last();
      const approveCard = cardFor(SEEDED[0].reason);
      const denyCard = cardFor(SEEDED[1].reason);
      await expect(page.getByText(SEEDED[0].reason)).toBeVisible();
      await expect(page.getByText(SEEDED[1].reason)).toBeVisible();

      // Approve the first; its card leaves the pending queue.
      await approveCard.getByRole("button", { name: "Approve" }).click();
      await expect(page.getByText(SEEDED[0].reason)).not.toBeVisible({
        timeout: 15_000,
      });

      // Deny the second; the queue drains to its empty state.
      await denyCard.getByRole("button", { name: "Deny" }).click();
      await expect(page.getByText(SEEDED[1].reason)).not.toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText("No pending approvals")).toBeVisible();

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
