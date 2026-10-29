/**
 * @file catalog-contents.ts — fetch per-pack contents (skills, agents,
 * commands, sub-plugins) from GitHub for the catalog detail view
 * (FEA-1314 v3). Cached in pack_catalog.contents_cache via
 * catalog-store.applyContentsFetch with a 7-day TTL.
 *
 * The per-pack `contents` JSON in catalog-seed.json declares how to scrape
 * each pack:
 *   - github-skill-tree         — list <skills_path>/<dir>/SKILL.md
 *   - github-multi-skill-tree   — multiple skill_paths (BMad)
 *   - github-flat-md            — flat dir of .md files (SuperClaude commands)
 *   - github-nested-md          — categories/<cat>/<file>.md (VoltAgent)
 *   - github-nested-skill-tree  — <team>/skills/<skill>/SKILL.md (alirezarezvani)
 *   - claude-marketplace        — read .claude-plugin/marketplace.json (closedloop)
 *   - github-claude-plugin      — single marketplace plugin: walks commands/ +
 *                                  agents/ + skills/ if present under plugin_path
 *                                  (claude-plugins-official entries)
 *   - bundled-local             — ships inside Desktop, installs from disk, so
 *                                  there is no remote tree to list (ISS-10605)
 *   - none                      — pack has no skill/command listing (RTK, claude-code-router)
 *
 * Returns [{ name, type, description?, path? }]. Description may be null when
 * the upstream manifest omits it. type is one of
 * 'skill', 'command', 'agent', 'plugin'.
 */

import { z } from "zod";
import type { DesktopPrisma } from "../database/prisma-client.js";
import { gatewayLog } from "../logging/gateway-logger.js";
import { Observability } from "../telemetry/observability.js";
import {
  MARKETPLACE_MANIFEST_INVALID_TELEMETRY_CATEGORY,
  MARKETPLACE_MANIFEST_VALIDATION_ERROR_MESSAGE,
} from "../telemetry/telemetry-protocol.js";

import {
  contentsEndpoint,
  fetchGithubJsonResult,
  GitHubJsonFetchStatus,
  type ParsedRepo,
  parseGithubUrl,
} from "./catalog-github-client.js";
import { applyContentsFetch } from "./catalog-store.js";

const MAX_CATALOG_CONTENT_ITEMS = 100;

// ---------- types ----------

export type ContentItemKind = "skill" | "command" | "agent" | "plugin";

export const CatalogContentsFetchStatus = {
  Success: "success",
  Unavailable: "unavailable",
} as const;

export type ContentItem = {
  name: string;
  type: ContentItemKind;
  description?: string | null;
  path?: string;
  category?: string;
  /** Present on marketplace plugin items after per-plugin skill scrape. */
  skill_count?: number;
  skills?: string[];
};

/**
 * `contents.type` for a pack that ships inside Desktop and installs from disk.
 *
 * ISS-10605: such a pack has no upstream repository whose stars and forks could
 * be measured, so the catalog fetch must not attempt a lookup for it at all.
 * Declared here beside `ContentsType` so the union member, the dispatch arm and
 * the fetch-side check cannot drift to different spellings.
 */
export const BUNDLED_LOCAL_CONTENTS_TYPE = "bundled-local" as const;

type ContentsType =
  | "github-skill-tree"
  | "github-multi-skill-tree"
  | "github-flat-md"
  | "github-nested-md"
  | "github-nested-skill-tree"
  | "claude-marketplace"
  | "github-claude-plugin"
  | typeof BUNDLED_LOCAL_CONTENTS_TYPE
  | "none";

type ContentsSpec = {
  type?: ContentsType;
  skills_path?: string;
  skill_paths?: string[];
  skill_marker?: string;
  md_path?: string;
  kind?: ContentItemKind;
  root_path?: string;
  match_pattern?: string;
  marketplace_repo?: string;
  plugins_root?: string;
  plugin_path?: string;
};

export type CatalogEntry = {
  packId: string;
  githubUrl: string;
  contents: Record<string, unknown> | null;
  contentsFetchedAt?: string | null;
};

export type CatalogContentsFetchResult =
  | { status: typeof CatalogContentsFetchStatus.Success; items: ContentItem[] }
  | { status: typeof CatalogContentsFetchStatus.Unavailable; items: null };

type GitHubTreeEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
  content?: string;
};

type ParsedMarketplaceDescription = {
  value: string | null;
  invalid: boolean;
};

type ParsedMarketplacePlugin =
  | {
      valid: true;
      name: string;
      description: string | null;
      invalidDescription: boolean;
    }
  | { valid: false };

type GithubContentsResult<T> =
  | { status: typeof GitHubJsonFetchStatus.Success; value: T }
  | {
      status: typeof GitHubJsonFetchStatus.NotFound;
      value: null;
      reason: "not_found" | "refused_path";
    }
  | { status: typeof GitHubJsonFetchStatus.Unavailable; value: null };

const MARKETPLACE_DESCRIPTION_SCHEMA = z
  .string()
  .optional()
  .transform(
    (description): ParsedMarketplaceDescription => ({
      value: description || null,
      invalid: false,
    })
  )
  .catch({ value: null, invalid: true });

const MARKETPLACE_PLUGIN_NAME_REGEX = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

const MARKETPLACE_PLUGIN_SCHEMA = z
  .object({
    // The name is both the rendered identity and a path segment in the
    // plugins_root enrichment lookup, so it is bounded to `[A-Za-z0-9._-]` with
    // no leading dot (ISS-8883). `contentsEndpoint` is what actually holds the
    // traversal line — it refuses a `..` segment and percent-encodes `#`/`?`
    // per segment, and every path built from this name goes through it — so
    // this bound is defence in depth over a name that has no business carrying
    // path syntax, not the only thing standing between a manifest and a
    // repository contents request. The cost of keeping it is real:
    // a plugin named "My Plugin" is dropped from the catalog. Judged, never
    // coerced: a well-formed name still emits byte-identically.
    name: z.string().refine((name) => MARKETPLACE_PLUGIN_NAME_REGEX.test(name)),
    description: MARKETPLACE_DESCRIPTION_SCHEMA,
  })
  .transform(
    (plugin): ParsedMarketplacePlugin => ({
      valid: true,
      name: plugin.name,
      description: plugin.description.value,
      invalidDescription: plugin.description.invalid,
    })
  )
  .catch({ valid: false });

const MARKETPLACE_MANIFEST_SCHEMA = z.object({
  plugins: z.array(MARKETPLACE_PLUGIN_SCHEMA).optional(),
});

// ---------- low-level GitHub helpers ----------

function readString(
  value: Record<string, unknown>,
  key: keyof ContentsSpec
): string | undefined {
  const raw = value[key];
  return typeof raw === "string" ? raw : undefined;
}

function readStringArray(
  value: Record<string, unknown>,
  key: keyof ContentsSpec
): string[] {
  const raw = value[key];
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : [];
}

function readKind(value: Record<string, unknown>): ContentItemKind | undefined {
  const raw = value.kind;
  return raw === "skill" ||
    raw === "command" ||
    raw === "agent" ||
    raw === "plugin"
    ? raw
    : undefined;
}

function parseSkillFrontmatterFromBase64(
  b64: string | undefined
): Record<string, string> {
  if (!b64) {
    return {};
  }
  try {
    const content = Buffer.from(b64, "base64").toString("utf8");
    const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) {
      return {};
    }
    const fields: Record<string, string> = {};
    for (const raw of m[1].split(/\r?\n/)) {
      const line = raw.trim();
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
  } catch {
    return {};
  }
}

// ---------- per-type fetchers ----------

async function fetchSkillTree(
  owner: string,
  repo: string,
  skillsPath: string,
  marker?: string,
  options: { missingRootAsEmpty?: boolean } = {}
): Promise<ContentItem[] | null> {
  const skillMarker = marker || "SKILL.md";
  if (!isUsableContentsPath(skillMarker)) {
    return null;
  }
  const items = await githubContents<GitHubTreeEntry[]>(
    owner,
    repo,
    skillsPath
  );
  if (
    items.status === GitHubJsonFetchStatus.NotFound &&
    options.missingRootAsEmpty
  ) {
    return [];
  }
  if (items.status !== GitHubJsonFetchStatus.Success) {
    return null;
  }
  if (!Array.isArray(items.value)) {
    return null;
  }

  const skills: ContentItem[] = [];
  for (const entry of items.value) {
    // Soft cap to avoid blowing the API budget: one marker read per skill.
    if (skills.length >= MAX_CATALOG_CONTENT_ITEMS) {
      break;
    }
    if (entry.type !== "dir") {
      continue;
    }
    // Fetch the marker file's frontmatter (one extra API call per skill).
    // `entry.path` is response-owned and the marker is seed-owned; a refused
    // response path skips just that entry, while an API failure aborts so a
    // partial scrape never overwrites the cache.
    const file = await githubContents<GitHubTreeEntry>(
      owner,
      repo,
      `${entry.path}/${skillMarker}`,
      { refusedPath: GitHubJsonFetchStatus.NotFound }
    );
    if (file.status === GitHubJsonFetchStatus.Unavailable) {
      return null;
    }
    if (file.status === GitHubJsonFetchStatus.NotFound || !file.value.content) {
      skills.push({ name: entry.name, type: "skill", path: entry.path });
      continue;
    }
    const meta = parseSkillFrontmatterFromBase64(file.value.content);
    skills.push({
      name: meta.name || entry.name,
      type: "skill",
      description: meta.description || null,
      path: entry.path,
    });
  }
  return skills;
}

async function fetchFlatMd(
  owner: string,
  repo: string,
  mdPath: string,
  kind?: ContentItemKind
): Promise<ContentItem[] | null> {
  const items = await githubContents<GitHubTreeEntry[]>(owner, repo, mdPath);
  if (items.status !== GitHubJsonFetchStatus.Success) {
    return null;
  }
  if (!Array.isArray(items.value)) {
    return null;
  }
  return items.value
    .filter(
      (e) =>
        e.type === "file" &&
        e.name.endsWith(".md") &&
        !e.name.toLowerCase().startsWith("readme")
    )
    .map((e) => ({
      name: e.name.replace(/\.md$/, ""),
      type: kind || "command",
      path: e.path,
    }));
}

async function fetchNestedMd(
  owner: string,
  repo: string,
  rootPath: string,
  kind?: ContentItemKind
): Promise<ContentItem[] | null> {
  const top = await githubContents<GitHubTreeEntry[]>(owner, repo, rootPath);
  if (top.status !== GitHubJsonFetchStatus.Success) {
    return null;
  }
  if (!Array.isArray(top.value)) {
    return null;
  }

  const items: ContentItem[] = [];
  let categoryReads = 0;
  for (const cat of top.value) {
    // Soft cap to avoid blowing the API budget: one read per category, and a
    // single category can itself list a thousand files. Counted on READS as
    // well as items, because an empty or README-only category costs a call
    // and adds nothing.
    if (
      items.length >= MAX_CATALOG_CONTENT_ITEMS ||
      categoryReads >= MAX_CATALOG_CONTENT_ITEMS
    ) {
      break;
    }
    if (cat.type !== "dir") {
      continue;
    }
    categoryReads += 1;
    const inner = await githubContents<GitHubTreeEntry[]>(
      owner,
      repo,
      cat.path,
      { refusedPath: GitHubJsonFetchStatus.NotFound }
    );
    if (
      inner.status === GitHubJsonFetchStatus.NotFound &&
      inner.reason === "refused_path"
    ) {
      continue;
    }
    if (inner.status !== GitHubJsonFetchStatus.Success) {
      return null;
    }
    if (!Array.isArray(inner.value)) {
      return null;
    }
    for (const file of inner.value) {
      if (items.length >= MAX_CATALOG_CONTENT_ITEMS) {
        break;
      }
      if (file.type !== "file") {
        continue;
      }
      if (!file.name.endsWith(".md")) {
        continue;
      }
      if (file.name.toLowerCase().startsWith("readme")) {
        continue;
      }
      items.push({
        name: file.name.replace(/\.md$/, ""),
        type: kind || "agent",
        category: cat.name,
        path: file.path,
      });
    }
  }
  return items;
}

async function fetchMultiSkillTree(
  owner: string,
  repo: string,
  paths: string[] | undefined,
  marker?: string
): Promise<ContentItem[] | null> {
  const out: ContentItem[] = [];
  for (const p of paths || []) {
    const items = await fetchSkillTree(owner, repo, p, marker);
    if (!items) {
      return null;
    }
    out.push(...items);
  }
  return out;
}

async function fetchClaudeMarketplace(
  owner: string,
  repo: string,
  pluginsRoot?: string
): Promise<ContentItem[] | null> {
  // Read .claude-plugin/marketplace.json for the canonical list.
  const meta = await githubContents<GitHubTreeEntry>(
    owner,
    repo,
    ".claude-plugin/marketplace.json"
  );
  if (meta.status !== GitHubJsonFetchStatus.Success || !meta.value.content) {
    return null;
  }
  const plugins = parseMarketplacePlugins(meta.value.content);
  if (!plugins) {
    return null;
  }
  // If a plugins_root is declared, walk each plugin's skills/ dir for a
  // richer breakdown. Abort on API failure so a partial enrichment does not
  // overwrite a complete cached scrape.
  if (pluginsRoot) {
    const enriched = await enrichMarketplacePluginSkills(
      owner,
      repo,
      pluginsRoot,
      plugins
    );
    if (!enriched) {
      return null;
    }
  }
  return plugins;
}

/**
 * Validate a base64 marketplace manifest into its plugin items, dropping any
 * record that cannot be trusted and reporting the aggregate bad-data counts.
 *
 * Returns `null` for a manifest that carries no usable plugin list at all:
 * undecodable, structurally invalid, or simply absent. The caller treats that
 * as unavailable so a corrupt remote manifest cannot overwrite a good cache.
 */
function parseMarketplacePlugins(base64Content: string): ContentItem[] | null {
  const decoded = decodeMarketplaceManifest(base64Content);
  // A manifest that cannot be decoded is the same corrupt-remote-input class as
  // one that fails the schema, and reaches the caller as the same unavailable
  // result, so it owes the same report.
  const parsed = decoded
    ? MARKETPLACE_MANIFEST_SCHEMA.safeParse(decoded.value)
    : null;
  if (!parsed?.success) {
    reportInvalidMarketplaceManifest({
      invalidManifest: true,
      invalidPlugins: 0,
      invalidDescriptions: 0,
    });
    return null;
  }
  if (!parsed.data.plugins) {
    return null;
  }
  const items: ContentItem[] = [];
  let invalidPlugins = 0;
  let invalidDescriptions = 0;
  for (const plugin of parsed.data.plugins) {
    if (!plugin.valid) {
      invalidPlugins += 1;
      continue;
    }
    if (plugin.invalidDescription) {
      invalidDescriptions += 1;
    }
    items.push({
      name: plugin.name,
      type: "plugin",
      description: plugin.description,
    });
  }
  reportInvalidMarketplaceManifest({
    invalidManifest: false,
    invalidPlugins,
    invalidDescriptions,
  });
  return items;
}

async function enrichMarketplacePluginSkills(
  owner: string,
  repo: string,
  pluginsRoot: string,
  items: ContentItem[]
): Promise<boolean> {
  for (const item of items.slice(0, MAX_CATALOG_CONTENT_ITEMS)) {
    const skills = await fetchSkillTree(
      owner,
      repo,
      `${pluginsRoot}/${item.name}/skills`,
      undefined,
      { missingRootAsEmpty: true }
    );
    if (!skills) {
      return false;
    }
    item.skill_count = skills.length;
    item.skills = skills.map((s) => s.name);
  }
  return true;
}

function reportInvalidMarketplaceManifest(summary: {
  invalidManifest: boolean;
  invalidPlugins: number;
  invalidDescriptions: number;
}): void {
  if (
    !summary.invalidManifest &&
    summary.invalidPlugins === 0 &&
    summary.invalidDescriptions === 0
  ) {
    return;
  }
  // The three counters are what separates a wholly corrupt manifest from one
  // bad plugin or one bad description, so they travel with BOTH sinks. They are
  // array-derived integers — bounded and content-free, never a name or a URL.
  const counts = `invalid_manifest=${summary.invalidManifest ? 1 : 0} invalid_plugins=${summary.invalidPlugins} invalid_descriptions=${summary.invalidDescriptions}`;
  gatewayLog.warn(
    "catalog-contents",
    `remote marketplace manifest failed validation; ${counts}. Invalid plugin entries were dropped and invalid descriptions were omitted.`
  );
  try {
    // Catalog fetching runs on the DB-host store thread. Its process-local
    // app-exception bridge has no bound runtime, so use the existing two-hop
    // telemetry relay; DbHostClient consumes this discriminator in Electron
    // main and emits through the monitored main-process bridge there. The
    // canonical prefix stays leading so the relayed error groups unchanged.
    Observability.getTelemetryEmitter().emit({
      severity: "error",
      category: MARKETPLACE_MANIFEST_INVALID_TELEMETRY_CATEGORY,
      message: `${MARKETPLACE_MANIFEST_VALIDATION_ERROR_MESSAGE}; ${counts}`,
    });
  } catch {
    // Reporting failure must not turn malformed optional catalog metadata into
    // a Desktop render failure; gatewayLog above remains the durable record.
  }
}

/**
 * Walk a single claude-plugins-official-style plugin dir for its commands,
 * agents, and skills. Plugins in that marketplace have a mixed layout —
 * some have only commands/, some commands + agents, some skills, etc. —
 * so a single dispatch needs to handle whichever subset is present.
 */
async function fetchClaudePlugin(
  owner: string,
  repo: string,
  pluginPath: string
): Promise<ContentItem[] | null> {
  const items: ContentItem[] = [];
  const top = await githubContents<GitHubTreeEntry[]>(owner, repo, pluginPath);
  if (top.status !== GitHubJsonFetchStatus.Success) {
    return null;
  }
  if (!Array.isArray(top.value)) {
    return null;
  }
  const hasDir = (name: string): boolean =>
    top.value.some((e) => e.type === "dir" && e.name === name);
  // Soft cap across the three sub-walks together, so the plugin's union is
  // bounded the same way each walker is on its own.
  const underCap = (): boolean => items.length < MAX_CATALOG_CONTENT_ITEMS;

  // commands/<name>.md
  if (hasDir("commands") && underCap()) {
    const commands = await fetchFlatMd(
      owner,
      repo,
      `${pluginPath}/commands`,
      "command"
    );
    if (!commands) {
      return null;
    }
    items.push(...commands);
  }
  // agents/<name>.md
  if (hasDir("agents") && underCap()) {
    const agents = await fetchFlatMd(
      owner,
      repo,
      `${pluginPath}/agents`,
      "agent"
    );
    if (!agents) {
      return null;
    }
    items.push(...agents);
  }
  // skills/<name>/SKILL.md
  if (hasDir("skills") && underCap()) {
    const skills = await fetchSkillTree(owner, repo, `${pluginPath}/skills`);
    if (!skills) {
      return null;
    }
    items.push(...skills);
  }
  return items.slice(0, MAX_CATALOG_CONTENT_ITEMS);
}

async function fetchNestedSkillTree(
  owner: string,
  repo: string,
  _matchPattern?: string
): Promise<ContentItem[] | null> {
  // Simple two-level walk: <team>/skills/<skill>/SKILL.md
  const top = await fetchGithubJsonResult<GitHubTreeEntry[]>(
    `/repos/${owner}/${repo}/contents`
  );
  if (top.status !== GitHubJsonFetchStatus.Success) {
    return null;
  }
  if (!Array.isArray(top.value)) {
    return null;
  }

  const items: ContentItem[] = [];
  let teamReads = 0;
  for (const teamDir of top.value) {
    // Soft cap to avoid blowing the API budget for huge multi-team repos.
    // Counted on READS as well as items, because a team dir with no `skills`
    // subdirectory costs a call and adds nothing, so an items-only cap never
    // fires on a repo of a thousand empty teams.
    if (
      items.length >= MAX_CATALOG_CONTENT_ITEMS ||
      teamReads >= MAX_CATALOG_CONTENT_ITEMS
    ) {
      break;
    }
    if (teamDir.type !== "dir") {
      continue;
    }
    if (teamDir.name.startsWith(".")) {
      continue;
    }
    teamReads += 1;
    const innerTry = await githubContents<GitHubTreeEntry[]>(
      owner,
      repo,
      `${teamDir.path}/skills`,
      { refusedPath: GitHubJsonFetchStatus.NotFound }
    );
    if (innerTry.status === GitHubJsonFetchStatus.NotFound) {
      continue;
    }
    if (innerTry.status !== GitHubJsonFetchStatus.Success) {
      return null;
    }
    if (!Array.isArray(innerTry.value)) {
      return null;
    }
    for (const skillDir of innerTry.value) {
      if (items.length >= MAX_CATALOG_CONTENT_ITEMS) {
        break;
      }
      if (skillDir.type !== "dir") {
        continue;
      }
      items.push({
        name: skillDir.name,
        type: "skill",
        category: teamDir.name,
        path: skillDir.path,
      });
    }
  }
  return items;
}

// ---------- dispatch ----------

export async function fetchContentsResult(
  entry: CatalogEntry
): Promise<CatalogContentsFetchResult> {
  const contents = entry.contents;
  const type = contents ? readString(contents, "type") : undefined;
  if (!(contents && type)) {
    return catalogContentsSuccess([]);
  }
  const parsed = parseGithubUrl(entry.githubUrl);
  if (!parsed) {
    return catalogContentsUnavailable();
  }
  const { owner, repo } = parsed;

  switch (type) {
    case "github-skill-tree": {
      const skillsPath = readString(contents, "skills_path");
      if (!skillsPath) {
        return catalogContentsUnavailable();
      }
      return catalogContentsResult(
        await fetchSkillTree(
          owner,
          repo,
          skillsPath,
          readString(contents, "skill_marker")
        )
      );
    }
    case "github-multi-skill-tree": {
      const skillPaths = readStringArray(contents, "skill_paths");
      if (skillPaths.length === 0) {
        return catalogContentsUnavailable();
      }
      return catalogContentsResult(
        await fetchMultiSkillTree(
          owner,
          repo,
          skillPaths,
          readString(contents, "skill_marker")
        )
      );
    }
    case "github-flat-md": {
      const mdPath = readString(contents, "md_path");
      if (!mdPath) {
        return catalogContentsUnavailable();
      }
      return catalogContentsResult(
        await fetchFlatMd(owner, repo, mdPath, readKind(contents))
      );
    }
    case "github-nested-md": {
      const rootPath = readString(contents, "root_path");
      if (!rootPath) {
        return catalogContentsUnavailable();
      }
      return catalogContentsResult(
        await fetchNestedMd(owner, repo, rootPath, readKind(contents))
      );
    }
    case "github-nested-skill-tree":
      return catalogContentsResult(
        await fetchNestedSkillTree(
          owner,
          repo,
          readString(contents, "match_pattern")
        )
      );
    case "claude-marketplace": {
      const source = marketplaceSourceRepo(contents, parsed);
      return catalogContentsResult(
        await fetchClaudeMarketplace(
          source.owner,
          source.repo,
          readString(contents, "plugins_root")
        )
      );
    }
    case "github-claude-plugin": {
      const pluginPath = readString(contents, "plugin_path");
      if (!pluginPath) {
        return catalogContentsUnavailable();
      }
      const source = marketplaceSourceRepo(contents, parsed);
      return catalogContentsResult(
        await fetchClaudePlugin(source.owner, source.repo, pluginPath)
      );
    }
    // A pack that ships inside Desktop has no remote tree to list, which is the
    // same empty-and-complete answer as "none" — not an unavailable transport.
    case BUNDLED_LOCAL_CONTENTS_TYPE:
    case "none":
      return catalogContentsSuccess([]);
    default:
      return catalogContentsUnavailable();
  }
}

export async function fetchContents(
  entry: CatalogEntry
): Promise<ContentItem[]> {
  const result = await fetchContentsResult(entry);
  return result.status === CatalogContentsFetchStatus.Success
    ? result.items
    : [];
}

/**
 * Top-level entry. Fetches contents for one catalog entry, applies to the
 * cache table, and returns the items.
 *
 * Honors `SKIP_CATALOG_CONTENTS_FETCH=1` so tests can pin seeded
 * `contents_cache`. Unavailable refreshes leave that cache unchanged.
 */
export async function refreshCatalogContents(
  prisma: DesktopPrisma,
  catalogEntry: CatalogEntry
): Promise<ContentItem[] | null> {
  if (process.env.SKIP_CATALOG_CONTENTS_FETCH === "1") {
    return null;
  }
  const result = await fetchContentsResult(catalogEntry);
  if (result.status === CatalogContentsFetchStatus.Unavailable) {
    gatewayLog.warn(
      "catalog-contents",
      `contents refresh unavailable for ${catalogEntry.packId}; cache left unchanged`
    );
    return null;
  }
  await applyContentsFetch(prisma, {
    pack_id: catalogEntry.packId,
    items: result.items,
  });
  return result.items;
}

/**
 * Which repo a pack's plugin contents are actually scraped from.
 *
 * A pack whose plugin ships inside somebody else's marketplace declares
 * `contents.marketplace_repo`, and that wins over the pack's own `githubUrl` —
 * the seed's `context7` is the live case, with `githubUrl` on `upstash/context7`
 * while the plugin itself lives in `anthropics/claude-plugins-official`. Absent
 * or unparseable, the pack's own repo stands.
 *
 * ISS-8006: `claude-marketplace` and `github-claude-plugin` each carried their
 * own copy of this, so a fix to one silently missed the other. One
 * implementation means the `github-claude-plugin` override test now covers the
 * path both branches take.
 */
function marketplaceSourceRepo(
  contents: Record<string, unknown>,
  fallback: ParsedRepo
): ParsedRepo {
  const marketplaceRepo = readString(contents, "marketplace_repo");
  if (!marketplaceRepo) {
    return fallback;
  }
  return parseGithubUrl(`https://github.com/${marketplaceRepo}`) ?? fallback;
}

function decodeMarketplaceManifest(
  base64Content: string
): { value: unknown } | null {
  try {
    return {
      value: JSON.parse(Buffer.from(base64Content, "base64").toString("utf8")),
    };
  } catch {
    return null;
  }
}

function isUsableContentsPath(path: string): boolean {
  return contentsEndpoint("owner", "repo", path) !== null;
}

function githubContents<T = unknown>(
  owner: string,
  repo: string,
  path: string,
  options: {
    refusedPath?: typeof GitHubJsonFetchStatus.NotFound;
  } = {}
): Promise<GithubContentsResult<T>> {
  const endpoint = contentsEndpoint(owner, repo, path);
  if (!endpoint) {
    return Promise.resolve(
      options.refusedPath === GitHubJsonFetchStatus.NotFound
        ? {
            status: GitHubJsonFetchStatus.NotFound,
            value: null,
            reason: "refused_path",
          }
        : { status: GitHubJsonFetchStatus.Unavailable, value: null }
    );
  }
  return fetchGithubJsonResult<T>(`/${endpoint}`).then((result) =>
    result.status === GitHubJsonFetchStatus.NotFound
      ? { ...result, reason: "not_found" }
      : result
  );
}

function catalogContentsResult(
  items: ContentItem[] | null
): CatalogContentsFetchResult {
  return items ? catalogContentsSuccess(items) : catalogContentsUnavailable();
}

function catalogContentsSuccess(
  items: ContentItem[]
): CatalogContentsFetchResult {
  return { status: CatalogContentsFetchStatus.Success, items };
}

function catalogContentsUnavailable(): CatalogContentsFetchResult {
  return { status: CatalogContentsFetchStatus.Unavailable, items: null };
}
