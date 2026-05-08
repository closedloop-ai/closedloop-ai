import { createTeamViaSidebar } from "./helpers/dialog-flows";
import { authenticateToApp } from "./helpers/sign-in";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const RE_TEAMS_URL = /\/teams\//;

test("create a team via sidebar and verify it appears", async ({ page }) => {
  const teamName = createUniqueName("e2e-team");

  await authenticateToApp(page, { fresh: true });

  const dialog = await createTeamViaSidebar(page, teamName);

  await page.waitForURL(RE_TEAMS_URL, { timeout: 30_000 });
  await expect(dialog).not.toBeVisible({ timeout: 30_000 });

  // The team should appear in the sidebar
  await expect(page.getByText(teamName).first()).toBeVisible({
    timeout: 30_000,
  });
});
