import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { z } from "zod";
import { signDesktopPopHeaders } from "../../src/main/auth/desktop-pop.js";
import {
  type DesktopSessionTokens,
  refreshDesktopSession,
} from "../../src/main/session/desktop-session-client.js";
import type { DesktopSessionRecord } from "../../src/main/session/desktop-session-store.js";
import { dataSyncLevelToBooleans } from "../../src/shared/data-sync-level.js";
import { E2E_DESKTOP_SETTINGS_SEED } from "../../test/e2e/helpers/e2e-desktop-settings-seed";
import { readVibeAuthMaterial } from "./auth-material";
import {
  resolveElectronBinary,
  VIBE_UNROUTABLE_RELAY_ORIGIN,
  type VibeProfileOrigins,
  vibeProfileLaunchEnv,
} from "./launch-env";
import { VibeOriginKind } from "./origin-policy";
import {
  mergeProfileSettings,
  VIBE_PROFILE_FILE,
  vibeProfilePath,
} from "./profile-layout";

const REFRESH_PATH = "/desktop/session/refresh";
const SAFE_STORAGE_HELPER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "safe-storage-encrypt.mjs"
);

const encryptedPayloadSchema = z.object({
  session: z.string().min(1),
  signingKey: z.string().min(1),
});

export type VibeSignInOrigins = VibeProfileOrigins & {
  readonly originKind: VibeOriginKind;
};

/**
 * Signs the prepared profile in to the local stack or a stage branch preview:
 *
 * 1. Refreshes the seeded session once through the Desktop's own client
 *    (`refreshDesktopSession`, PoP-signed with the profile's key). This proves
 *    the API holds the session rows for this profile's auth material (written
 *    by `stages/desktop-auth.ts` locally, or from `auth-claim` on a preview)
 *    and yields the account the record names, and it rotates the token the way
 *    every launch does.
 * 2. Encrypts the rotated record and the signing key with Electron safeStorage
 *    (`safe-storage-encrypt.mjs`) and writes them where `DesktopSessionStore`
 *    and `GatewaySigningKeyStore` read them, as the authenticated e2e fixture
 *    does (`seedAuthenticatedDesktopSession`).
 * 3. Points the profile's saved config at the origins, with the relay on an
 *    unroutable address, as control's authenticated fixture does.
 *
 * The next launch of the profile restores through the production refresh lane.
 */
export async function signInVibeProfile(
  profileDir: string,
  origins: VibeSignInOrigins,
  log: (message: string) => void
): Promise<{ userId: string; organizationId: string }> {
  if (!existsSync(vibeProfilePath(profileDir, VIBE_PROFILE_FILE.Store))) {
    throw new Error(`${profileDir} is not a prepared vibe profile (no store)`);
  }
  if (existsSync(vibeProfilePath(profileDir, VIBE_PROFILE_FILE.Session))) {
    throw new Error(
      `${profileDir} is already signed in; its refresh token has rotated past the auth material, so prepare a fresh profile`
    );
  }
  const { material, privateKeyPkcs8Pem } = readVibeAuthMaterial(profileDir);
  const tokens = await refreshSeededSession(
    origins,
    material.refreshToken,
    material.gatewayId,
    privateKeyPkcs8Pem
  );
  log(`refreshed the seeded session for user ${tokens.userId}`);
  const record: DesktopSessionRecord = {
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    userId: tokens.userId,
    organizationId: tokens.organizationId,
    gatewayId: material.gatewayId,
  };
  const encrypted = await encryptWithSafeStorage(profileDir, origins, {
    serializedSession: JSON.stringify(record),
    privateKeyPkcs8Pem,
  });
  writeFileSync(
    vibeProfilePath(profileDir, VIBE_PROFILE_FILE.Session),
    JSON.stringify({ encryptedSession: encrypted.session }),
    { mode: 0o600 }
  );
  writeFileSync(
    vibeProfilePath(profileDir, VIBE_PROFILE_FILE.SigningKeys),
    JSON.stringify({
      encryptedPrivateKeysByGatewayId: {
        [material.gatewayId]: encrypted.signingKey,
      },
    }),
    { mode: 0o600 }
  );
  mergeProfileSettings(
    profileDir,
    vibeDesktopSettings(origins, material.gatewayId, tokens.organizationId)
  );
  log(
    `wrote the encrypted session, signing key and ${SIGN_IN_TARGET[origins.originKind].settingsLabel} settings`
  );
  return { userId: tokens.userId, organizationId: tokens.organizationId };
}

/**
 * The settings patch control's authenticated Desktop fixture applies, with two
 * differences for a vibe profile (ISS-12135 bug 48).
 *
 * Its data sync level is Off, persisted with the connectivity flags Off
 * derives (`dataSyncLevelToBooleans`) and the seed's recorded consent answer
 * left as it is: the state the standard Electron E2E seed boots into
 * (`test/settings-migration-e2e-seed-consent.test.ts`). Neither a vibe stack
 * nor a branch preview runs a relay, and session sync names its compute target
 * from the relay's hello, so nothing from this Desktop could reach either
 * backend; Off says so, where an enabled connection to an unroutable relay left
 * the startup banner reporting a degraded cloud forever. Reads are unaffected: the renderer
 * reads the cloud whenever it is signed in and online.
 *
 * And the top-level `relayOrigin` is written beside `apiOrigin`. Without it the
 * boot migration reads a lone `apiOrigin` as a legacy relay URL, moves it into
 * `relayOrigin` and resets `apiOrigin` to the build's default.
 *
 * The seeded organization's invite spotlight is answered too (bug 50), the way
 * the seed marks the org's other onboarding done: a vibe renderer is served
 * from a new origin each launch, so its own `localStorage` answer never lasts.
 */
export function vibeDesktopSettings(
  origins: VibeSignInOrigins,
  gatewayId: string,
  organizationId: string
): Record<string, unknown> {
  const target = SIGN_IN_TARGET[origins.originKind];
  return {
    ...E2E_DESKTOP_SETTINGS_SEED,
    ...vibeSyncOff(),
    activeConfigId: target.configId,
    apiOrigin: origins.apiOrigin,
    inviteSpotlightAnsweredOrganizationIds: [organizationId],
    relayOrigin: VIBE_UNROUTABLE_RELAY_ORIGIN,
    savedConfigs: [
      {
        apiOrigin: origins.apiOrigin,
        gatewayId,
        id: target.configId,
        name: target.configName ?? origins.apiOrigin,
        relayOrigin: VIBE_UNROUTABLE_RELAY_ORIGIN,
        webAppOrigin: origins.webOrigin,
      },
    ],
  };
}

async function refreshSeededSession(
  origins: VibeSignInOrigins,
  refreshToken: string,
  gatewayId: string,
  privateKeyPkcs8Pem: string
): Promise<DesktopSessionTokens> {
  const { apiOrigin } = origins;
  const target = SIGN_IN_TARGET[origins.originKind];
  await warmRefreshRoute(apiOrigin, target.warmupTimeoutMs);
  const result = await refreshDesktopSession({
    apiOrigin,
    refreshToken,
    popSigner: (request) =>
      signDesktopPopHeaders({ ...request, gatewayId, privateKeyPkcs8Pem }),
  });
  if (!result.ok) {
    throw new Error(
      `POST ${apiOrigin}${REFRESH_PATH} failed: ${result.error}. ${target.refreshFailureHint}`
    );
  }
  return result.value;
}

/**
 * A dev API compiles a route on its first request, and a preview's function
 * may start cold; either can outlast the Desktop client's request timeout. A
 * refresh that times out client-side but completes on the server rotates the
 * token out from under this profile, and presenting the old one again revokes
 * the whole family, so the route is woken first by a request with no effect
 * (GET on a POST-only route).
 */
async function warmRefreshRoute(
  apiOrigin: string,
  timeoutMs: number
): Promise<void> {
  try {
    await fetch(new URL(REFRESH_PATH, apiOrigin), {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `the API at ${apiOrigin} did not answer: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function encryptWithSafeStorage(
  profileDir: string,
  origins: VibeProfileOrigins,
  payload: { serializedSession: string; privateKeyPkcs8Pem: string }
): Promise<z.infer<typeof encryptedPayloadSchema>> {
  const launch = vibeProfileLaunchEnv(profileDir, origins);
  const electronBinary = resolveElectronBinary();
  return new Promise((resolve, reject) => {
    const child = spawn(
      electronBinary,
      safeStorageHelperArgs(SAFE_STORAGE_HELPER, launch.args),
      {
        env: {
          ...process.env,
          ...launch.env,
          VIBE_SAFE_STORAGE_PAYLOAD: JSON.stringify(payload),
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout.trim().split("\n").at(-1) ?? "";
      if (code !== 0 || line.length === 0) {
        reject(
          new Error(`safe-storage helper exited ${code}: ${stderr.trim()}`)
        );
        return;
      }
      try {
        resolve(encryptedPayloadSchema.parse(JSON.parse(line)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * The safe-storage helper's Electron arguments (ISS-12043). On Linux they lead
 * with `--no-sandbox`, as Playwright's Electron loader does for every Desktop
 * E2E launch, because a CI runner's `chrome-sandbox` is not root-owned with
 * mode 4755 and Electron aborts before the helper runs. They also select
 * basic_text, the backend the walk's Playwright launch decrypts with (its
 * loader appends `--password-store=basic`); a headless keyring has no default
 * collection, and creating one opens a prompt nobody answers. The helper
 * enables plain-text encryption itself (`safe-storage-encrypt.mjs`).
 */
export function safeStorageHelperArgs(
  helper: string,
  launchArgs: readonly string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  const linux =
    platform === "linux" ? ["--no-sandbox", "--password-store=basic"] : [];
  return [...linux, helper, ...launchArgs];
}

type SignInTarget = {
  readonly configId: string;
  readonly configName: string | null;
  readonly settingsLabel: string;
  readonly warmupTimeoutMs: number;
  readonly refreshFailureHint: string;
};

/**
 * Per origin kind. The loopback entry is what `sign-in` always wrote. A
 * preview gets its own saved-config id so a profile never mistakes one for
 * the other, and a shorter warmup: nothing compiles there, so a minute without
 * an answer means the preview is not serving.
 */
const SIGN_IN_TARGET: Record<VibeOriginKind, SignInTarget> = {
  [VibeOriginKind.Loopback]: {
    configId: "vibe-local-stack",
    configName: "Vibe local stack",
    settingsLabel: "local-stack",
    warmupTimeoutMs: 300_000,
    refreshFailureHint:
      "The API needs the desktop-auth seed stage's rows for this profile's auth material and DESKTOP_SESSION_JWT_SECRET set.",
  },
  [VibeOriginKind.BranchPreview]: {
    configId: "vibe-branch-preview",
    configName: null,
    settingsLabel: "branch-preview",
    warmupTimeoutMs: 60_000,
    refreshFailureHint:
      "The preview needs this profile's `vibe:profile auth-claim` registered for your user in the branch's preview schema, and DESKTOP_SESSION_JWT_SECRET set on the preview API.",
  },
};

/** Data sync level Off and the three connectivity flags it derives. */
function vibeSyncOff(): Record<string, unknown> {
  const off = dataSyncLevelToBooleans(DataSyncLevel.Off);
  return {
    dataSyncLevel: DataSyncLevel.Off,
    cloudConnectionEnabled: off.cloudConnectionEnabled,
    cloudCommandsPaused: off.cloudCommandsPaused,
    transcriptSyncEnabled: off.transcriptSyncEnabled,
  };
}
