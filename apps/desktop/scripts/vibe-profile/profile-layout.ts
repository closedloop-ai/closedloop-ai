import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HARNESS_HOME_ENV_KEYS } from "../../test/helpers/isolated-harness-homes";

/**
 * The on-disk layout of a vibe Desktop profile (ISS-12017). The profile dir is
 * the Electron `userData` dir the vibe environment launches with, so the store
 * and the auth files sit where the app itself reads them.
 */
export const VIBE_PROFILE_FILE = {
  Store: "agent-dashboard.sqlite",
  CorpusStore: "vibe-corpus-store.sqlite",
  AuthMaterial: "auth-material.json",
  SigningKey: "auth-signing-key.pem",
  Manifest: "vibe-profile.json",
  Settings: "desktop-settings.json",
  Session: "desktop-session.json",
  SigningKeys: "desktop-gateway-signing-keys.json",
} as const;

/** Collector homes live under the profile so they persist with it. */
export const VIBE_HARNESS_HOMES_DIR = "harness-homes";

export type HarnessHomeKey = (typeof HARNESS_HOME_ENV_KEYS)[number];

export const DESKTOP_APP_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);
export const REPO_ROOT = path.resolve(DESKTOP_APP_DIR, "..", "..");

/**
 * `<profile>/harness-homes/<KEY>` for every collector home in
 * `HARNESS_HOME_ENV_KEYS`, the one list the e2e harness also isolates with.
 */
export function vibeProfileHarnessHomes(
  profileDir: string
): Record<HarnessHomeKey, string> {
  const root = path.join(path.resolve(profileDir), VIBE_HARNESS_HOMES_DIR);
  return Object.fromEntries(
    HARNESS_HOME_ENV_KEYS.map((key) => [key, path.join(root, key)])
  ) as Record<HarnessHomeKey, string>;
}

export function vibeProfilePath(
  profileDir: string,
  file: (typeof VIBE_PROFILE_FILE)[keyof typeof VIBE_PROFILE_FILE]
): string {
  return path.join(path.resolve(profileDir), file);
}

export type ProfileDirPolicy = {
  readonly repoRoot: string;
  /** Whether git ignores `absolutePath` (relative to `repoRoot`). */
  readonly isIgnored: (absolutePath: string) => boolean;
};

/**
 * A profile holds a refresh token, a signing key and a copy of the golden
 * corpus. Inside the repo it must be somewhere git ignores, or one `git add -A`
 * commits a credential; anywhere outside the repo is fine.
 */
export function assertProfileDirAllowed(
  profileDir: string,
  policy: ProfileDirPolicy
): string {
  const absolute = path.resolve(profileDir);
  const relative = path.relative(path.resolve(policy.repoRoot), absolute);
  const insideRepo =
    relative === "" ||
    !(relative.startsWith("..") || path.isAbsolute(relative));
  if (!insideRepo) {
    return absolute;
  }
  if (relative === "") {
    throw new Error("refusing to use the repository root as a Desktop profile");
  }
  if (!policy.isIgnored(absolute)) {
    throw new Error(
      `refusing to write a Desktop profile inside the repository at ${relative}: git does not ignore it. Use a directory outside the repo or an ignored one such as .control/.`
    );
  }
  return absolute;
}

/** The real policy: `git check-ignore` against this checkout. */
export const gitProfileDirPolicy: ProfileDirPolicy = {
  repoRoot: REPO_ROOT,
  isIgnored: (absolutePath) =>
    spawnSync("git", ["-C", REPO_ROOT, "check-ignore", "-q", absolutePath], {
      stdio: "ignore",
    }).status === 0,
};

/** Read-merge-write the profile's `desktop-settings.json`, keeping every key the patch does not name. */
export function mergeProfileSettings(
  profileDir: string,
  patch: Record<string, unknown>
): void {
  const settingsPath = vibeProfilePath(profileDir, VIBE_PROFILE_FILE.Settings);
  const existing = existsSync(settingsPath)
    ? z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(readFileSync(settingsPath, "utf8")))
    : {};
  writeFileSync(
    settingsPath,
    JSON.stringify({ ...existing, ...patch }, null, 2)
  );
}
