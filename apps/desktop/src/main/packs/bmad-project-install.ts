/**
 * @file bmad-project-install.ts — detect a BMad v6+ install inside one project
 * root and read its version from the project manifest.
 *
 * Moved out of pack-scanner.ts (ISS-11914) so that grandfathered file does not
 * grow; behavior is unchanged.
 */

import path from "node:path";
import { safeReadDir, safeReadFile, safeStat } from "./skill-files.js";

const LINE_BREAK = /\r?\n/;
const INSTALLATION_KEY = /^installation:\s*$/;
const TOP_LEVEL_KEY = /^[A-Za-z_][^:]*:/;
const INSTALLATION_VERSION =
  /^\s+version:\s*['"]?([0-9][0-9A-Za-z.\-+]*)['"]?\s*$/;

/**
 * Parse the project-local BMad install manifest (`_bmad/_config/manifest.yaml`)
 * to extract the installed version.
 */
export function readBmadProjectManifest(
  projectRoot: string
): { version: string } | null {
  const manifestPath = path.join(
    projectRoot,
    "_bmad",
    "_config",
    "manifest.yaml"
  );
  const content = safeReadFile(manifestPath);
  if (!content) {
    return null;
  }
  const lines = content.split(LINE_BREAK);
  let inInstallation = false;
  for (const raw of lines) {
    if (INSTALLATION_KEY.test(raw)) {
      inInstallation = true;
      continue;
    }
    if (inInstallation && TOP_LEVEL_KEY.test(raw) && !raw.startsWith(" ")) {
      break;
    }
    if (inInstallation) {
      const m = raw.match(INSTALLATION_VERSION);
      if (m) {
        return { version: m[1] };
      }
    }
  }
  return null;
}

/**
 * Detect a BMad v6+ project install: project root has `.agents/skills/bmad-*`
 * directories with SKILL.md files.
 */
export function detectBmadProjectInstall(
  projectRoot: string
): { installPath: string; version: string | null } | null {
  const skillsRoot = path.join(projectRoot, ".agents", "skills");
  if (!safeStat(skillsRoot)) {
    return null;
  }
  const hasBmadSkill = safeReadDir(skillsRoot).some(
    (e) =>
      (e.isDirectory() || e.isSymbolicLink()) &&
      e.name.startsWith("bmad-") &&
      safeStat(path.join(skillsRoot, e.name, "SKILL.md"))
  );
  if (!hasBmadSkill) {
    return null;
  }
  const manifest = readBmadProjectManifest(projectRoot);
  return {
    installPath: skillsRoot,
    version: manifest ? manifest.version : null,
  };
}
