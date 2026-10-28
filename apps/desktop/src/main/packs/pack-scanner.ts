/**
 * @file pack-scanner.ts — filesystem-driven discovery of agent skill packs
 * (GStack + BMad Method + catalog detection adapters) for the first-party
 * Electron Agent Dashboard.
 *
 * Ported from the legacy sidecar CJS modules (pack-scanner.js +
 * catalog-detector.js) into a single TypeScript ESM module. The pack-store
 * upsert functions are async (SQLite), so every scanner function is async too.
 * The `fs` calls stay synchronous — they are filesystem probing, not
 * performance-critical.
 *
 * Runs after the SQLite schema has been applied (schema lives in sqlite.ts).
 * Walks well-known skills roots (`~/.claude/skills`, `~/.codex/skills`) and
 * active project roots (distinct `sessions.cwd` from recent rows) and upserts
 * into `agent_packs`, `skills`, and `project_pack_associations`. Idempotent —
 * re-running bumps `last_seen_at` but never produces duplicate rows.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileNonBlocking } from "../../server/non-blocking-exec.js";
import {
  type BinaryName,
  isResolvedOnHost,
  resolveBinaryFromLoginShellSync,
} from "../../server/shell-path.js";
import { isTccProtectedPath } from "../../shared/sandbox-policy.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import {
  detectBmadProjectInstall,
  readBmadProjectManifest,
} from "./bmad-project-install.js";
import { resolveClaudeHome, resolveCodexHome } from "./claude-home.js";
import {
  RESERVED_PLUGIN_PACK_IDS,
  readClaudeInstalledPluginRegistry,
} from "./claude-plugin-registry.js";
import {
  groupInstalledPluginsByMarketplace,
  scanBundledMarketplace,
  scanPerPluginMarketplace,
} from "./marketplace-scan.js";
import { pruneStaleRows } from "./pack-prune.js";
import {
  upsertPack,
  upsertProjectAssociation,
  upsertSkill,
} from "./pack-store.js";
import {
  deterministicSkillId,
  findSkillFiles,
  isSymlink,
  parseSkillFrontmatter,
  safeReadDir,
  safeReadFile,
  safeRealpath,
  safeStat,
} from "./skill-files.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The scanner runs entirely on the single DesktopPrisma client via typed
 * delegates: its one read (recent project roots) uses
 * `prisma.client.session.findMany` (distinct cwd); the upserts (via pack-store)
 * and the tombstone/prune writes use `prisma.write` with the
 * `agentPack`/`skill`/`projectPackAssociation` `updateMany`/`deleteMany`
 * delegates. The scanner issues only single-statement writes — no
 * multi-statement transaction — so per-write queue serialization is sufficient.
 */
export type PackScannerDb = DesktopPrisma;

type ScanGStackResult = {
  installs: number;
  skills: number;
};

type ScanBmadResult = {
  installs: number;
  skills: number;
  projects: number;
};

type ScanMarketplacesResult = {
  installs: number;
  skills: number;
  marketplaces: number;
  plugins?: number;
};

export type PackScannerSummary = {
  gstack: ScanGStackResult;
  bmad: ScanBmadResult;
  marketplaces: ScanMarketplacesResult;
  catalogDetectors: Record<string, boolean>;
  gstackProjects: number;
  prunedBefore: string;
  scopes: Record<string, boolean>;
  pruned: boolean;
  pruneSkipped: boolean;
};

// ---------------------------------------------------------------------------
// Compute/write split (FEA-3628)
//
// The heavy scan work (filesystem walk, git/npm probes, frontmatter/marketplace
// parsing) is pure compute and must NOT run inside the db-host utilityProcess,
// where it starves renderer DB reads. Instead the scan phases write their
// results into a `PackScanSink` — an in-memory collector, NOT a DB connection —
// which produces a serializable `PackScanPlan`. The db-host then replays the
// plan through the real pack-store upserts as the SOLE SQLite writer. This
// keeps a single writer (no cross-process WAL contention / OOM — FEA-3132) and
// moves the CPU-heavy scan off the DB process.
//
// The row shapes below are exactly the `pack-store` upsert argument shapes, so
// a plan entry replays 1:1 into `upsertPack`/`upsertSkill`/
// `upsertProjectAssociation`. Every field is a JSON-serializable primitive so
// the plan crosses the utilityProcess IPC boundary unchanged.
// ---------------------------------------------------------------------------

export type PackUpsertRow = {
  pack_id: string;
  harness: string;
  install_path: string;
  install_kind: string;
  source_url?: string | null;
  version?: string | null;
};

export type SkillUpsertRow = {
  skill_id: string;
  pack_id?: string | null;
  harness: string;
  install_path: string;
  name: string;
  version?: string | null;
  description?: string | null;
  source_url?: string | null;
};

export type AssociationUpsertRow = {
  project_path: string;
  pack_id: string;
};

/**
 * The write surface the scan phases target. In the compute worker this is a
 * `CollectingSink` (pushes rows into arrays); nothing here touches a database.
 * `recentProjectRoots()` returns the roots resolved by the db-host BEFORE the
 * worker starts (the scanner's single DB read), passed in so the worker owns no
 * DB connection.
 */
export type PackScanSink = {
  pack(row: PackUpsertRow): Promise<void>;
  skill(row: SkillUpsertRow): Promise<void>;
  association(row: AssociationUpsertRow): Promise<void>;
  recentProjectRoots(): string[];
};

/** Serializable output of a pure-compute scan, replayed by the db-host. */
export type PackScanPlan = {
  packs: PackUpsertRow[];
  skills: SkillUpsertRow[];
  associations: AssociationUpsertRow[];
};

/** The full result of a pure-compute scan: the write plan plus per-phase counts. */
export type PackScanComputeResult = {
  plan: PackScanPlan;
  counts: {
    gstack: ScanGStackResult;
    bmad: ScanBmadResult;
    marketplaces: ScanMarketplacesResult;
    catalogDetectors: Record<string, boolean>;
    gstackProjects: number;
  };
  scopes: Record<string, boolean>;
};

type ComputePackScanOverrides = {
  scanGStack?: (sink: PackScanSink) => Promise<ScanGStackResult>;
  scanBmad?: (sink: PackScanSink) => Promise<ScanBmadResult>;
  scanClaudeMarketplaces?: (
    sink: PackScanSink
  ) => Promise<ScanMarketplacesResult>;
  scanProjectGStackAssociations?: (sink: PackScanSink) => Promise<number>;
  runCatalogDetectorAdapters?: (
    sink: PackScanSink
  ) => Promise<Record<string, boolean>>;
  cooperativeDelay?: (ms: number) => Promise<void>;
};

/**
 * In-memory `PackScanSink` that accumulates a `PackScanPlan`. Deduplicates on
 * the same keys the pack-store upserts use so a plan never carries two writes
 * that would collide on replay (last-write-wins, mirroring re-scan idempotency).
 */
export class CollectingSink implements PackScanSink {
  private readonly packsByKey = new Map<string, PackUpsertRow>();
  private readonly skillsByKey = new Map<string, SkillUpsertRow>();
  private readonly associationsByKey = new Map<string, AssociationUpsertRow>();
  private readonly roots: string[];

  constructor(roots: string[]) {
    this.roots = roots;
  }

  pack(row: PackUpsertRow): Promise<void> {
    this.packsByKey.set(
      `${row.pack_id}\n${row.harness}\n${row.install_path}`,
      row
    );
    return Promise.resolve();
  }

  skill(row: SkillUpsertRow): Promise<void> {
    this.skillsByKey.set(row.skill_id, row);
    return Promise.resolve();
  }

  association(row: AssociationUpsertRow): Promise<void> {
    this.associationsByKey.set(`${row.project_path}\n${row.pack_id}`, row);
    return Promise.resolve();
  }

  recentProjectRoots(): string[] {
    return this.roots;
  }

  toPlan(): PackScanPlan {
    return {
      packs: [...this.packsByKey.values()],
      skills: [...this.skillsByKey.values()],
      associations: [...this.associationsByKey.values()],
    };
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_LOOKBACK_DAYS = 90;
const GIT_REMOTE_TIMEOUT_MS = 1500;
const PACK_SCANNER_PHASE_PAUSE_MS = 25;

// Known marketplace URLs; unknown marketplaces still register without one.
const KNOWN_MARKETPLACE_SOURCES: Record<string, string> = Object.assign(
  Object.create(null),
  {
    "closedloop-ai": "https://github.com/closedloop-ai/claude-plugins",
    "claude-plugins-official":
      "https://github.com/anthropics/claude-plugins-official",
  }
);

// Marketplaces whose plugins ship as ONE logical pack instead of separately.
// For closedloop-ai, code/code-review/judges/platform/self-learning
// are 5 plugins but install as a unit and the user thinks of them as "the
// closedloop pack." For these, the agent_packs row is keyed on the
// marketplace name and skills aggregate across plugins.
//
// For all OTHER marketplaces (anthropics/claude-plugins-official, etc.) each
// plugin becomes its OWN pack — pack_id = plugin name. That matches the
// catalog's pack_id values (e.g. superpowers, compound-engineering) so the
// "installed" join in listCatalog works correctly.
const MARKETPLACE_BUNDLE_AS_PACK = new Set(["closedloop-ai"]);

// ---------------------------------------------------------------------------
// Git remote helper
// ---------------------------------------------------------------------------

async function deriveGitRemoteUrl(dir: string): Promise<string | null> {
  // ISS-11914: `git` reads `.git/config`, which raises a macOS permission prompt
  // inside a TCC-protected folder.
  if (isTccProtectedPath(dir)) {
    return null;
  }
  try {
    const out = await execFileNonBlocking(
      "git",
      ["-C", dir, "remote", "get-url", "origin"],
      {
        timeout: GIT_REMOTE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    return out.toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recent project roots (shared by BMad + project-association scanners)
// ---------------------------------------------------------------------------

/**
 * Distinct recent-session cwds, used by every per-project scanner that needs
 * to look at which projects the user worked in recently. Lookback window is
 * PROJECT_LOOKBACK_DAYS.
 *
 * Returns string[] of absolute paths (already de-duped by SELECT DISTINCT).
 * Returns [] (not throws) on any failure.
 */
export async function getRecentProjectRoots(
  db: PackScannerDb
): Promise<string[]> {
  try {
    const since = new Date(
      Date.now() - PROJECT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const rows = await db.client.session.findMany({
      where: {
        AND: [
          { cwd: { not: null } },
          { cwd: { not: "" } },
          {
            OR: [{ updatedAt: { gte: since } }, { startedAt: { gte: since } }],
          },
        ],
      },
      select: { cwd: true },
      distinct: ["cwd"],
    });
    return rows.map((r) => r.cwd).filter((cwd): cwd is string => Boolean(cwd));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// GStack version reader
// ---------------------------------------------------------------------------

/**
 * Read the gstack pack version from the install's top-level VERSION file
 * (plain-text, e.g. "1.40.0.0"). Returns null if absent or unreadable.
 */
function readGStackVersion(installPath: string): string | null {
  const versionFile = path.join(installPath, "VERSION");
  const content = safeReadFile(versionFile);
  if (!content) {
    return null;
  }
  const v = content.trim().split(/\s+/)[0];
  return v && /^[0-9][0-9A-Za-z.\-+]*$/.test(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Pack directory ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest one resolved pack directory: write the agent_packs row and every
 * SKILL.md it contains. Used by both gstack and bmad detection paths.
 */
async function ingestPackDir(
  sink: PackScanSink,
  opts: {
    packId: string;
    harness: string;
    installPath: string;
    sourceUrl?: string | null;
    version?: string | null;
  }
): Promise<number> {
  const real = safeRealpath(opts.installPath);
  const installKind = isSymlink(opts.installPath) ? "symlink" : "directory";
  const remoteUrl = opts.sourceUrl || (await deriveGitRemoteUrl(real));

  await sink.pack({
    pack_id: opts.packId,
    harness: opts.harness,
    install_path: opts.installPath,
    install_kind: installKind,
    source_url: remoteUrl,
    version: opts.version || null,
  });

  let skillCount = 0;
  for (const skillFile of findSkillFiles(real)) {
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
      skill_id: deterministicSkillId(opts.harness, opts.installPath, name),
      pack_id: opts.packId,
      harness: opts.harness,
      install_path: skillFile,
      name,
      version: meta.version || null,
      description: meta.description || null,
      source_url: remoteUrl,
    });
    skillCount++;
  }
  return skillCount;
}

// ---------------------------------------------------------------------------
// scanGStack
// ---------------------------------------------------------------------------

/**
 * Detect GStack: look for `gstack` or `gstack-*` entries under each known
 * skills root.
 *
 * Claude install is a single directory at ~/.claude/skills/gstack — one
 * agent_packs row.
 *
 * Codex install is special: the gstack ./setup --host codex creates ONE
 * symlink per skill under ~/.codex/skills/ (gstack-autoplan, gstack-ship,
 * etc., ~46 entries), each pointing into the same upstream gstack repo's
 * .agents/skills tree. They all share one logical install — so we collapse
 * them into a single agent_packs row keyed on the codex skills root (rather
 * than registering 46 install rows), and still ingest every linked SKILL.md
 * into the skills table.
 */
export async function scanGStack(
  sink: PackScanSink
): Promise<ScanGStackResult> {
  const results: ScanGStackResult = { installs: 0, skills: 0 };

  // --- Claude ---
  const claudeSkillsRoot = path.join(resolveClaudeHome(), "skills");
  for (const entry of safeReadDir(claudeSkillsRoot)) {
    if (entry.name !== "gstack") {
      continue;
    }
    const installPath = path.join(claudeSkillsRoot, entry.name);
    const real = safeRealpath(installPath);
    if (!findSkillFiles(real).length) {
      continue;
    }
    const version = readGStackVersion(real);
    const added = await ingestPackDir(sink, {
      packId: "gstack",
      harness: "claude",
      installPath,
      version,
    });
    results.installs += 1;
    results.skills += added;
  }

  // --- Codex ---
  const codexSkillsRoot = path.join(resolveCodexHome(), "skills");
  const codexEntries = safeReadDir(codexSkillsRoot).filter(
    (e) =>
      (e.isDirectory() || e.isSymbolicLink()) &&
      (e.name === "gstack" || e.name.startsWith("gstack-"))
  );
  if (codexEntries.length > 0) {
    let sourceUrl: string | null = null;
    let version: string | null = null;
    for (const e of codexEntries) {
      const real = safeRealpath(path.join(codexSkillsRoot, e.name));
      let probe = real;
      for (let i = 0; i < 5 && !version; i++) {
        version = readGStackVersion(probe);
        if (!sourceUrl) {
          sourceUrl = await deriveGitRemoteUrl(probe);
        }
        const next = path.dirname(probe);
        if (next === probe) {
          break;
        }
        probe = next;
      }
      if (version || sourceUrl) {
        break;
      }
    }
    await sink.pack({
      pack_id: "gstack",
      harness: "codex",
      install_path: codexSkillsRoot,
      install_kind: "symlink",
      source_url: sourceUrl,
      version,
    });
    results.installs += 1;
    for (const e of codexEntries) {
      const entryPath = path.join(codexSkillsRoot, e.name);
      const real = safeRealpath(entryPath);
      for (const skillFile of findSkillFiles(real)) {
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
          skill_id: deterministicSkillId("codex", codexSkillsRoot, name),
          pack_id: "gstack",
          harness: "codex",
          install_path: skillFile,
          name,
          version: meta.version || null,
          description: meta.description || null,
          source_url: sourceUrl,
        });
        results.skills += 1;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// BMad helpers
// ---------------------------------------------------------------------------

/**
 * Parse `marketplace.json` and confirm it's a BMad plugin (pre-v6 layout).
 * Returns `{ version }` on match, null otherwise.
 */
function readBmadMarketplace(dir: string): { version: string | null } | null {
  const file = path.join(dir, ".claude-plugin", "marketplace.json");
  const content = safeReadFile(file);
  if (!content) {
    return null;
  }
  try {
    const parsed = JSON.parse(content);
    if (parsed && parsed.name === "bmad-method") {
      return { version: parsed.version || null };
    }
  } catch {
    /* malformed JSON — non-fatal */
  }
  return null;
}

/**
 * Ingest BMad v6+ skills from a project install path. Only pulls in
 * directories whose name is prefixed "bmad-".
 */
async function ingestBmadProjectSkills(
  sink: PackScanSink,
  opts: { installPath: string; harness: string; version: string | null }
): Promise<number> {
  await sink.pack({
    pack_id: "bmad-method",
    harness: opts.harness,
    install_path: opts.installPath,
    install_kind: "directory",
    source_url: "https://github.com/bmad-code-org/BMAD-METHOD",
    version: opts.version || null,
  });
  let skillCount = 0;
  for (const entry of safeReadDir(opts.installPath)) {
    if (!(entry.isDirectory() || entry.isSymbolicLink())) {
      continue;
    }
    if (!entry.name.startsWith("bmad-")) {
      continue;
    }
    const skillFile = path.join(opts.installPath, entry.name, "SKILL.md");
    const content = safeReadFile(skillFile);
    if (content == null) {
      continue;
    }
    const meta = parseSkillFrontmatter(content) || {};
    const name = meta.name || entry.name;
    await sink.skill({
      skill_id: deterministicSkillId(opts.harness, opts.installPath, name),
      pack_id: "bmad-method",
      harness: opts.harness,
      install_path: skillFile,
      name,
      version: meta.version || opts.version || null,
      description: meta.description || null,
      source_url: "https://github.com/bmad-code-org/BMAD-METHOD",
    });
    skillCount++;
  }
  return skillCount;
}

// ---------------------------------------------------------------------------
// scanBmad
// ---------------------------------------------------------------------------

/**
 * Detect BMad across all known layouts:
 *   1. v6+ per-project install via .agents/skills/bmad-* (current)
 *   2. Legacy global install via ~/.claude/skills/<plugin>/.claude-plugin/
 *      marketplace.json
 *   3. Legacy per-project install via _bmad/ directory (very old)
 */
export async function scanBmad(sink: PackScanSink): Promise<ScanBmadResult> {
  const results: ScanBmadResult = { installs: 0, skills: 0, projects: 0 };

  // 1. Legacy global installs under ~/.claude/skills/<dir>/.claude-plugin/
  const claudeSkillsRoot = path.join(resolveClaudeHome(), "skills");
  for (const entry of safeReadDir(claudeSkillsRoot)) {
    if (!(entry.isDirectory() || entry.isSymbolicLink())) {
      continue;
    }
    const installPath = path.join(claudeSkillsRoot, entry.name);
    const marketplace = readBmadMarketplace(safeRealpath(installPath));
    if (!marketplace) {
      continue;
    }
    const added = await ingestPackDir(sink, {
      packId: "bmad-method",
      harness: "claude",
      installPath,
      version: marketplace.version,
    });
    results.installs += 1;
    results.skills += added;
  }

  // 2 & 3. Per-project: walk distinct sessions.cwd from the last 90 days.
  for (const projectRoot of sink.recentProjectRoots()) {
    // ISS-11914: detecting BMad reads inside the project, which raises a macOS
    // permission prompt in a TCC-protected folder.
    if (isTccProtectedPath(projectRoot)) {
      continue;
    }
    let added = 0;
    let installedHere = false;

    // 2. BMad v6+: project-local `.agents/skills/bmad-*` install. Stamp the
    // pack against both `claude` and `codex` harnesses because the manifest
    // explicitly lists both as supported IDEs.
    const v6 = detectBmadProjectInstall(projectRoot);
    if (v6) {
      for (const harness of ["claude", "codex"]) {
        added += await ingestBmadProjectSkills(sink, {
          installPath: v6.installPath,
          harness,
          version: v6.version,
        });
        results.installs += 1;
      }
      installedHere = true;
    }

    // 3. Legacy per-project `_bmad/` install with marketplace.json upstream.
    const legacyBmadDir = path.join(projectRoot, "_bmad");
    if (safeStat(legacyBmadDir) && !v6) {
      let marketplace: { version: string | null } | null = null;
      let probe = projectRoot;
      for (let i = 0; i < 4 && !marketplace; i++) {
        marketplace = readBmadMarketplace(probe);
        probe = path.dirname(probe);
        if (probe === path.dirname(probe)) {
          break; // hit fs root
        }
      }
      added += await ingestPackDir(sink, {
        packId: "bmad-method",
        harness: "claude",
        installPath: legacyBmadDir,
        version: marketplace ? marketplace.version : null,
      });
      results.installs += 1;
      installedHere = true;
    }

    if (installedHere) {
      await sink.association({
        project_path: projectRoot,
        pack_id: "bmad-method",
      });
      results.skills += added;
      results.projects += 1;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// scanClaudeMarketplaces
// ---------------------------------------------------------------------------

/**
 * Detect plugins installed via Claude Code's marketplace system. The
 * canonical install registry lives at ~/.claude/plugins/installed_plugins.json.
 *
 * Each marketplace becomes ONE pack (pack_id = marketplace name). Each
 * plugin from that marketplace becomes one install row under the pack with
 * its own per-plugin version. Skills aggregate across all plugins.
 */
export async function scanClaudeMarketplaces(
  sink: PackScanSink
): Promise<ScanMarketplacesResult> {
  // Shared low-level read/parse of ~/.claude/plugins/installed_plugins.json.
  const read = readClaudeInstalledPluginRegistry();
  if (read.status !== "ok") {
    return { installs: 0, skills: 0, marketplaces: 0 };
  }

  const byMarketplace = groupInstalledPluginsByMarketplace(read.entries);

  const results: ScanMarketplacesResult & { plugins: number } = {
    installs: 0,
    skills: 0,
    marketplaces: 0,
    plugins: 0,
  };

  for (const [marketplace, plugins] of byMarketplace.entries()) {
    // Pack IDs that already have dedicated scanners — skip them here so
    // marketplace installs of gstack or bmad-method don't get double-counted.
    if (RESERVED_PLUGIN_PACK_IDS.has(marketplace)) {
      continue;
    }
    const sourceUrl = KNOWN_MARKETPLACE_SOURCES[marketplace] || null;

    const arm = MARKETPLACE_BUNDLE_AS_PACK.has(marketplace)
      ? await scanBundledMarketplace({ marketplace, plugins, sourceUrl, sink })
      : await scanPerPluginMarketplace({ plugins, sourceUrl, sink });

    results.installs += arm.installs;
    results.skills += arm.skills;
    results.plugins += arm.plugins;
    results.marketplaces += 1;
  }
  return results;
}

// ---------------------------------------------------------------------------
// scanProjectGStackAssociations
// ---------------------------------------------------------------------------

/**
 * Scan recent project roots for `.gstack/conductor.json` markers and record
 * per-project associations.
 */
export async function scanProjectGStackAssociations(
  sink: PackScanSink
): Promise<number> {
  let count = 0;
  for (const projectRoot of sink.recentProjectRoots()) {
    const marker = path.join(projectRoot, ".gstack", "conductor.json");
    if (!safeStat(marker)) {
      continue;
    }
    await sink.association({
      project_path: projectRoot,
      pack_id: "gstack",
    });
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Catalog detection adapters (ported from catalog-detector.js)
// ---------------------------------------------------------------------------

async function detectVoltagentSubagents(sink: PackScanSink): Promise<boolean> {
  const root = path.join(resolveClaudeHome(), "skills", "voltagent-subagents");
  if (!safeStat(root)) {
    return false;
  }
  await sink.pack({
    pack_id: "voltagent-subagents",
    harness: "claude",
    install_path: root,
    install_kind: "directory",
    source_url: "https://github.com/VoltAgent/awesome-claude-code-subagents",
    version: null,
  });
  // VoltAgent uses .md (NOT SKILL.md). Walk categories/ for agent files.
  const categoriesDir = path.join(root, "categories");
  if (safeStat(categoriesDir)) {
    for (const cat of safeReadDir(categoriesDir)) {
      if (!cat.isDirectory()) {
        continue;
      }
      const catDir = path.join(categoriesDir, cat.name);
      for (const agent of safeReadDir(catDir)) {
        if (!(agent.isFile() && agent.name.endsWith(".md"))) {
          continue;
        }
        if (agent.name.toUpperCase().startsWith("README")) {
          continue;
        }
        const name = path.basename(agent.name, ".md");
        await sink.skill({
          skill_id: deterministicSkillId("claude", root, name),
          pack_id: "voltagent-subagents",
          harness: "claude",
          install_path: path.join(catDir, agent.name),
          name,
          version: null,
          description: null,
          source_url:
            "https://github.com/VoltAgent/awesome-claude-code-subagents",
        });
      }
    }
  }
  return true;
}

async function detectAlirezaSkills(sink: PackScanSink): Promise<boolean> {
  const root = path.join(
    resolveClaudeHome(),
    "skills",
    "alirezarezvani-claude-skills"
  );
  if (!safeStat(root)) {
    return false;
  }
  await sink.pack({
    pack_id: "alirezarezvani-claude-skills",
    harness: "claude",
    install_path: root,
    install_kind: "directory",
    source_url: "https://github.com/alirezarezvani/claude-skills",
    version: null,
  });
  for (const skillFile of findSkillFiles(root)) {
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
      skill_id: deterministicSkillId("claude", root, name),
      pack_id: "alirezarezvani-claude-skills",
      harness: "claude",
      install_path: skillFile,
      name,
      version: meta.version || null,
      description: meta.description || null,
      source_url: "https://github.com/alirezarezvani/claude-skills",
    });
  }
  return true;
}

async function detectSuperClaude(sink: PackScanSink): Promise<boolean> {
  // SuperClaude installs commands (NOT skills) into ~/.claude/commands/sc/.
  const root = path.join(resolveClaudeHome(), "commands", "sc");
  if (!safeStat(root)) {
    return false;
  }
  await sink.pack({
    pack_id: "superclaude",
    harness: "claude",
    install_path: root,
    install_kind: "directory",
    source_url: "https://github.com/SuperClaude-Org/SuperClaude_Framework",
    version: null,
  });
  for (const entry of safeReadDir(root)) {
    if (!(entry.isFile() && entry.name.endsWith(".md"))) {
      continue;
    }
    if (entry.name.toUpperCase().startsWith("README")) {
      continue;
    }
    const baseName = path.basename(entry.name, ".md");
    const name = `sc:${baseName}`;
    await sink.skill({
      skill_id: deterministicSkillId("claude", root, name),
      pack_id: "superclaude",
      harness: "claude",
      install_path: path.join(root, entry.name),
      name,
      version: null,
      description: null,
      source_url: "https://github.com/SuperClaude-Org/SuperClaude_Framework",
    });
  }
  return true;
}

async function detectClaudePluginsOfficial(
  sink: PackScanSink
): Promise<boolean> {
  const root = path.join(
    resolveClaudeHome(),
    "plugins",
    "marketplaces",
    "claude-plugins-official"
  );
  if (!safeStat(root)) {
    return false;
  }
  await sink.pack({
    pack_id: "claude-plugins-official",
    harness: "claude",
    install_path: root,
    install_kind: "directory",
    source_url: "https://github.com/anthropics/claude-plugins-official",
    version: null,
  });
  return true;
}

/**
 * Detect a binary-installed, harness-agnostic CLI tool. Since the binary works
 * regardless of which agent harness invokes it, one detection registers an
 * agent_packs row for EACH harness in `harnesses`.
 */
async function detectBinaryTool(
  sink: PackScanSink,
  opts: {
    pack_id: string;
    binNames: BinaryName[];
    source_url: string | null;
    harnesses: string[];
    versionArgs?: string[];
  }
): Promise<boolean> {
  let binaryPath: string | null = null;
  for (const bin of opts.binNames) {
    const resolved = resolveBinaryFromLoginShellSync(bin);
    if (isResolvedOnHost(resolved.source)) {
      binaryPath = resolved.path;
      break;
    }
  }
  if (!binaryPath) {
    return false;
  }

  let version: string | null = null;
  if (Array.isArray(opts.versionArgs) && opts.versionArgs.length > 0) {
    try {
      const out = await execFileNonBlocking(binaryPath, opts.versionArgs, {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
      const m = out.toString().match(/(\d+(?:\.\d+)+)/);
      if (m) {
        version = m[1];
      }
    } catch {
      /* version probe is best-effort */
    }
  }
  for (const harness of opts.harnesses) {
    await sink.pack({
      pack_id: opts.pack_id,
      harness,
      install_path: binaryPath,
      install_kind: "directory", // CHECK constraint allows symlink|directory
      source_url: opts.source_url || null,
      version,
    });
  }
  return true;
}

async function detectRtk(sink: PackScanSink): Promise<boolean> {
  return detectBinaryTool(sink, {
    pack_id: "rtk",
    binNames: ["rtk"],
    source_url: "https://github.com/rtk-ai/rtk",
    harnesses: ["claude", "codex"],
    versionArgs: ["--version"],
  });
}

async function detectClaudeCodeRouter(sink: PackScanSink): Promise<boolean> {
  // Global npm install — probe via `npm ls -g` (fast, no network).
  let installed = false;
  try {
    await execFileNonBlocking(
      "npm",
      ["ls", "-g", "--depth=0", "@musistudio/claude-code-router"],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }
    );
    installed = true;
  } catch {
    // Fall back to probing the binary on PATH.
    installed = isResolvedOnHost(resolveBinaryFromLoginShellSync("ccr").source);
  }
  if (!installed) {
    return false;
  }
  await sink.pack({
    pack_id: "claude-code-router",
    harness: "claude",
    install_path: "@musistudio/claude-code-router (npm -g)",
    install_kind: "directory",
    source_url: "https://github.com/musistudio/claude-code-router",
    version: null,
  });
  return true;
}

// ---------------------------------------------------------------------------
// runCatalogDetectorAdapters
// ---------------------------------------------------------------------------

type CatalogAdapter = [string, (sink: PackScanSink) => Promise<boolean>];

const CATALOG_ADAPTERS: CatalogAdapter[] = [
  ["voltagent-subagents", detectVoltagentSubagents],
  ["alirezarezvani-claude-skills", detectAlirezaSkills],
  ["superclaude", detectSuperClaude],
  ["claude-code-router", detectClaudeCodeRouter],
  ["claude-plugins-official", detectClaudePluginsOfficial],
  ["rtk", detectRtk],
];

/**
 * Run the catalog-detector adapters (per-pack on-disk probes).
 * Honors SKIP_CATALOG_DETECTORS=1 so unit tests can disable adapters that
 * probe outside the fixture sandbox.
 */
export async function runCatalogDetectorAdapters(
  sink: PackScanSink
): Promise<Record<string, boolean>> {
  if (process.env.SKIP_CATALOG_DETECTORS === "1") {
    return {};
  }
  const results: Record<string, boolean> = {};
  for (const [name, fn] of CATALOG_ADAPTERS) {
    try {
      results[name] = await fn(sink);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      gatewayLog.warn("catalog-detector", `adapter ${name} failed: ${msg}`);
      results[name] = false;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// runPackScanner — top-level orchestrator
// ---------------------------------------------------------------------------

/**
 * PURE COMPUTE (FEA-3628). Run every scan path against an in-memory
 * `PackScanSink` — NO database connection. Best-effort: an exception in one
 * branch never blocks another. Returns the collected write plan plus per-phase
 * counts/scopes. Runs inside the pack-scan utilityProcess (or in-process via
 * {@link runPackScanner}). The single DB read (recent project roots) is done by
 * the caller and supplied via `input.recentProjectRoots`.
 */
export async function computePackScan(
  input: {
    recentProjectRoots: string[];
    cooperativeDelay?: (ms: number) => Promise<void>;
  },
  overrides: ComputePackScanOverrides = {}
): Promise<PackScanComputeResult> {
  const sink = new CollectingSink(input.recentProjectRoots);
  const scanners = {
    scanGStack: overrides.scanGStack || scanGStack,
    scanBmad: overrides.scanBmad || scanBmad,
    scanClaudeMarketplaces:
      overrides.scanClaudeMarketplaces || scanClaudeMarketplaces,
    scanProjectGStackAssociations:
      overrides.scanProjectGStackAssociations || scanProjectGStackAssociations,
    runCatalogDetectorAdapters:
      overrides.runCatalogDetectorAdapters || runCatalogDetectorAdapters,
  };
  const cooperativeDelay = overrides.cooperativeDelay ?? input.cooperativeDelay;
  const pauseAfterScannerPhase = () =>
    cooperativeDelay?.(PACK_SCANNER_PHASE_PAUSE_MS) ?? Promise.resolve();

  const counts: PackScanComputeResult["counts"] = {
    gstack: { installs: 0, skills: 0 },
    bmad: { installs: 0, skills: 0, projects: 0 },
    marketplaces: { installs: 0, skills: 0, marketplaces: 0 },
    catalogDetectors: {},
    gstackProjects: 0,
  };
  const scopes: Record<string, boolean> = {
    gstack: false,
    bmad: false,
    marketplaces: false,
    gstackProjects: false,
    catalogDetectors: false,
  };

  await pauseAfterScannerPhase();
  try {
    counts.gstack = await scanners.scanGStack(sink);
    scopes.gstack = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("pack-scanner", `gstack scan failed: ${msg}`);
  }
  await pauseAfterScannerPhase();
  try {
    counts.bmad = await scanners.scanBmad(sink);
    scopes.bmad = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("pack-scanner", `bmad scan failed: ${msg}`);
  }
  await pauseAfterScannerPhase();
  try {
    counts.marketplaces = await scanners.scanClaudeMarketplaces(sink);
    scopes.marketplaces = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("pack-scanner", `claude marketplace scan failed: ${msg}`);
  }
  await pauseAfterScannerPhase();
  try {
    counts.gstackProjects = await scanners.scanProjectGStackAssociations(sink);
    scopes.gstackProjects = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "pack-scanner",
      `gstack project association scan failed: ${msg}`
    );
  }
  await pauseAfterScannerPhase();
  try {
    counts.catalogDetectors = await scanners.runCatalogDetectorAdapters(sink);
    scopes.catalogDetectors = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("pack-scanner", `catalog detectors failed: ${msg}`);
  }
  await pauseAfterScannerPhase();

  return { plan: sink.toPlan(), counts, scopes };
}

/**
 * DB WRITE (FEA-3628). Replay a compute result through the real pack-store
 * upserts on the db-host's SOLE SQLite writer, then prune. Pruning tombstones
 * rows whose `last_seen_at` predates `scanStartedAt`; it is skipped when any
 * scan scope failed so a transient error can never tombstone real installs.
 * Each upsert is an independent single-statement `prisma.write`, matching the
 * original scanner's write granularity.
 */
export async function applyPackScan(
  db: PackScannerDb,
  compute: PackScanComputeResult,
  scanStartedAt: string
): Promise<PackScannerSummary> {
  for (const row of compute.plan.packs) {
    await upsertPack(db, row);
  }
  for (const row of compute.plan.skills) {
    await upsertSkill(db, row);
  }
  for (const row of compute.plan.associations) {
    await upsertProjectAssociation(db, row);
  }

  const summary: PackScannerSummary = {
    gstack: compute.counts.gstack,
    bmad: compute.counts.bmad,
    marketplaces: compute.counts.marketplaces,
    catalogDetectors: compute.counts.catalogDetectors,
    gstackProjects: compute.counts.gstackProjects,
    prunedBefore: scanStartedAt,
    scopes: compute.scopes,
    pruned: false,
    pruneSkipped: false,
  };

  const allSucceeded = Object.values(compute.scopes).every(Boolean);
  if (allSucceeded) {
    await pruneStaleRows(db, scanStartedAt);
    summary.pruned = true;
  } else {
    summary.pruneSkipped = true;
    const failedScopes = Object.entries(compute.scopes)
      .filter(([, ok]) => !ok)
      .map(([k]) => k)
      .join(", ");
    gatewayLog.warn(
      "pack-scanner",
      `skipping prune - some detector scopes failed: ${failedScopes}`
    );
  }
  return summary;
}

/**
 * In-process entry: read recent roots, run the pure-compute scan, then apply
 * the plan on `db`. This does the heavy compute ON the caller's process — it is
 * the fallback for when the pack-scan utilityProcess is unavailable, and the
 * path used by tests. The db-host normally runs the compute in the worker (see
 * `packScanner.run` in db-host-worker.ts) so scanning never starves DB reads.
 * Best-effort and safe to call repeatedly.
 */
export async function runPackScanner(
  db: PackScannerDb,
  overrides: ComputePackScanOverrides = {}
): Promise<PackScannerSummary> {
  const scanStartedAt = new Date().toISOString();
  const recentProjectRoots = await getRecentProjectRoots(db);
  const compute = await computePackScan({ recentProjectRoots }, overrides);
  return applyPackScan(db, compute, scanStartedAt);
}

// ---------------------------------------------------------------------------
// Test internals
// ---------------------------------------------------------------------------

export const _internals = {
  findSkillFiles,
  readBmadMarketplace,
  readBmadProjectManifest,
  detectBmadProjectInstall,
  readGStackVersion,
  KNOWN_MARKETPLACE_SOURCES,
  getRecentProjectRoots,
  pruneStaleRows,
  resolveClaudeHome,
  resolveCodexHome,
  detectVoltagentSubagents,
  detectAlirezaSkills,
  detectSuperClaude,
  detectClaudeCodeRouter,
  detectClaudePluginsOfficial,
  detectRtk,
  detectBinaryTool,
};
