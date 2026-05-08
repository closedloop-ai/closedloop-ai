import {
  createProjectViaDialog,
  createTeamViaSidebar,
} from "./helpers/dialog-flows";
import { authenticateToApp } from "./helpers/sign-in";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const RE_TEAMS_URL = /\/teams\//;

test("create a team then a project and land on project detail", async ({
  page,
}) => {
  const teamName = createUniqueName("e2e-team");
  const projectName = createUniqueName("e2e-project");

  // Step 1: Create a team
  await authenticateToApp(page, { fresh: true });

  await createTeamViaSidebar(page, teamName);
  await page.waitForURL(RE_TEAMS_URL, { timeout: 30_000 });

  // Step 2: Create a project (should now be on /teams/{id}/projects)
  const projectDialog = await createProjectViaDialog(page, projectName);
  await expect(projectDialog).not.toBeVisible({ timeout: 15_000 });

  // Should land on project detail page
  await expect(page.getByText(projectName).first()).toBeVisible({
    timeout: 30_000,
  });
});
