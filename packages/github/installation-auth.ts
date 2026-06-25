import "server-only";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { keys } from "./keys";

/**
 * Create an installation-authenticated Octokit for app-owned GitHub reads and
 * sync operations. User-authored comment mutations must keep using user-token
 * helpers from `comment-user-token`.
 */
export async function getInstallationOctokit(
  installationId: string
): Promise<Octokit> {
  return new Octokit({
    auth: await createInstallationToken(installationId),
  });
}

/**
 * Generate a short-lived installation token for app-owned GitHub operations.
 */
export function getInstallationAccessToken(
  installationId: string
): Promise<string> {
  return createInstallationToken(installationId);
}

async function createInstallationToken(
  installationId: string
): Promise<string> {
  const config = keys();
  const auth = createAppAuth({
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_APP_PRIVATE_KEY,
  });

  const installationAuth = await auth({
    type: "installation",
    installationId: Number.parseInt(installationId, 10),
  });

  return installationAuth.token;
}
