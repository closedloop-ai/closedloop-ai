/**
 * MCP-server discovery collector (FEA-4095 — progressive discovery registers
 * installed components).
 *
 * The rest of the inventory rows MCP servers from *usage*: an `agent_components`
 * row of `component_kind='mcp'` is only minted when an `mcp__*` tool actually
 * fires (see `component-invocations.ts`). That makes an MCP server that is
 * installed/configured but never invoked invisible — the exact
 * "installed-but-unused" blind spot FEA-4095 is about. This collector closes the
 * gap for MCP the same way `definition-content-collector.ts` closes it for
 * skills/sub-agents/commands and `component-scanner.ts` closes it for plugins:
 * it walks the on-disk MCP configuration (independent of usage) and upserts one
 * presence row per configured server, so an installed server appears with zero
 * invocations rather than not existing until its first call.
 *
 * Identity contract: a discovered server is keyed by its bare server NAME
 * (`external_id = component_key = <name>`, e.g. `context7`) with the same
 * `deterministicComponentId('mcp', <name>)` id formula the event-driven path
 * uses — so a per-server presence row is stable and idempotent across re-scans.
 * Claude MCP *usage* keys per invoked tool name `mcp__server__method` (the Claude
 * parser does not populate `mcpServer`, so `component-invocations.ts` falls back
 * to the full tool name), so a Claude presence row (`context7`) and a Claude
 * usage row (`mcp__context7__resolve`) are DISTINCT `agent_components` rows today.
 * Converging them to a single server-level identity means normalizing the usage
 * key to the bare server, which reshapes the frozen golden-layer2 snapshots
 * (`test/golden/layer2-snapshots/*.json`, which pin Claude usage rows at the full
 * tool name) and requires human sign-off to regenerate — it is deliberately left
 * out of this collector-only change. See the review thread on this file.
 *
 * MCP is an OBSERVABLE-only kind (not distributable, like `tool`) and its config
 * is not prompt content, so a discovered row carries NO `content`/`content_hash`
 * and stays `resolved_state='unresolved'` — a name/label-only presence row, the
 * honest state for a component whose exact definition we do not capture. It also
 * carries NO `install_path`/`project_path`: those absolute paths embed the
 * operator's username and repo names and the component sync lane uploads them, so
 * a names-only presence row leaves them unset (privacy, no product value). The
 * declaring project root goes only in `local_project_path` (ISS-12169), which
 * that lane never selects.
 *
 * Removal reconciliation: after upserting still-configured servers, the scan
 * tombstones (`uninstalled_at`) any discovery-owned presence row whose server is
 * no longer in any config, and a re-observed server clears its tombstone — so
 * inventory never keeps reporting an uninstalled server as installed.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import path from "node:path";
import {
  AgentComponentKind,
  Harness,
} from "@repo/api/src/types/agent-component";
import { isTccProtectedPath } from "../../shared/sandbox-policy.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { getCodexConfigPath } from "../util/codex-home-paths.js";
import { resolveClaudeHome } from "./claude-home.js";
import { applyComponentTombstone } from "./component-tombstone.js";
import {
  ComponentScope,
  type ComponentScope as ComponentScopeType,
} from "./definition-content-collector.js";
import { getRecentProjectRoots, type PackScannerDb } from "./pack-scanner.js";

// A Codex `[mcp_servers.<name>]` TOML table header. Captures ONLY the first
// dotted key segment after `mcp_servers.` (the server NAME): a bare bareword up
// to the next `.` or `]`, or a quoted `"..."`/`'...'` name. This deliberately
// does NOT match a nested subtable like `[mcp_servers.linear.env]` (which
// configures the `linear` server, not a server named `linear.env`) — a greedy
// `[^\]]+` capture there would mint a spurious `linear.env` component row.
// Anchored + module-level per Ultracite `useTopLevelRegex`.
const MCP_SERVERS_HEADER_RE =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([^.\]\s]+))\s*\]\s*$/;
const LINE_SPLIT_RE = /\r?\n/;

// Upper bound on the bytes read from an MCP config file. A real `~/.claude.json`
// / `.mcp.json` / Codex `config.toml` is a few KB; 4 MiB is a generous ceiling
// that still bounds the read of an adversarial/huge file. See `safeReadMcpConfig`.
const MAX_MCP_CONFIG_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A configured MCP server discovered on disk (presence, independent of usage).
 *
 * Writes NO `install_path`/`project_path`: those absolute paths embed the
 * operator's username and repository names, and the component sync lane
 * uploads both columns to the cloud. For a names-only presence collector that
 * is a privacy leak with no product value — the row's job is "you have this
 * server installed", not "here is where on disk". So an MCP presence row leaves
 * both columns unset unless path upload becomes an explicit product/privacy
 * decision. `projectPath` below is the Desktop-local declaring root
 * (ISS-12169): it is stored only in `local_project_path`, which that lane never
 * selects, and never reaches `project_path`.
 */
type DiscoveredMcpServer = {
  /** Server name — the dedup key and display name (e.g. `context7`). */
  name: string;
  /**
   * Scope carried EXPLICITLY by the scan root, not path-derived: MCP config
   * files sit BESIDE `.claude/` (user `~/.claude.json`, Codex `config.toml`) or
   * at a project root (`.mcp.json`), so the `.claude/`-segment convention in
   * `deriveComponentScope` does not apply. The caller knows the scope from the
   * root it scanned. Null when unknown — never guessed.
   */
  scope: ComponentScopeType | null;
  /** Originating harness (`claude` for JSON config, `codex` for TOML). */
  harness: Harness;
  /**
   * ISS-12169: the project root whose `.mcp.json` declared the server, null for
   * a user config. Stored only in the Desktop-local `local_project_path`.
   */
  projectPath: string | null;
};

export type McpDiscoverySummary = {
  discovered: number;
  upserted: number;
  skipped: number;
  /**
   * Discovery-owned presence rows tombstoned this scan because their server is
   * no longer configured in any scanned config (their `last_seen_at` predates
   * the scan). Mirrors `pack-scanner`'s tombstone accounting.
   */
  tombstoned: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirror of write-core's `deterministicComponentId` so ids line up on insert. */
function deterministicComponentId(kind: string, externalId: string): string {
  return createHash("sha256")
    .update(`${kind}|${externalId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Read an MCP config file safely: `O_NOFOLLOW` so a repository-controlled
 * `.mcp.json` symlink can't redirect the read, a `fstat` regular-file check so
 * a FIFO / device node (`/dev/zero`) can't hang or stream unbounded into the
 * DB-host process, and a hard `MAX_MCP_CONFIG_BYTES` cap on what is read.
 * Returns `null` on any failure (missing, symlink, non-regular, unreadable) so
 * discovery degrades to skipping that config — never throwing. ISS-11914: also
 * `null`, without opening it, for a config inside a TCC-protected folder, where
 * reading raises a macOS permission prompt. Replaces
 * `safeReadFile` here specifically because these config paths are attacker-
 * influenceable at desktop startup.
 */
function safeReadMcpConfig(p: string): string | null {
  if (isTccProtectedPath(p)) {
    return null;
  }
  let fd: number | null = null;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: file open flags require bitwise OR
    const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
    fd = openSync(p, flags);
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return null;
    }
    const size = Math.min(stat.size, MAX_MCP_CONFIG_BYTES);
    if (size === 0) {
      return "";
    }
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
      if (bytesRead <= 0) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.toString("utf8", 0, offset);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

/**
 * A server name is persistable only if it is non-empty after trim.
 *
 * THE LENGTH CAP IS GONE (ISS-8201, whitlockk review on PR #7220). It mirrored a cap
 * `POST /desktop/components/sync` enforced on `externalId`/`componentKey`, and
 * its whole justification was that an over-long name would be rejected there and
 * wedge the ordered component cursor (Desktop never advances past a rejected
 * row). The ingest now admits any length and the write-side projection
 * (`INDEX_KEY_MAX_BYTES`) bounds the value at the column instead, so nothing
 * downstream rejects or wedges — and with the rejection gone, the drop was a
 * configured MCP server silently disappearing from the local inventory with no
 * signal anywhere, which is the failure this discovery pass exists to prevent.
 *
 * The blank-name refusal stays: an empty identity is not a server, and it would
 * key an `agent_components` row nothing could ever match back to a config.
 */
function isPersistableServerName(name: string): boolean {
  return name.trim().length > 0;
}

/**
 * Extract MCP server names from a parsed JSON config object. Claude Code stores
 * servers under a top-level `mcpServers` map (`~/.claude.json`, project
 * `.mcp.json`, and `.claude/settings*.json`), keyed by server name. Only the
 * KEY (server name) is needed for presence — the connection details are never
 * read (they can hold secrets/tokens).
 */
function serverNamesFromJson(parsed: unknown): string[] {
  if (parsed === null || typeof parsed !== "object") {
    return [];
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  // Must be a plain object map keyed by server name. An array (invalid config)
  // would otherwise yield numeric-index "names" via Object.keys.
  if (
    servers === null ||
    typeof servers !== "object" ||
    Array.isArray(servers)
  ) {
    return [];
  }
  return Object.keys(servers as Record<string, unknown>).filter(
    isPersistableServerName
  );
}

/**
 * Extract MCP server names from a Codex `config.toml`. Codex declares servers as
 * `[mcp_servers.<name>]` table headers. We deliberately do NOT depend on a TOML
 * parser (none is vendored) and we do NOT read the table bodies (they can hold
 * secrets) — only the server NAME in each header is needed for presence. The
 * header form is stable in Codex's config schema; a dotted/quoted name is
 * supported. Non-header lines are ignored.
 */
function serverNamesFromCodexToml(content: string): string[] {
  const names: string[] = [];
  for (const rawLine of content.split(LINE_SPLIT_RE)) {
    const match = MCP_SERVERS_HEADER_RE.exec(rawLine);
    if (!match) {
      continue;
    }
    // Exactly one of the three capture groups (double-quoted, single-quoted,
    // bareword) is populated for a matched header.
    const name = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (isPersistableServerName(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Fold a discovered server into the by-name accumulator. The FIRST scan root
 * wins the row's scope (roots scanned in caller order); a later root of a
 * DIFFERENT harness only upgrades the harness attribution to `both`, mirroring
 * `foldHarness` in the definition collector — so a server declared under both a
 * Claude and a Codex config reads back as `both` rather than losing the second
 * copy to per-name dedup.
 */
function foldServer(
  byName: Map<string, DiscoveredMcpServer>,
  next: DiscoveredMcpServer
): void {
  const existing = byName.get(next.name);
  if (!existing) {
    byName.set(next.name, next);
    return;
  }
  if (existing.harness !== next.harness) {
    existing.harness = Harness.Both;
  }
}

function discoverFromJsonConfig(
  byName: Map<string, DiscoveredMcpServer>,
  config: McpDiscoveryClaudeConfig
): void {
  const raw = safeReadMcpConfig(config.path);
  if (raw === null) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  for (const name of serverNamesFromJson(parsed)) {
    foldServer(byName, {
      name,
      scope: config.scope,
      harness: Harness.Claude,
      projectPath: config.projectPath ?? null,
    });
  }
}

function discoverFromCodexConfig(
  byName: Map<string, DiscoveredMcpServer>
): void {
  const configPath = getCodexConfigPath();
  const raw = safeReadMcpConfig(configPath);
  if (raw === null) {
    return;
  }
  for (const name of serverNamesFromCodexToml(raw)) {
    foldServer(byName, {
      name,
      // The Codex `config.toml` is the user-global Codex config.
      scope: ComponentScope.User,
      harness: Harness.Codex,
      projectPath: null,
    });
  }
}

/**
 * Fold the stored and observed harness on conflict. A plain
 * `COALESCE(stored, observed)` keeps the FIRST non-null value forever, so a row
 * first stored as `claude` (usage or a prior discovery) can never be promoted
 * to `both` when the same server is later observed under `codex` (and vice
 * versa) — the single-harness→dual-harness transition would silently never
 * happen. Instead: if either side is null keep the other; if they already
 * agree keep it; otherwise the server is attributed to both harnesses.
 */
const HARNESS_FOLD_SQL = `CASE
             WHEN agent_components.harness IS NULL THEN excluded.harness
             WHEN excluded.harness IS NULL THEN agent_components.harness
             WHEN agent_components.harness = excluded.harness THEN agent_components.harness
             ELSE '${Harness.Both}'
           END`;

async function upsertMcpComponent(
  db: PackScannerDb,
  server: DiscoveredMcpServer,
  now: string,
  summary: McpDiscoverySummary
): Promise<void> {
  const id = deterministicComponentId(AgentComponentKind.Mcp, server.name);
  const scope = server.scope;
  try {
    // MCP is observable-only: no distributable content, so `resolved_state`
    // stays 'unresolved' (name/label-only presence). No install_path/
    // project_path is written — a presence row carries no on-disk paths (they
    // would leak username/repo names to the cloud sync lane); the declaring
    // project root goes in the Desktop-local `local_project_path` instead.
    // `scope` and `local_project_path` are COALESCE-guarded so a pass that
    // cannot derive one (null) never clobbers a stored value; `harness` folds via
    // HARNESS_FOLD_SQL so a single-harness row can promote to `both`; and
    // `uninstalled_at` is cleared so a server that reappears after removal
    // sheds its tombstone.
    await db.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, name,
            scope, harness, resolved_state,
            local_project_path, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $3, $3, $4, $5, 'unresolved', $7, $6, $6)
         ON CONFLICT (component_kind, external_id) DO UPDATE SET
           scope        = COALESCE(agent_components.scope, excluded.scope),
           local_project_path = COALESCE(excluded.local_project_path,
                                         agent_components.local_project_path),
           harness      = ${HARNESS_FOLD_SQL},
           last_seen_at = excluded.last_seen_at,
           uninstalled_at = NULL`,
        id,
        AgentComponentKind.Mcp,
        server.name,
        scope,
        server.harness,
        now,
        server.projectPath
      )
    );
    summary.upserted += 1;
  } catch (e: unknown) {
    summary.skipped += 1;
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "mcp-discovery",
      `failed to upsert mcp server "${server.name}": ${msg}`
    );
  }
}

// ---------------------------------------------------------------------------
// discoverMcpServers
// ---------------------------------------------------------------------------

/**
 * Injectable scan roots — production resolves the real Claude/Codex config
 * paths; tests pass tmpdir paths.
 */
export type McpDiscoveryClaudeConfig = {
  /** Absolute path to a Claude-format JSON MCP config. */
  path: string;
  /**
   * Scope carried explicitly by the root (user for `~/.claude.json`, project
   * for a `.mcp.json` under a project root). Null when unknown — never guessed.
   */
  scope: ComponentScopeType | null;
  /** ISS-12169: the project root a `.mcp.json` belongs to. */
  projectPath?: string;
};

export type McpDiscoveryRoots = {
  /** Claude-format JSON MCP configs (user + per-project). */
  claudeJsonConfigs?: readonly McpDiscoveryClaudeConfig[];
  /** When true, also scan the resolved Codex `config.toml`. */
  includeCodex?: boolean;
  /**
   * ISS-12169: TCC-protected project roots whose `.mcp.json` was left unread.
   * A project-scoped row recorded under one of them is not tombstoned this
   * scan, nor, while the list is non-empty, is one with no recorded project.
   */
  heldProjectPaths?: readonly string[];
  /**
   * ISS-11914: when true, user-scoped rows are not tombstoned this scan, because
   * a user config inside a TCC-protected folder was left unread.
   */
  holdUserScoped?: boolean;
};

/**
 * Tombstone discovery-owned MCP presence rows the current scan did NOT observe
 * (their server was removed from every config), so local/cloud inventory stops
 * reporting an uninstalled server as installed. Only rows THIS collector owns
 * are touched: a presence row is minted with `name = external_id` (the bare
 * server name), whereas the usage path (`component-invocations.ts`) NEVER
 * writes `name` and keys Claude MCP usage by the full `mcp__server__method`
 * tool name — so scoping the update to `component_kind='mcp' AND
 * name = external_id` cannot tombstone a usage-minted row. A re-observed server
 * sheds its tombstone in `upsertMcpComponent` (which sets `uninstalled_at =
 * NULL` on conflict). Best-effort — a failure is logged and the scan still
 * reports its upserts.
 *
 * ISS-6881: written through {@link applyComponentTombstone} so the tombstone also
 * advances the sync ordering key past the live cursor. The component-sync lane is a
 * keyset lane over `(last_seen_at, id)`, so a row left at its stale ordering key
 * never re-enters the lane once the cursor has paged past it — the removed server
 * then stays "installed" in cloud inventory and search forever. Stamping
 * `scanStartedAt` is not enough on its own: the lane can have acknowledged a sibling
 * row this same scan wrote at that exact instant, and the composite key then ties on
 * the timestamp and loses on the id. The selection predicate is unaffected: it is
 * evaluated before the update, and reads `$1` (the scan instant), not the key.
 */
async function tombstoneAbsentMcpComponents(
  db: PackScannerDb,
  scanStartedAt: string,
  summary: McpDiscoverySummary,
  roots: McpDiscoveryRoots
): Promise<void> {
  const whereParams: string[] = [AgentComponentKind.Mcp];
  const param = (value: string): string => {
    whereParams.push(value);
    return `$${whereParams.length + 2}`;
  };
  let whereSql = `component_kind = $3
            AND name = external_id
            AND uninstalled_at IS NULL
            AND (last_seen_at IS NULL OR last_seen_at < $1)`;
  if (roots.holdUserScoped) {
    whereSql += ` AND (scope IS NULL OR scope <> ${param(ComponentScope.User)})`;
  }
  const heldProjectPaths = roots.heldProjectPaths ?? [];
  if (heldProjectPaths.length > 0) {
    // A row with no recorded project predates `local_project_path`, so it may
    // belong to a held project: it stays held until a scan records its project.
    whereSql += ` AND (scope IS NULL OR scope <> ${param(ComponentScope.Project)}
            OR (local_project_path IS NOT NULL
                AND local_project_path NOT IN (${heldProjectPaths.map(param).join(", ")})))`;
  }
  try {
    summary.tombstoned = await applyComponentTombstone(db, {
      uninstalledAt: scanStartedAt,
      scanInstant: scanStartedAt,
      whereSql,
      whereParams,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "mcp-discovery",
      `tombstone absent mcp servers failed: ${msg}`
    );
  }
}

/**
 * Discover configured MCP servers from the given roots and upsert one presence
 * row per server into `agent_components`, then tombstone any discovery-owned
 * presence row whose server is no longer configured. Best-effort: an
 * unreadable/invalid config is skipped, and an exception on one server is
 * logged and skipped; the rest continue.
 */
export async function discoverMcpServers(
  db: PackScannerDb,
  roots: McpDiscoveryRoots,
  nowIso: string = new Date().toISOString()
): Promise<McpDiscoverySummary> {
  const summary: McpDiscoverySummary = {
    discovered: 0,
    upserted: 0,
    skipped: 0,
    tombstoned: 0,
  };
  const byName = new Map<string, DiscoveredMcpServer>();

  for (const config of roots.claudeJsonConfigs ?? []) {
    discoverFromJsonConfig(byName, config);
  }
  if (roots.includeCodex) {
    discoverFromCodexConfig(byName);
  }

  summary.discovered = byName.size;
  for (const server of byName.values()) {
    await upsertMcpComponent(db, server, nowIso, summary);
  }
  // Reconcile removals AFTER the upserts stamp `last_seen_at = nowIso` on
  // still-configured servers, so only genuinely-absent rows fall below the
  // scan's `last_seen_at < nowIso` threshold.
  await tombstoneAbsentMcpComponents(db, nowIso, summary, roots);
  return summary;
}

/**
 * Production entrypoint: resolve the standard MCP config locations (the user
 * Claude config `~/.claude.json`, each recently-active project's `.mcp.json`,
 * and the Codex `config.toml`) and discover their servers. Best-effort — a
 * failure to enumerate project roots degrades to the home-scoped config.
 */
export async function discoverMcpServersFromDefaults(
  db: PackScannerDb
): Promise<McpDiscoverySummary> {
  let projectRoots: string[] = [];
  let heldProjectPaths: string[] = [];
  try {
    // ISS-11914: reading `.mcp.json` inside a TCC-protected folder raises a
    // macOS permission prompt, so those files are left unread. Their servers
    // keep their last-scanned state (Perrin Upcott's ruling, 2026-10-07), only
    // while such an unread file exists (a bare existence check, which raises no
    // prompt). ISS-12169: the hold covers only those projects' own rows.
    const recentRoots = await getRecentProjectRoots(db);
    const protectedRoots = recentRoots.filter((root) =>
      isTccProtectedPath(root)
    );
    projectRoots = recentRoots.filter((root) => !protectedRoots.includes(root));
    heldProjectPaths = protectedRoots.filter((root) =>
      existsSync(path.join(root, ".mcp.json"))
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn("mcp-discovery", `failed to resolve project roots: ${msg}`);
  }

  const claudeHome = resolveClaudeHome();
  // `~/.claude.json` is the user-global MCP config; it sits BESIDE `~/.claude`,
  // not inside it (Claude Code writes it to the OS home). Derive the home dir
  // from the resolved Claude home's parent so a relocated `$CLAUDE_HOME` still
  // resolves the sibling config correctly.
  const homeDir = path.dirname(claudeHome);
  const userConfigPath = path.join(homeDir, ".claude.json");
  // ISS-11914: `safeReadMcpConfig` leaves a user config inside a TCC-protected
  // folder unread, so user-scoped servers keep their last-scanned state while
  // such a file exists, the way the project hold above works.
  const holdUserScoped = [userConfigPath, getCodexConfigPath()].some(
    (configPath) => isTccProtectedPath(configPath) && existsSync(configPath)
  );
  const claudeJsonConfigs: McpDiscoveryClaudeConfig[] = [
    {
      path: userConfigPath,
      scope: ComponentScope.User,
    },
    ...projectRoots.map((root) => ({
      path: path.join(root, ".mcp.json"),
      scope: ComponentScope.Project,
      projectPath: root,
    })),
  ];

  return discoverMcpServers(db, {
    claudeJsonConfigs,
    includeCodex: true,
    heldProjectPaths,
    holdUserScoped,
  });
}
