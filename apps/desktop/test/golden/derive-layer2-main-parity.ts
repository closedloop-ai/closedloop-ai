/**
 * ISS-12552: writes `layer2-main-parity.json` from main's
 * Layer 2 snapshots at a commit, read from git rather than the working tree,
 * because this branch's `layer2-snapshots/` is the attribution set. From
 * `apps/desktop`:
 *
 *   pnpm exec tsx test/golden/derive-layer2-main-parity.ts <main commit>
 *
 * The commit is the branch's merge base with main. Rerun and confirm the file
 * is byte-identical.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  MAIN_PARITY_MANIFEST_PATH,
  MAIN_PARITY_MASKED_COLUMNS,
  type MainParityManifest,
  maskedTableDigests,
  parseLayer2SnapshotTables,
} from "./golden-layer2-main-parity.js";

const MAIN_SNAPSHOT_DIR = "apps/desktop/test/golden/layer2-snapshots";
// A single snapshot runs to a few MB; the default 1 MB buffer truncates it.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function git(args: string[]): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
}

const ref = process.argv[2];
if (!ref) {
  throw new Error("usage: derive-layer2-main-parity.ts <main commit>");
}
const mainCommit = git(["rev-parse", `${ref}^{commit}`]).trim();
const names = git([
  "ls-tree",
  "--full-tree",
  "--name-only",
  `${mainCommit}:${MAIN_SNAPSHOT_DIR}`,
])
  .split("\n")
  .filter((name) => name.endsWith(".json"))
  .sort();
const dossiers: MainParityManifest["dossiers"] = {};
for (const name of names) {
  dossiers[name.slice(0, -".json".length)] = maskedTableDigests(
    parseLayer2SnapshotTables(
      git(["show", `${mainCommit}:${MAIN_SNAPSHOT_DIR}/${name}`])
    )
  );
}
const manifest: MainParityManifest = {
  mainCommit,
  maskedColumns: Object.fromEntries(
    Object.entries(MAIN_PARITY_MASKED_COLUMNS).map(([table, columns]) => [
      table,
      [...columns],
    ])
  ),
  dossiers,
};
writeFileSync(
  MAIN_PARITY_MANIFEST_PATH,
  `${JSON.stringify(manifest, null, 2)}\n`
);
