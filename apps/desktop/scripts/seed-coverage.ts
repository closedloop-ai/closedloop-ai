import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSeedCoverageDirectory,
  type SeedCoverage,
} from "@repo/api/src/seed-coverage";

/** Repo-relative, for failure messages an engineer can act on. */
export const DESKTOP_SEED_COVERAGE_DIR_LABEL =
  "apps/desktop/prisma/seed-coverage";

export const DESKTOP_SEED_COVERAGE_DIR = fileURLToPath(
  new URL("../prisma/seed-coverage/", import.meta.url)
);

/** Reads and validates every Desktop seed coverage file (ISS-12017). */
export function loadDesktopSeedCoverage(
  coverageDir: string = DESKTOP_SEED_COVERAGE_DIR
): SeedCoverage {
  return parseSeedCoverageDirectory(readdirSync(coverageDir), (fileName) =>
    readFileSync(path.join(coverageDir, fileName), "utf8")
  );
}
