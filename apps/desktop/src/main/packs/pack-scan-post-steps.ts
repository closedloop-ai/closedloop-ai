/**
 * @file pack-scan-post-steps.ts — the post-scan settle steps that BOTH
 * db-host store ops (`packScanner.run` fallback and `packScanner.apply` worker
 * replay) run after the pack inventory is written.
 *
 * Extracted from db-host-worker.ts so the wiring is pinned by a behavioral test
 * (the store ops themselves need a booted Electron `SqliteAgentDatabase`, but
 * this helper takes the plain `DesktopPrisma` and runs against a test store).
 * Every step is best-effort — a failure is logged and never fails the scan.
 */

import type { DesktopPrisma } from "../database/prisma-client.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  discoverInstalledPlugins,
  projectPacksToComponents,
} from "./component-scanner.js";
import { collectDefinitionContentFromDefaults } from "./definition-content-collector.js";
import { discoverMcpServersFromDefaults } from "./mcp-discovery.js";

/**
 * Run the post-scan settle steps once the pack inventory is written:
 *   1. FEA-2923 — attach each definition file's text + sha256 to its
 *      `agent_components` row so the detail Prompt panel has real content.
 *   2. FEA-4094 — discover harness-native installed plugins straight from the
 *      on-disk registry so every installed plugin surfaces as its own
 *      `component_kind='plugin'` row (presence-based, independent of usage and
 *      of the bundled-marketplace pack collapse).
 *   3. FEA-4095 — discover installed-but-unused MCP servers from their on-disk
 *      config so a configured server surfaces as a zero-invocation
 *      `component_kind='mcp'` row instead of not existing until its first call.
 *   4. FEA-2923 T-13.3/T-13.4 (wired by ISS-6094) — project `agent_packs` to
 *      `component_kind='plugin'` rows and stamp `agent_components.pack_id` on
 *      every child beneath a pack's install path, which is what the plugin
 *      usage rollup joins on. Runs LAST so it sees the rows steps 1–3 just
 *      wrote; before ISS-6094 nothing in the shipped desktop invoked it at all,
 *      so `pack_id` stayed NULL forever and every plugin rollup read zero.
 *
 * Each step is isolated: a failure in one is logged and does not skip the
 * others or fail the scan.
 *
 * `skipDefinitionContent` (ISS-5274) drops step 1 only. `packScanner.apply` —
 * the worker path — passes it because the coordinator drives the definition
 * walk in the compute worker straight after, so running it here too would put
 * the recursive `readdirSync` sweep back on the db-host, which is the entire
 * cost this ticket removes. `packScanner.run` (the fallback and golden mode)
 * leaves it unset and still walks in-host. Steps 2 and 3 run either way: they
 * are bounded config reads, not recursive walks.
 */
export async function runPackScanPostSteps(
  prisma: DesktopPrisma,
  opts: { skipDefinitionContent?: boolean } = {}
): Promise<void> {
  if (!opts.skipDefinitionContent) {
    try {
      await collectDefinitionContentFromDefaults(prisma);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      gatewayLog.warn(
        "pack-scan-post-steps",
        `definition content collection failed: ${msg}`
      );
    }
  }
  try {
    await discoverInstalledPlugins(prisma);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "pack-scan-post-steps",
      `installed-plugin discovery failed: ${msg}`
    );
  }
  try {
    await discoverMcpServersFromDefaults(prisma);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "pack-scan-post-steps",
      `mcp server discovery failed: ${msg}`
    );
  }
  await projectPluginInventory(prisma);
}

/**
 * ISS-6094 step 4, factored out because it has a SECOND production caller.
 *
 * On the worker path the coordinator runs `packScanner.apply` (inventory) →
 * `runPackScanPostSteps` → `packScanner.applyDefinitions`, so the definition
 * rows land AFTER the post-steps. Re-running the projection once definitions
 * have been applied is what stops a skill/subagent discovered by the definition
 * walk from carrying a NULL `pack_id` until the next whole scan. It is
 * idempotent (the backfill only writes rows whose `pack_id` differs), so the
 * second run is a no-op when nothing new landed.
 *
 * Best-effort, like every other settle step: a failure is logged, never thrown.
 */
export async function projectPluginInventory(
  prisma: DesktopPrisma
): Promise<void> {
  try {
    await projectPacksToComponents(prisma);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "pack-scan-post-steps",
      `plugin projection / pack_id backfill failed: ${msg}`
    );
  }
}
