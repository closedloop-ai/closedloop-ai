import { createRequire } from "node:module";
import path from "node:path";
import { VIBE_SEED_MACHINE_NAME } from "@repo/api/src/vibe-seed-corpus";
import { E2E_EPHEMERAL_LOOPBACK_PORTS_ARG } from "../../src/main/lifecycle/loopback-port-isolation.js";
import { DESKTOP_MACHINE_NAME_ENV } from "../../src/main/machine-name.js";
import { DEV_UPDATE_CHECK_DISABLED_ENV } from "../../src/main/update/dev-update-check-gate.js";
import { vibeProfileHarnessHomes } from "./profile-layout";

/**
 * Port 9 (discard) on loopback: nothing listens, so the relay socket fails fast
 * instead of reaching the production relay. The same address control's
 * authenticated Desktop fixture uses (`UNROUTABLE_RELAY_ORIGIN`).
 */
export const VIBE_UNROUTABLE_RELAY_ORIGIN = "http://127.0.0.1:9";

export const USER_DATA_DIR_ARG = "--user-data-dir=";

export type VibeProfileOrigins = {
  readonly apiOrigin: string;
  readonly webOrigin: string;
};

export type VibeProfileLaunch = {
  readonly env: Record<string, string>;
  readonly args: string[];
};

/**
 * Everything a launcher must set to open the vibe profile: the collector homes
 * pinned inside the profile (so the operator's real ~/.claude, ~/.codex and the
 * rest are never read, and the pack files `prepare` placed are what the pack
 * scanner sees), `CLAUDE_CONFIG_DIR` pinned to the profile's Claude home (the
 * Session Mesh hook installer reads it ahead of `CLAUDE_HOME`, so a launching
 * shell that sets it would otherwise get the profile's hooks written into the
 * operator's real Claude config; ISS-12135), the API and web origins (`src/shared/contracts.ts` reads the
 * three `CL_*_ORIGIN` overrides), the seeded machine name (so this Desktop names
 * itself the compute target the web seed attributed its sessions to; ISS-12135),
 * the dev update check turned off (the build is the session's worktree, not a
 * release behind `origin/main`; ISS-12135), Electron's `--user-data-dir`, and
 * the ephemeral loopback ports argument (so the agent hook listener and the
 * OTLP receiver never take 4820 and 4318 from the operator's installed Desktop,
 * whichever starts first; ISS-12135). The profile does not sync: neither a vibe
 * stack nor a branch preview runs a relay, so it starts at data sync level Off
 * (`vibeDesktopSettings` in `sign-in.ts`).
 *
 * Used by `sign-in` for its own Electron launch and by `launch`, and printed by
 * `launch-env` for the vibe CLI, so all of them launch with one environment.
 */
export function vibeProfileLaunchEnv(
  profileDir: string,
  origins: VibeProfileOrigins
): VibeProfileLaunch {
  const harnessHomes = vibeProfileHarnessHomes(profileDir);
  return {
    env: {
      ...harnessHomes,
      CLAUDE_CONFIG_DIR: harnessHomes.CLAUDE_HOME,
      CL_AUTH_API_ORIGIN: origins.apiOrigin,
      CL_WEB_APP_ORIGIN: origins.webOrigin,
      CL_RELAY_ORIGIN: VIBE_UNROUTABLE_RELAY_ORIGIN,
      CLOSEDLOOP_DESKTOP_TELEMETRY_EGRESS: "0",
      [DESKTOP_MACHINE_NAME_ENV]: VIBE_SEED_MACHINE_NAME,
      [DEV_UPDATE_CHECK_DISABLED_ENV]: "1",
    },
    args: [
      `${USER_DATA_DIR_ARG}${path.resolve(profileDir)}`,
      E2E_EPHEMERAL_LOOPBACK_PORTS_ARG,
    ],
  };
}

/** The `electron` package resolves to its platform binary when required. */
export function resolveElectronBinary(): string {
  const binary: unknown = createRequire(import.meta.url)("electron");
  if (typeof binary !== "string") {
    throw new Error("the electron package did not resolve to a binary path");
  }
  return binary;
}
