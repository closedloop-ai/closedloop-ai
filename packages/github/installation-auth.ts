import "server-only";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { keys } from "./keys";

type InstallationTokenCacheEntry = {
  token: string;
  expiresAt: number;
};

const INSTALLATION_TOKEN_EXPIRY_SKEW_MS = 60_000;
const INSTALLATION_AUTH_CACHE_MAX_ENTRIES = 500;
const installationTokenCache = new Map<string, InstallationTokenCacheEntry>();
const installationOctokitCache = new Map<
  string,
  { token: string; octokit: Octokit }
>();
let appAuth: ReturnType<typeof createAppAuth> | null = null;

/**
 * Create an installation-authenticated Octokit for app-owned GitHub reads and
 * sync operations. User-authored comment mutations must keep using user-token
 * helpers from `comment-user-token`.
 */
export async function getInstallationOctokit(
  installationId: string
): Promise<Octokit> {
  const token = await createInstallationToken(installationId);
  pruneInstallationOctokitCache(token);
  const cached = installationOctokitCache.get(installationId);
  if (cached?.token === token) {
    return cached.octokit;
  }

  const octokit = new Octokit({ auth: token });
  installationOctokitCache.set(installationId, { token, octokit });
  pruneOldestCacheEntries(installationOctokitCache);
  return octokit;
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
  pruneInstallationTokenCache();
  const cached = installationTokenCache.get(installationId);
  if (
    cached &&
    cached.expiresAt > Date.now() + INSTALLATION_TOKEN_EXPIRY_SKEW_MS
  ) {
    return cached.token;
  }

  const installationAuth = await getAppAuth()({
    type: "installation",
    installationId: Number.parseInt(installationId, 10),
  });

  const expiresAt = Date.parse(installationAuth.expiresAt);
  if (Number.isFinite(expiresAt)) {
    installationTokenCache.set(installationId, {
      token: installationAuth.token,
      expiresAt,
    });
    pruneOldestCacheEntries(installationTokenCache);
  }
  return installationAuth.token;
}

function getAppAuth() {
  if (appAuth) {
    return appAuth;
  }
  const config = keys();
  appAuth = createAppAuth({
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_APP_PRIVATE_KEY,
  });
  return appAuth;
}

export function resetInstallationAuthCachesForTests(): void {
  appAuth = null;
  installationTokenCache.clear();
  installationOctokitCache.clear();
}

function pruneInstallationTokenCache(now = Date.now()): void {
  const expiredAt = now + INSTALLATION_TOKEN_EXPIRY_SKEW_MS;
  for (const [installationId, entry] of installationTokenCache) {
    if (entry.expiresAt <= expiredAt) {
      installationTokenCache.delete(installationId);
      installationOctokitCache.delete(installationId);
    }
  }
}

function pruneInstallationOctokitCache(currentToken: string): void {
  for (const [installationId, entry] of installationOctokitCache) {
    const tokenEntry = installationTokenCache.get(installationId);
    if (!(tokenEntry && entry.token === tokenEntry.token)) {
      installationOctokitCache.delete(installationId);
    }
  }
  for (const [installationId, entry] of installationOctokitCache) {
    if (
      entry.token !== currentToken &&
      !installationTokenCache.has(installationId)
    ) {
      installationOctokitCache.delete(installationId);
    }
  }
}

function pruneOldestCacheEntries<T>(cache: Map<string, T>): void {
  while (cache.size > INSTALLATION_AUTH_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) {
      return;
    }
    cache.delete(oldestKey);
    installationOctokitCache.delete(oldestKey);
  }
}
