/**
 * Node-only harness registry (`@repo/crewd/harness`).
 *
 * `defaultRegistry` wires the concrete drivers, each of which transitively
 * imports `node:child_process` / `node:fs` (via `./exec.js`), so this module —
 * and the concrete drivers, `runCascade`, and `createDispatch` at their own
 * subpaths — must NOT be value-exported from the renderer-safe root barrel
 * (`@repo/crewd`). Import them from these Node-only subpaths in main-process
 * code only. The root barrel keeps the pure model, scheduler core, and the
 * harness *types* (erased at build, so they carry no Node code into the
 * renderer graph). Concrete drivers/`runCascade`/`createDispatch` live at their
 * own module paths rather than being re-exported here, so this stays a single
 * value module (not a barrel).
 */
import type { HarnessName } from "../model.js";
import { claudeHarness } from "./claude.js";
import { codexHarness } from "./codex.js";
import { opencodeHarness } from "./opencode.js";
import type { Harness } from "./types.js";

export type HarnessRegistry = Record<HarnessName, Harness>;

export const defaultRegistry: HarnessRegistry = {
  claude: claudeHarness,
  codex: codexHarness,
  opencode: opencodeHarness,
};
