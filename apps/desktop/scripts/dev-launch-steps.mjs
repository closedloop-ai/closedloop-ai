// @ts-check
/**
 * Which `pnpm run` scripts a dev launch rebuilds before it spawns Electron.
 *
 * Split out of `dev-launch.mjs` so the decision is reachable from a test: that
 * module is a top-level-await script that starts a Vite server and an Electron
 * process on import, so nothing about it can be asserted in place.
 */

/**
 * Launch with the `dist/` output already on disk instead of rebuilding it.
 *
 * ISS-8252: `build:main:dev` runs `build:main`, whose main compile EMPTIES
 * `dist/main` before re-emitting it — and `dist/main/index.js` is the entry
 * every other desktop E2E spec launches. Playwright runs this suite on two
 * workers, so a launcher rebuilding in one spec deletes that entry out from
 * under a spec launching in another: measured 2026-08-28 on run 33203453180,
 * `session-detail-branch-link` failed with `Cannot find module
 * .../dist/main/index.js` 22s into the sidecar spec and passed on a retry 4s
 * after the rebuild finished. A caller that already built `dist/` — the CI lane
 * runs `pnpm --filter desktop run build`, whose `build:main` is the same Vite
 * compile — passes this and rebuilds nothing.
 */
export const REUSE_BUILD_ARG = "--reuse-build";

/**
 * @param {readonly string[]} argv
 * @returns {{ beforeServer: string[], afterServer: string[] }} `pnpm run`
 *   script names, in order. `beforeServer` runs before the Vite dev server is
 *   created, `afterServer` after it.
 */
export function devLaunchBuildSteps(argv) {
  if (argv.includes(REUSE_BUILD_ARG)) {
    return { afterServer: [], beforeServer: [] };
  }
  const afterServer = ["prebuild", "db:generate", "build:main:dev"];
  if (argv.includes("--static-renderer")) {
    afterServer.push("build:renderer");
  }
  return { afterServer, beforeServer: ["build:deps"] };
}
