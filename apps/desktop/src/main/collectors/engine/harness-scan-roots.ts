/**
 * @file harness-scan-roots.ts
 * @description FEA-3639 — the harness→transcript-root registry the file-access
 * probe checks for permission blocks. Keyed on the `Harness` enum via a
 * `Record<Harness, …>`, so the map is **exhaustive**: adding a harness to the
 * enum fails typecheck here until its root is wired in, rather than letting a new
 * collector silently escape the probe (the gap the original 3-harness list had).
 *
 * The probe reads the home resolvers directly rather than off the collector
 * descriptors, because those don't expose a uniform root accessor (only Codex
 * implements `sourceRoots()`). This mirrors the full five-collector set
 * `collector-manager.defaultCollectors()` boots (Claude/Codex/Cursor/Copilot/
 * OpenCode). Node-only (all five home resolvers are electron-free), so it stays
 * testable under the `test:node` slice.
 */
import { Harness, HarnessValues } from "@repo/lib/harness/types";
import { getProjectsDir } from "../claude/claude-home.js";
import {
  getCodexArchivedDir,
  getCodexSessionsDir,
} from "../codex/codex-home.js";
import {
  getCopilotCliSessionStateDir,
  getVscodeWorkspaceStorageDir,
} from "../copilot/copilot-home.js";
import { getCursorProjectsDir } from "../cursor/cursor-home.js";
import { getOpenCodeHome } from "../opencode/opencode-home.js";
import type { HarnessScanRoot } from "./file-access-probe.js";

// The local root(s) each harness's transcripts live under. Exhaustive over the
// Harness enum — a new harness must add its root(s) here to compile.
const HARNESS_ROOT_RESOLVERS: Record<Harness, () => string[]> = {
  [Harness.Claude]: () => [getProjectsDir()],
  [Harness.Codex]: () => [getCodexSessionsDir(), getCodexArchivedDir()],
  [Harness.Cursor]: () => [getCursorProjectsDir()],
  // Copilot reads two independent roots — CLI event state and VS Code workspace
  // storage — so a block on either surfaces.
  [Harness.Copilot]: () => [
    getCopilotCliSessionStateDir(),
    getVscodeWorkspaceStorageDir(),
  ],
  // OpenCode's store is a single `opencode.db` under its home dir; probe the dir
  // (the granularity a TCC/permission denial applies at), matching the others.
  [Harness.OpenCode]: () => [getOpenCodeHome()],
};

/**
 * Every harness paired with the local root(s) its transcripts live under.
 *
 * `isEnabled` (FEA-3639 review): skip harnesses the user disabled via the
 * per-tool collector toggle, so the probe never opens a root `CollectorManager`
 * deliberately leaves untouched (FEA-3741) — no incidental TCC touch, and no
 * file-access prompt for a harness that isn't being collected. Omitted ⇒ every
 * harness is probed (the always-on default). Iterating `HarnessValues` keeps the
 * harness key typed as `Harness` so the enabled lookup needs no cast.
 */
export function harnessScanRoots(
  isEnabled: (harness: Harness) => boolean = () => true
): HarnessScanRoot[] {
  return HarnessValues.filter((harness) => isEnabled(harness)).map(
    (harness) => ({ harness, roots: HARNESS_ROOT_RESOLVERS[harness]() })
  );
}
