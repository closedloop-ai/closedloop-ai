/**
 * @file marketplace-scan.ts — the per-marketplace arms of the Claude plugin
 * pack projection, extracted from `scanClaudeMarketplaces` in pack-scanner.ts
 * (ISS-7686). `scanClaudeMarketplaces` still owns the registry read, the
 * reserved-pack skip, the source-url lookup and the count fold; everything
 * below is what it does PER marketplace once that dispatch has been made.
 *
 * The skill-emission loop was written out twice — once for a bundled
 * marketplace and once per plugin — and differed in exactly two values, so
 * `emitPluginSkills` is the single copy both arms call.
 *
 * The only edge back to pack-scanner.ts is the `PackScanSink` TYPE, which
 * `verbatimModuleSyntax` erases from the emitted JS, so the runtime import
 * graph stays one-directional. Keep it that way: a value import from
 * pack-scanner.ts here would make the two modules load each other.
 */

import path from "node:path";

import { resolveClaudeHome } from "./claude-home.js";
import {
  type ClaudePluginRegistryEntry,
  RESERVED_PLUGIN_PACK_IDS,
} from "./claude-plugin-registry.js";
import type { PackScanSink } from "./pack-scanner.js";
import {
  deterministicSkillId,
  findSkillFiles,
  parseSkillFrontmatter,
  safeReadFile,
  safeStat,
} from "./skill-files.js";

/**
 * One installed plugin belonging to a marketplace, as the pack projection
 * needs it: the registry entry minus the `marketplace` key the grouping
 * already consumed.
 */
export type MarketplacePlugin = {
  pluginName: string;
  installPath: string;
  version: string | null;
};

/**
 * Partial counts one marketplace arm contributes. The caller folds these into
 * its running totals and adds the `marketplaces` tick itself, because that one
 * is per-marketplace rather than per-arm.
 *
 * `plugins` carries a tally nothing reads — `ScanMarketplacesResult` declares
 * it optional and no consumer in `apps/desktop` looks at it. It is threaded
 * through so this extraction leaves the value byte-identical; deleting it is
 * its own change, not this one's (ISS-7686). Only the per-plugin arm ever
 * returns a nonzero, which is why the bundled arm reports 0 rather than 1.
 */
export type MarketplaceScanCounts = {
  installs: number;
  skills: number;
  plugins: number;
};

/**
 * Group flat registry entries by marketplace name.
 *
 * The pack projection collapses a marketplace bundle to ONE pack, so it only
 * groups entries that carry a marketplace (`<name>@<marketplace>`); a plugin
 * installed directly into the harness (null marketplace) is not a pack.
 */
export function groupInstalledPluginsByMarketplace(
  entries: readonly ClaudePluginRegistryEntry[]
): Map<string, MarketplacePlugin[]> {
  const byMarketplace = new Map<string, MarketplacePlugin[]>();
  for (const entry of entries) {
    if (entry.marketplace === null) {
      continue;
    }
    const bucket = byMarketplace.get(entry.marketplace) ?? [];
    bucket.push({
      pluginName: entry.pluginName,
      installPath: entry.installPath,
      version: entry.version,
    });
    byMarketplace.set(entry.marketplace, bucket);
  }
  return byMarketplace;
}

/**
 * Walk one plugin's `skills/` tree and emit a skill row per SKILL.md found,
 * returning how many were emitted.
 *
 * `skillIdRoot` and `packId` are the only things the two marketplace arms
 * disagree on: a bundled marketplace attributes every skill to the marketplace
 * pack keyed off the shared cache root, while a per-plugin marketplace
 * attributes each to its own plugin pack keyed off that plugin's install path.
 */
export async function emitPluginSkills(options: {
  skillsRoot: string;
  skillIdRoot: string;
  packId: string;
  sourceUrl: string | null;
  pluginVersion: string | null;
  sink: PackScanSink;
}): Promise<number> {
  const { skillsRoot, skillIdRoot, packId, sourceUrl, pluginVersion, sink } =
    options;
  let emitted = 0;
  for (const skillFile of findSkillFiles(skillsRoot)) {
    const content = safeReadFile(skillFile);
    if (content == null) {
      continue;
    }
    const meta = parseSkillFrontmatter(content) || {};
    const dirName = path.basename(path.dirname(skillFile));
    const name = meta.name || dirName;
    if (!name) {
      continue;
    }
    await sink.skill({
      skill_id: deterministicSkillId("claude", skillIdRoot, name),
      pack_id: packId,
      harness: "claude",
      install_path: skillFile,
      name,
      version: meta.version || pluginVersion || null,
      description: meta.description || null,
      source_url: sourceUrl,
    });
    emitted += 1;
  }
  return emitted;
}

/**
 * BUNDLED PATH: closedloop-ai and friends — the marketplace IS the pack and
 * its sub-plugins are skills, so one pack row is written against the shared
 * plugin cache root and every plugin's skills aggregate under it.
 */
export async function scanBundledMarketplace(options: {
  marketplace: string;
  plugins: readonly MarketplacePlugin[];
  sourceUrl: string | null;
  sink: PackScanSink;
}): Promise<MarketplaceScanCounts> {
  const { marketplace, plugins, sourceUrl, sink } = options;
  const cacheRoot = path.join(
    resolveClaudeHome(),
    "plugins",
    "cache",
    marketplace
  );
  await sink.pack({
    pack_id: marketplace,
    harness: "claude",
    install_path: cacheRoot,
    install_kind: "directory",
    source_url: sourceUrl,
    version: null,
  });
  let skills = 0;
  for (const plugin of plugins) {
    if (!safeStat(plugin.installPath)) {
      continue;
    }
    skills += await emitPluginSkills({
      skillsRoot: path.join(plugin.installPath, "skills"),
      skillIdRoot: cacheRoot,
      packId: marketplace,
      sourceUrl,
      pluginVersion: plugin.version,
      sink,
    });
  }
  return { installs: 1, skills, plugins: 0 };
}

/**
 * PER-PLUGIN PATH: claude-plugins-official, superpowers-marketplace, etc. —
 * each plugin becomes its own pack, keyed on the plugin name so the catalog's
 * "installed" join lines up.
 */
export async function scanPerPluginMarketplace(options: {
  plugins: readonly MarketplacePlugin[];
  sourceUrl: string | null;
  sink: PackScanSink;
}): Promise<MarketplaceScanCounts> {
  const { plugins, sourceUrl, sink } = options;
  const counts: MarketplaceScanCounts = { installs: 0, skills: 0, plugins: 0 };
  for (const plugin of plugins) {
    if (!safeStat(plugin.installPath)) {
      continue;
    }
    if (RESERVED_PLUGIN_PACK_IDS.has(plugin.pluginName)) {
      continue;
    }
    await sink.pack({
      pack_id: plugin.pluginName,
      harness: "claude",
      install_path: plugin.installPath,
      install_kind: "directory",
      source_url: sourceUrl,
      version: plugin.version,
    });
    counts.installs += 1;
    counts.plugins += 1;
    counts.skills += await emitPluginSkills({
      skillsRoot: path.join(plugin.installPath, "skills"),
      skillIdRoot: plugin.installPath,
      packId: plugin.pluginName,
      sourceUrl,
      pluginVersion: plugin.version,
      sink,
    });
  }
  return counts;
}
