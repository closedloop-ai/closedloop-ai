/**
 * E2E deep flow: Approvals — approve and deny seeded pending requests.
 *
 * Seeds the main-process ApprovalStore by writing its electron-store file
 * (`<userData>/desktop-approvals.json`) before launch, so the Approvals panel
 * has a populated queue at boot. Then approves one request and denies another
 * and asserts the queue drains to its empty state.
 *
 * Also carries the regression for the panel's background poll (second test):
 * the poll used to re-raise the panel's loading state, tearing the whole pending
 * queue out of the DOM and rebuilding it on every 3s tick.
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

/**
 * Stamped onto a live Deny button so a rebuild of the queue is detectable: the
 * attribute is one React never writes, so a subtree it re-mounted arrives
 * without it.
 */
const POLL_WITNESS_ATTR = "data-e2e-poll-witness";

/**
 * The one IPC this spec reaches for directly, as a local shape (the pattern
 * `trace-comments-ipc.spec.ts` uses). The e2e project's ambient
 * `Window.desktopApi` is a narrow global declared by an unrelated spec and
 * carries only the auth reader, and widening a global another spec owns to serve
 * this one is the wrong seam.
 */
type ApprovalsDesktopWindow = {
  desktopApi?: { denyApproval?: (approvalId: string) => Promise<unknown> };
};

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
        page.getByRole("heading", { name: "Approvals", level: 1 })
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

  test("keeps a pending request's controls mounted across the background poll", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-approvals-poll-e2e-",
      beforeLaunch: (userDataDir) => {
        seedPendingApprovals(userDataDir, SEEDED);
      },
    });

    try {
      await gotoNav(page, "approvals");

      // Anchored on the card slot, not on label text, and filtered to the
      // VISIBLE one: the renderer keeps sibling nav views mounted-but-hidden, so
      // a page-wide lookup can match a card this test does not mean.
      const visibleCardFor = (reason: string) =>
        page
          .locator('[data-slot="card"]')
          .filter({
            has: page.getByRole("button", { exact: true, name: "Approve" }),
          })
          .filter({ hasText: reason })
          .locator("visible=true")
          .first();
      const pendingCard = visibleCardFor(SEEDED[1].reason);
      const denyButton = pendingCard.getByRole("button", {
        exact: true,
        name: "Deny",
      });
      await expect(denyButton).toBeVisible();

      // The card the poll must REMOVE, resolved through the same scoped locator
      // as the one it must keep. Asserting it present here is what makes the
      // absence below a proof: `not.toBeVisible()` also passes on a locator that
      // matches nothing, so without this anchor a card that never rendered would
      // satisfy the wait at t≈0 — no tick elapsed, and the regression assertion
      // after it trivially green under the very mutation it exists to catch.
      const pollTargetCard = visibleCardFor(SEEDED[0].reason);
      await expect(pollTargetCard).toBeVisible();

      // Stamp the live node, then give the poll something it must DELIVER: the
      // OTHER seeded request is resolved straight through the IPC, behind the
      // panel's back. Nothing in the renderer knows, so the only thing that can
      // take that card off screen is the 3s background re-read — which makes its
      // disappearance an awaited proof that a poll ran, in place of a sleep that
      // proved only that time passed.
      await denyButton.evaluate((el, attr) => {
        el.setAttribute(attr, "1");
      }, POLL_WITNESS_ATTR);
      await page.evaluate((id) => {
        const api = (window as ApprovalsDesktopWindow).desktopApi;
        if (!api?.denyApproval) {
          throw new Error("desktopApi.denyApproval is unavailable");
        }
        return api.denyApproval(id);
      }, SEEDED[0].id);
      await expect(pollTargetCard).not.toBeVisible({ timeout: 15_000 });

      // THE REGRESSION. That poll redrew the queue with one row fewer, and the
      // row the user is still reaching for had to ride through it on the same
      // node. Re-raising the loading state on a tick swapped the whole queue out
      // for the loading text and back, which mounts a NEW button and drops the
      // mark — so this reddens on the teardown, while the wait above reddens if
      // the poll stops re-reading at all.
      await expect(denyButton).toHaveAttribute(POLL_WITNESS_ATTR, "1");

      // And the control the poll left alone is still the one that works.
      await denyButton.click();
      await expect(page.getByText(SEEDED[1].reason)).not.toBeVisible({
        timeout: 15_000,
      });

      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
