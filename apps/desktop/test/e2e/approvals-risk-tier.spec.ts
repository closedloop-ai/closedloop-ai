/**
 * E2E regression: Approvals — the risk-tier badge renders the seeded tier.
 *
 * FEA-2934: the Approvals panel read the pending approval's tier from a `tier`
 * field, but the ApprovalStore (and its seeded electron-store file) exposes the
 * value as `riskTier`. The mismatch made every badge fall back to "unknown".
 * This spec seeds approvals with explicit `medium`/`high` tiers and asserts each
 * card's badge renders that tier — and never "unknown".
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
    id: "approval-risk-1",
    reason: "Risk badge: write workspace file",
    riskTier: "medium",
  },
  {
    id: "approval-risk-2",
    reason: "Risk badge: run shell command",
    riskTier: "high",
  },
];

test.describe("Approvals risk tier", () => {
  test("badge renders the seeded risk tier, not 'unknown'", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-approvals-risk-e2e-",
      beforeLaunch: (userDataDir) => {
        seedPendingApprovals(userDataDir, SEEDED);
      },
    });

    try {
      await gotoNav(page, "approvals");
      await expect(
        page.getByRole("heading", { name: "Approvals", level: 2 })
      ).toBeVisible();

      // Locate each card as the smallest element holding its unique reason text
      // and the action buttons, matching approvals-flow.spec.ts.
      const cardFor = (reason: string) =>
        page
          .locator("div")
          .filter({ hasText: reason })
          .filter({ has: page.getByRole("button", { name: "Approve" }) })
          .last();

      for (const seed of SEEDED) {
        const card = cardFor(seed.reason);
        await expect(card.getByText(seed.reason)).toBeVisible();
        // The badge shows the seeded tier and never the "unknown" fallback.
        await expect(
          card.getByText(seed.riskTier as string, { exact: true })
        ).toBeVisible();
        await expect(card.getByText("unknown", { exact: true })).toHaveCount(0);
      }

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
