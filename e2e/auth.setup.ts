// SECURITY: This file handles authentication credentials. The storageState output
// (.auth/user.json) contains session tokens that grant full app access. Never commit
// .auth/user.json or expose it in public artifact stores. See playwright.config.ts
// for the WARNING comment on test-results/.
import { authenticateToApp } from "./helpers/sign-in";
import { test as setup } from "./test";

setup("authenticate", async ({ page }) => {
  await authenticateToApp(page);
  await page.context().storageState({ path: ".auth/user.json" });
});
