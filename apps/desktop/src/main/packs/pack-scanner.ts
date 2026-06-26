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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type BinaryName,
  resolveBinaryFromLoginShellSync,
} from "../../server/shell-path.js";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { gatewayLog } from "../gateway-logger.js";
import {
  upsertPack,
  upsertProjectAssociation,
  upsertSkill,
} from "./pack-store.js";

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

type RunPackScannerOverrides = {
  scanGStack?: (db: PackScannerDb) => Promise<ScanGStackResult>;
  scanBmad?: (db: PackScannerDb) => Promise<ScanBmadResult>;
  scanClaudeMarketplaces?: (
    db: PackScannerDb
  ) => Promise<ScanMarketplacesResult>;
  scanProjectGStackAssociations?: (db: PackScannerDb) => Promise<number>;
  runCatalogDetectorAdapters?: (
    db: PackScannerDb
  ) => Promise<Record<string, boolean>>;
  cooperativeDelay?: (ms: number) => Promise<void>;
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
// Constants
// ---------------------------------------------------------------------------

const PROJECT_LOOKBACK_DAYS = 90;
const GIT_REMOTE_TIMEOUT_MS = 1500;
const PACK_SCANNER_PHASE_PAUSE_MS = 25;
const CLOSEDLOOP_WEB_COMMAND_PACK_ID = "closedloop-web-command-pack";
const CLOSEDLOOP_WEB_COMMAND_PACK_HARNESSES = [
  "claude",
  "codex",
  "cursor",
  "opencode",
] as const;

// Known Claude Code plugin marketplaces -> upstream repo URL. Marketplaces
// outside this table are still detected and registered as packs; they just
// get no source_url chip in the UI.
const KNOWN_MARKETPLACE_SOURCES: Record<string, string> = {
  "closedloop-ai": "https://github.com/closedloop-ai/claude-plugins",
  "claude-plugins-official":
    "https://github.com/anthropics/claude-plugins-official",
};

// Marketplaces whose plugins are conceptually ONE bundle (one logical pack
// shipped together) rather than independently-installable units. closedloop-ai
// is the canonical example: code/code-review/judges/platform/self-learning
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
// Filesystem helpers (sync — fine for probing)
// ---------------------------------------------------------------------------

function resolveClaudeHome(): string {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

function resolveCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function safeStat(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

function safeReadDir(p: string) {
  try {
    return readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeReadFile(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isSymlink(p: string): boolean {
  const st = safeStat(p);
  return !!st && st.isSymbolicLink();
}

// ---------------------------------------------------------------------------
// Deterministic IDs and frontmatter
// ---------------------------------------------------------------------------

export function deterministicSkillId(
  harness: string,
  installPath: string,
  name: string
): string {
  return createHash("sha256")
    .update(`${harness}|${installPath}|${name}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Parse YAML frontmatter from a SKILL.md file. Lenient: missing fields are
 * returned as null rather than throwing. Returns null when no frontmatter
 * block is present.
 */
export function parseSkillFrontmatter(
  content: string
): Record<string, string> | null {
  if (typeof content !== "string") {
    return null;
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return null;
  }
  const fields: Record<string, string> = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const sep = line.indexOf(":");
    if (sep < 0) {
      continue;
    }
    const key = line.slice(0, sep).trim().toLowerCase();
    let value = line.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Recursive skill-file walker
// ---------------------------------------------------------------------------

/**
 * Walk a directory recursively (bounded depth) and yield every SKILL.md path.
 * Symlinks inside a pack are followed once; depth is capped to avoid runaway
 * traversal if a user has a weird layout.
 */
function findSkillFiles(root: string, maxDepth = 6): string[] {
  const results: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  while (stack.length) {
    const { dir, depth } = stack.pop()!;
    if (depth > maxDepth) {
      continue;
    }
    for (const entry of safeReadDir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") {
          continue;
        }
        stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile() && entry.name === "SKILL.md") {
        results.push(full);
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Git remote helper
// ---------------------------------------------------------------------------

function deriveGitRemoteUrl(dir: string): string | null {
  try {
    const out = execFileSync(
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
async function getRecentProjectRoots(db: PackScannerDb): Promise<string[]> {
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
  db: PackScannerDb,
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
  const remoteUrl = opts.sourceUrl || deriveGitRemoteUrl(real);

  await upsertPack(db, {
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
    await upsertSkill(db, {
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
export async function scanGStack(db: PackScannerDb): Promise<ScanGStackResult> {
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
    const added = await ingestPackDir(db, {
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
          sourceUrl = deriveGitRemoteUrl(probe);
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
    await upsertPack(db, {
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
        await upsertSkill(db, {
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
 * Parse the project-local BMad install manifest (`_bmad/_config/manifest.yaml`)
 * to extract the installed version.
 */
function readBmadProjectManifest(
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
  const lines = content.split(/\r?\n/);
  let inInstallation = false;
  for (const raw of lines) {
    if (/^installation:\s*$/.test(raw)) {
      inInstallation = true;
      continue;
    }
    if (
      inInstallation &&
      /^[A-Za-z_][^:]*:/.test(raw) &&
      !raw.startsWith(" ")
    ) {
      break;
    }
    if (inInstallation) {
      const m = raw.match(
        /^\s+version:\s*['"]?([0-9][0-9A-Za-z.\-+]*)['"]?\s*$/
      );
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
function detectBmadProjectInstall(
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

/**
 * Ingest BMad v6+ skills from a project install path. Only pulls in
 * directories whose name is prefixed "bmad-".
 */
async function ingestBmadProjectSkills(
  db: PackScannerDb,
  opts: { installPath: string; harness: string; version: string | null }
): Promise<number> {
  await upsertPack(db, {
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
    await upsertSkill(db, {
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
export async function scanBmad(db: PackScannerDb): Promise<ScanBmadResult> {
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
    const added = await ingestPackDir(db, {
      packId: "bmad-method",
      harness: "claude",
      installPath,
      version: marketplace.version,
    });
    results.installs += 1;
    results.skills += added;
  }

  // 2 & 3. Per-project: walk distinct sessions.cwd from the last 90 days.
  for (const projectRoot of await getRecentProjectRoots(db)) {
    let added = 0;
    let installedHere = false;

    // 2. BMad v6+: project-local `.agents/skills/bmad-*` install. Stamp the
    // pack against both `claude` and `codex` harnesses because the manifest
    // explicitly lists both as supported IDEs.
    const v6 = detectBmadProjectInstall(projectRoot);
    if (v6) {
      for (const harness of ["claude", "codex"]) {
        added += await ingestBmadProjectSkills(db, {
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
      added += await ingestPackDir(db, {
        packId: "bmad-method",
        harness: "claude",
        installPath: legacyBmadDir,
        version: marketplace ? marketplace.version : null,
      });
      results.installs += 1;
      installedHere = true;
    }

    if (installedHere) {
      await upsertProjectAssociation(db, {
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
  db: PackScannerDb
): Promise<ScanMarketplacesResult> {
  const registryPath = path.join(
    resolveClaudeHome(),
    "plugins",
    "installed_plugins.json"
  );
  const raw = safeReadFile(registryPath);
  if (!raw) {
    return { installs: 0, skills: 0, marketplaces: 0 };
  }
  let registry: { plugins?: Record<string, unknown[]> };
  try {
    registry = JSON.parse(raw);
  } catch {
    return { installs: 0, skills: 0, marketplaces: 0 };
  }
  if (!registry || typeof registry.plugins !== "object") {
    return { installs: 0, skills: 0, marketplaces: 0 };
  }

  // Group installed plugins by marketplace name.
  const byMarketplace = new Map<
    string,
    Array<{ pluginName: string; installPath: string; version: string | null }>
  >();
  for (const [pluginRef, scopes] of Object.entries(registry.plugins!)) {
    const at = pluginRef.lastIndexOf("@");
    if (at < 1) {
      continue;
    }
    const pluginName = pluginRef.slice(0, at);
    const marketplace = pluginRef.slice(at + 1);
    if (!Array.isArray(scopes)) {
      continue;
    }
    for (const entry of scopes) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !(entry as Record<string, unknown>).installPath
      ) {
        continue;
      }
      const e = entry as { installPath: string; version?: string };
      if (!byMarketplace.has(marketplace)) {
        byMarketplace.set(marketplace, []);
      }
      byMarketplace.get(marketplace)!.push({
        pluginName,
        installPath: e.installPath,
        version: e.version || null,
      });
    }
  }

  // Pack IDs that already have dedicated scanners — skip them here so
  // marketplace installs of gstack or bmad-method don't get double-counted.
  const reservedPackIds = new Set(["gstack", "bmad-method"]);

  const results: ScanMarketplacesResult & { plugins: number } = {
    installs: 0,
    skills: 0,
    marketplaces: 0,
    plugins: 0,
  };

  for (const [marketplace, plugins] of byMarketplace.entries()) {
    if (reservedPackIds.has(marketplace)) {
      continue;
    }
    const sourceUrl = KNOWN_MARKETPLACE_SOURCES[marketplace] || null;

    if (MARKETPLACE_BUNDLE_AS_PACK.has(marketplace)) {
      // BUNDLED PATH: closedloop-ai and friends — the marketplace IS the
      // pack, sub-plugins are skills.
      const cacheRoot = path.join(
        resolveClaudeHome(),
        "plugins",
        "cache",
        marketplace
      );
      await upsertPack(db, {
        pack_id: marketplace,
        harness: "claude",
        install_path: cacheRoot,
        install_kind: "directory",
        source_url: sourceUrl,
        version: null,
      });
      results.installs += 1;
      for (const plugin of plugins) {
        if (!safeStat(plugin.installPath)) {
          continue;
        }
        const skillsDir = path.join(plugin.installPath, "skills");
        for (const skillFile of findSkillFiles(skillsDir)) {
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
          await upsertSkill(db, {
            skill_id: deterministicSkillId("claude", cacheRoot, name),
            pack_id: marketplace,
            harness: "claude",
            install_path: skillFile,
            name,
            version: meta.version || plugin.version || null,
            description: meta.description || null,
            source_url: sourceUrl,
          });
          results.skills += 1;
        }
      }
      results.marketplaces += 1;
      continue;
    }

    // PER-PLUGIN PATH: claude-plugins-official, superpowers-marketplace, etc.
    for (const plugin of plugins) {
      if (!safeStat(plugin.installPath)) {
        continue;
      }
      if (reservedPackIds.has(plugin.pluginName)) {
        continue;
      }
      await upsertPack(db, {
        pack_id: plugin.pluginName,
        harness: "claude",
        install_path: plugin.installPath,
        install_kind: "directory",
        source_url: sourceUrl,
        version: plugin.version,
      });
      results.installs += 1;
      results.plugins += 1;
      const skillsDir = path.join(plugin.installPath, "skills");
      for (const skillFile of findSkillFiles(skillsDir)) {
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
        await upsertSkill(db, {
          skill_id: deterministicSkillId("claude", plugin.installPath, name),
          pack_id: plugin.pluginName,
          harness: "claude",
          install_path: skillFile,
          name,
          version: meta.version || plugin.version || null,
          description: meta.description || null,
          source_url: sourceUrl,
        });
        results.skills += 1;
      }
    }
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
  db: PackScannerDb
): Promise<number> {
  let count = 0;
  for (const projectRoot of await getRecentProjectRoots(db)) {
    const marker = path.join(projectRoot, ".gstack", "conductor.json");
    if (!safeStat(marker)) {
      continue;
    }
    await upsertProjectAssociation(db, {
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

async function detectVoltagentSubagents(db: PackScannerDb): Promise<boolean> {
  const root = path.join(resolveClaudeHome(), "skills", "voltagent-subagents");
  if (!safeStat(root)) {
    return false;
  }
  await upsertPack(db, {
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
        await upsertSkill(db, {
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

async function detectAlirezaSkills(db: PackScannerDb): Promise<boolean> {
  const root = path.join(
    resolveClaudeHome(),
    "skills",
    "alirezarezvani-claude-skills"
  );
  if (!safeStat(root)) {
    return false;
  }
  await upsertPack(db, {
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
    await upsertSkill(db, {
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

async function detectSuperClaude(db: PackScannerDb): Promise<boolean> {
  // SuperClaude installs commands (NOT skills) into ~/.claude/commands/sc/.
  const root = path.join(resolveClaudeHome(), "commands", "sc");
  if (!safeStat(root)) {
    return false;
  }
  await upsertPack(db, {
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
    await upsertSkill(db, {
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
  db: PackScannerDb
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
  await upsertPack(db, {
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
  db: PackScannerDb,
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
    if (resolved.source === "path") {
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
      const out = execFileSync(binaryPath, opts.versionArgs, {
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
    await upsertPack(db, {
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

async function detectRtk(db: PackScannerDb): Promise<boolean> {
  return detectBinaryTool(db, {
    pack_id: "rtk",
    binNames: ["rtk"],
    source_url: "https://github.com/rtk-ai/rtk",
    harnesses: ["claude", "codex"],
    versionArgs: ["--version"],
  });
}

async function detectClaudeCodeRouter(db: PackScannerDb): Promise<boolean> {
  // Global npm install — probe via `npm ls -g` (fast, no network).
  let installed = false;
  try {
    execFileSync(
      "npm",
      ["ls", "-g", "--depth=0", "@musistudio/claude-code-router"],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }
    );
    installed = true;
  } catch {
    // Fall back to probing the binary on PATH.
    installed = resolveBinaryFromLoginShellSync("ccr").source === "path";
  }
  if (!installed) {
    return false;
  }
  await upsertPack(db, {
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

function resolveBundledCommandPackPath(): string | null {
  const processWithResources = process as NodeJS.Process & {
    resourcesPath?: string;
  };
  const candidates = [
    processWithResources.resourcesPath
      ? path.join(
          processWithResources.resourcesPath,
          "command-packs",
          CLOSEDLOOP_WEB_COMMAND_PACK_ID
        )
      : null,
    path.join(
      process.cwd(),
      "resources",
      "command-packs",
      CLOSEDLOOP_WEB_COMMAND_PACK_ID
    ),
    path.join(
      process.cwd(),
      "apps",
      "desktop",
      "resources",
      "command-packs",
      CLOSEDLOOP_WEB_COMMAND_PACK_ID
    ),
    path.join(
      __dirname,
      "..",
      "..",
      "resources",
      "command-packs",
      CLOSEDLOOP_WEB_COMMAND_PACK_ID
    ),
  ].filter((candidate): candidate is string => typeof candidate === "string");

  for (const candidate of candidates) {
    const manifest = path.join(candidate, "manifest.json");
    const stat = safeStat(manifest);
    if (stat?.isFile()) {
      return candidate;
    }
  }
  return null;
}

function readCommandPackVersion(installPath: string): string | null {
  const raw = safeReadFile(path.join(installPath, "manifest.json"));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "number" ||
      typeof parsed.version === "string"
      ? String(parsed.version)
      : null;
  } catch {
    return null;
  }
}

export async function detectClosedloopWebCommandPack(
  db: PackScannerDb
): Promise<boolean> {
  const installPath = resolveBundledCommandPackPath();
  if (!installPath) {
    return false;
  }
  const version = readCommandPackVersion(installPath);
  for (const harness of CLOSEDLOOP_WEB_COMMAND_PACK_HARNESSES) {
    await upsertPack(db, {
      pack_id: CLOSEDLOOP_WEB_COMMAND_PACK_ID,
      harness,
      install_path: installPath,
      install_kind: "directory",
      source_url: "https://github.com/closedloop-ai/symphony-alpha",
      version,
    });
  }
  return true;
}

type CatalogAdapter = [string, (db: PackScannerDb) => Promise<boolean>];

const CATALOG_ADAPTERS: CatalogAdapter[] = [
  [CLOSEDLOOP_WEB_COMMAND_PACK_ID, detectClosedloopWebCommandPack],
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
  db: PackScannerDb
): Promise<Record<string, boolean>> {
  if (process.env.SKIP_CATALOG_DETECTORS === "1") {
    return {};
  }
  const results: Record<string, boolean> = {};
  for (const [name, fn] of CATALOG_ADAPTERS) {
    try {
      results[name] = await fn(db);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      gatewayLog.warn("catalog-detector", `adapter ${name} failed: ${msg}`);
      results[name] = false;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Prune stale rows
// ---------------------------------------------------------------------------

/**
 * Tombstone rows the current scan didn't observe. Packs/skills that USED to
 * be installed are kept around with `uninstalled_at` set so the catalog can
 * surface "previously installed, used N times" badges.
 * project_pack_associations is still pruned (associations are observational).
 */
async function pruneStaleRows(
  db: PackScannerDb,
  scanStartedAt: string
): Promise<void> {
  try {
    await db.write((client) =>
      client.agentPack.updateMany({
        where: { lastSeenAt: { lt: scanStartedAt }, uninstalledAt: null },
        data: { uninstalledAt: scanStartedAt },
      })
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("pack-scanner", `tombstone agent_packs failed: ${msg}`);
  }
  try {
    await db.write((client) =>
      client.skill.updateMany({
        where: { lastSeenAt: { lt: scanStartedAt }, uninstalledAt: null },
        data: { uninstalledAt: scanStartedAt },
      })
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("pack-scanner", `tombstone skills failed: ${msg}`);
  }
  try {
    await db.write((client) =>
      client.projectPackAssociation.deleteMany({
        where: { lastSeenAt: { lt: scanStartedAt } },
      })
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "pack-scanner",
      `prune project_pack_associations failed: ${msg}`
    );
  }
}

// ---------------------------------------------------------------------------
// runPackScanner — top-level orchestrator
// ---------------------------------------------------------------------------

/**
 * Top-level entry: run every scan path. Best-effort — exceptions in one branch
 * never block another. Safe to call repeatedly. At the end, prune any
 * inventory rows whose last_seen_at wasn't refreshed. Pruning is skipped when
 * any detector fails so a transient error cannot tombstone real installs.
 */
export async function runPackScanner(
  db: PackScannerDb,
  overrides: RunPackScannerOverrides = {}
): Promise<PackScannerSummary> {
  const scanStartedAt = new Date().toISOString();
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
  const pauseAfterScannerPhase = () =>
    overrides.cooperativeDelay?.(PACK_SCANNER_PHASE_PAUSE_MS) ??
    Promise.resolve();
  const summary: PackScannerSummary = {
    gstack: { installs: 0, skills: 0 },
    bmad: { installs: 0, skills: 0, projects: 0 },
    marketplaces: { installs: 0, skills: 0, marketplaces: 0 },
    catalogDetectors: {},
    gstackProjects: 0,
    prunedBefore: scanStartedAt,
    scopes: {
      gstack: false,
      bmad: false,
      marketplaces: false,
      gstackProjects: false,
      catalogDetectors: false,
    },
    pruned: false,
    pruneSkipped: false,
  };

  await pauseAfterScannerPhase();
  try {
    summary.gstack = await scanners.scanGStack(db);
    summary.scopes.gstack = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("pack-scanner", `gstack scan failed: ${msg}`);
  }
  await pauseAfterScannerPhase();
  try {
    summary.bmad = await scanners.scanBmad(db);
    summary.scopes.bmad = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("pack-scanner", `bmad scan failed: ${msg}`);
  }
  await pauseAfterScannerPhase();
  try {
    summary.marketplaces = await scanners.scanClaudeMarketplaces(db);
    summary.scopes.marketplaces = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("pack-scanner", `claude marketplace scan failed: ${msg}`);
  }
  await pauseAfterScannerPhase();
  try {
    summary.gstackProjects = await scanners.scanProjectGStackAssociations(db);
    summary.scopes.gstackProjects = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "pack-scanner",
      `gstack project association scan failed: ${msg}`
    );
  }
  await pauseAfterScannerPhase();
  try {
    summary.catalogDetectors = await scanners.runCatalogDetectorAdapters(db);
    summary.scopes.catalogDetectors = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("pack-scanner", `catalog detectors failed: ${msg}`);
  }
  await pauseAfterScannerPhase();

  const allSucceeded = Object.values(summary.scopes).every(Boolean);
  if (allSucceeded) {
    await pruneStaleRows(db, scanStartedAt);
    summary.pruned = true;
  } else {
    summary.pruneSkipped = true;
    const failedScopes = Object.entries(summary.scopes)
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
