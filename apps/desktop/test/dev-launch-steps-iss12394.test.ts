/**
 * ISS-12394 — branch coverage for `scripts/dev-launch-steps.mjs`.
 *
 * The existing suite drives `devLaunchBuildSteps` in the Vitest worker, which
 * the node lane's c8 cannot see, and its launcher case only reaches the
 * `--reuse-build` branch in a child. This runs every branch in a plain Node
 * child.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REUSE_BUILD_ARG } from "../scripts/dev-launch-steps.mjs";
import {
  CHILD_CASE_TIMEOUT_MS,
  runModuleInChild,
} from "./support/module-child";

const MODULE_URL = new URL("../scripts/dev-launch-steps.mjs", import.meta.url)
  .href;
const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));

type Steps = { beforeServer: string[]; afterServer: string[] };

function stepsInChild(argvs: string[][]): Steps[] {
  return runModuleInChild<Steps[]>({
    body: `out(${JSON.stringify(argvs)}.map((argv) => m.devLaunchBuildSteps(argv)));`,
    cwd: DESKTOP_DIR,
    moduleUrl: MODULE_URL,
  });
}

describe("devLaunchBuildSteps", () => {
  it(
    "builds deps, then main, then the renderer only under --static-renderer",
    () => {
      const [plain, staticRenderer] = stepsInChild([[], ["--static-renderer"]]);
      expect(plain).toEqual({
        beforeServer: ["build:deps"],
        afterServer: ["prebuild", "db:generate", "build:main:dev"],
      });
      expect(staticRenderer).toEqual({
        beforeServer: ["build:deps"],
        afterServer: [
          "prebuild",
          "db:generate",
          "build:main:dev",
          "build:renderer",
        ],
      });
    },
    CHILD_CASE_TIMEOUT_MS
  );

  it(
    "runs no build step under --reuse-build, even with --static-renderer",
    () => {
      expect(stepsInChild([[REUSE_BUILD_ARG, "--static-renderer"]])).toEqual([
        { beforeServer: [], afterServer: [] },
      ]);
    },
    CHILD_CASE_TIMEOUT_MS
  );
});
