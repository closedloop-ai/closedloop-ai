import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getPackagingStageRoot } from "./packaging-stage-path.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const stageRoot = getPackagingStageRoot();

await stat(stageRoot).catch(() => {
  throw new Error(
    "Packaging app is missing. Run `pnpm stage:package` before invoking electron-builder."
  );
});

// Defensive guard for the missing-signing-secret failure mode.
//
// Signed/notarized release builds set all five Apple signing + notarization env
// vars. If they are referenced but not actually provided, the vars arrive
// DEFINED-BUT-EMPTY (""). Two distinct failure modes follow, both of which we
// fail fast on here rather than producing a broken release:
//   - empty CSC_LINK: electron-builder treats it as a certificate file path,
//     resolves it to the project directory, and dies with the cryptic
//     `⨯ <projectDir> not a file`.
//   - empty APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID: when
//     notarization is enabled, electron-builder silently SKIPS notarization (it
//     only warns) and ships a signed-but-un-notarized DMG that Gatekeeper
//     blocks on install — a green build that yields an unusable artifact.
// So all five must be present together for the release signing path.
//
// Unset (not just empty) vars are intentionally allowed: that is the local /
// ad-hoc build path (electron-builder ad-hoc-signs, notarization is skipped by
// design), so we must not require signing there. This is the default for
// community/local builds — no Apple credentials needed.
const emptyDefinedSigningVars = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
].filter(
  (name) => name in process.env && (process.env[name] ?? "").trim() === ""
);
if (emptyDefinedSigningVars.length > 0) {
  throw new Error(
    [
      `macOS signing/notarization env var(s) defined but empty: ${emptyDefinedSigningVars.join(", ")}.`,
      "For a signed + notarized release, provide all five: CSC_LINK,",
      "CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.",
      "",
      "To build locally WITHOUT signing, unset CSC_LINK/CSC_KEY_PASSWORD entirely",
      "(leave them undefined) so electron-builder ad-hoc-signs the app.",
    ].join("\n")
  );
}

const electronBuilderArgs = [
  "--mac",
  "--config",
  "electron-builder.yml",
  `-c.directories.app=${stageRoot}`,
  ...process.argv.slice(2),
];

const electronBuilderResult = spawnSync(
  "electron-builder",
  electronBuilderArgs,
  {
    cwd: appDir,
    stdio: "inherit",
  }
);

if (electronBuilderResult.error) {
  throw electronBuilderResult.error;
}

process.exit(electronBuilderResult.status ?? 1);
