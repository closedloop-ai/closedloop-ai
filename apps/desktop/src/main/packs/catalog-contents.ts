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
 *   - none                      — pack has no skill/command listing (RTK, claude-code-router)
 *
 * Returns [{ name, type, description?, path? }]. type is one of
 * 'skill', 'command', 'agent', 'plugin'.
 */

import { execFileSync } from "node:child_process";
import https from "node:https";
import { resolveBinaryFromLoginShellSync } from "../../server/shell-path.js";
import type { DesktopPrisma } from "../database/prisma-client.js";

import { applyContentsFetch } from "./catalog-store.js";

const REQUEST_TIMEOUT_MS = 8000;

// ---------- types ----------

type ParsedRepo = {
  owner: string;
  repo: string;
};

export type ContentItemKind = "skill" | "command" | "agent" | "plugin";

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

type ContentsType =
  | "github-skill-tree"
  | "github-multi-skill-tree"
  | "github-flat-md"
  | "github-nested-md"
  | "github-nested-skill-tree"
  | "claude-marketplace"
  | "github-claude-plugin"
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

type GitHubTreeEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
  content?: string;
};

type MarketplaceManifest = {
  plugins?: Array<{ name: string; description?: string }>;
};

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

function parseGithubUrl(url: string | null | undefined): ParsedRepo | null {
  const m = String(url || "").match(/github\.com[/:]([^/]+)\/([^/?#.]+)/);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, "") } : null;
}

function ghCliAvailable(): boolean {
  const result = resolveBinaryFromLoginShellSync("gh");
  return result.source !== "fallback" && result.source !== "override_invalid";
}

function ghApi<T = unknown>(endpoint: string): T | null {
  try {
    const out = execFileSync(
      "gh",
      ["api", endpoint, "--header", "Accept: application/vnd.github+json"],
      { timeout: REQUEST_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }
    );
    return JSON.parse(out.toString("utf8")) as T;
  } catch {
    return null;
  }
}

function restApi<T = unknown>(endpoint: string): Promise<T | null> {
  return new Promise((resolve) => {
    const urlPath = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
    const req = https.get(
      {
        host: "api.github.com",
        path: urlPath,
        headers: {
          "User-Agent": "closedloop-electron-agent-monitor",
          Accept: "application/vnd.github+json",
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        if (res.statusCode !== 200) {
          resolve(null);
          res.resume();
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function gh<T = unknown>(endpoint: string): Promise<T | null> {
  if (ghCliAvailable()) {
    const data = ghApi<T>(endpoint);
    if (data) {
      return data;
    }
  }
  return restApi<T>(endpoint);
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
  marker?: string
): Promise<ContentItem[]> {
  const skillMarker = marker || "SKILL.md";
  const items = await gh<GitHubTreeEntry[]>(
    `repos/${owner}/${repo}/contents/${encodeURI(skillsPath)}`
  );
  if (!Array.isArray(items)) {
    return [];
  }

  const skills: ContentItem[] = [];
  for (const entry of items) {
    if (entry.type !== "dir") {
      continue;
    }
    // Fetch the marker file's frontmatter (one extra API call per skill).
    const file = await gh<GitHubTreeEntry>(
      `repos/${owner}/${repo}/contents/${encodeURI(entry.path)}/${skillMarker}`
    );
    if (!file?.content) {
      skills.push({ name: entry.name, type: "skill", path: entry.path });
      continue;
    }
    const meta = parseSkillFrontmatterFromBase64(file.content);
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
): Promise<ContentItem[]> {
  const items = await gh<GitHubTreeEntry[]>(
    `repos/${owner}/${repo}/contents/${encodeURI(mdPath)}`
  );
  if (!Array.isArray(items)) {
    return [];
  }
  return items
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
): Promise<ContentItem[]> {
  const top = await gh<GitHubTreeEntry[]>(
    `repos/${owner}/${repo}/contents/${encodeURI(rootPath)}`
  );
  if (!Array.isArray(top)) {
    return [];
  }

  const items: ContentItem[] = [];
  for (const cat of top) {
    if (cat.type !== "dir") {
      continue;
    }
    const inner = await gh<GitHubTreeEntry[]>(
      `repos/${owner}/${repo}/contents/${encodeURI(cat.path)}`
    );
    if (!Array.isArray(inner)) {
      continue;
    }
    for (const file of inner) {
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
): Promise<ContentItem[]> {
  const out: ContentItem[] = [];
  for (const p of paths || []) {
    out.push(...(await fetchSkillTree(owner, repo, p, marker)));
  }
  return out;
}

async function fetchClaudeMarketplace(
  owner: string,
  repo: string,
  pluginsRoot?: string
): Promise<ContentItem[]> {
  // Read .claude-plugin/marketplace.json for the canonical list.
  const meta = await gh<GitHubTreeEntry>(
    `repos/${owner}/${repo}/contents/.claude-plugin/marketplace.json`
  );
  if (meta?.content) {
    try {
      const parsed = JSON.parse(
        Buffer.from(meta.content, "base64").toString("utf8")
      ) as MarketplaceManifest;
      if (Array.isArray(parsed.plugins)) {
        const items: ContentItem[] = parsed.plugins.map((p) => ({
          name: p.name,
          type: "plugin" as const,
          description: p.description || null,
        }));
        // If a plugins_root is declared, walk each plugin's skills/ dir for a
        // richer breakdown. Best-effort; bail if API budget is exhausted.
        if (pluginsRoot) {
          for (const item of items) {
            try {
              const skills = await fetchSkillTree(
                owner,
                repo,
                `${pluginsRoot}/${item.name}/skills`
              );
              item.skill_count = skills.length;
              item.skills = skills.map((s) => s.name);
            } catch {
              /* per-plugin scrape best-effort */
            }
          }
        }
        return items;
      }
    } catch {
      /* malformed marketplace.json — fall through */
    }
  }
  return [];
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
): Promise<ContentItem[]> {
  const items: ContentItem[] = [];
  const top = await gh<GitHubTreeEntry[]>(
    `repos/${owner}/${repo}/contents/${encodeURI(pluginPath)}`
  );
  if (!Array.isArray(top)) {
    return items;
  }
  const hasDir = (name: string): boolean =>
    top.some((e) => e.type === "dir" && e.name === name);

  // commands/<name>.md
  if (hasDir("commands")) {
    items.push(
      ...(await fetchFlatMd(owner, repo, `${pluginPath}/commands`, "command"))
    );
  }
  // agents/<name>.md
  if (hasDir("agents")) {
    items.push(
      ...(await fetchFlatMd(owner, repo, `${pluginPath}/agents`, "agent"))
    );
  }
  // skills/<name>/SKILL.md
  if (hasDir("skills")) {
    items.push(...(await fetchSkillTree(owner, repo, `${pluginPath}/skills`)));
  }
  return items;
}

async function fetchNestedSkillTree(
  owner: string,
  repo: string,
  _matchPattern?: string
): Promise<ContentItem[]> {
  // Simple two-level walk: <team>/skills/<skill>/SKILL.md
  const top = await gh<GitHubTreeEntry[]>(`repos/${owner}/${repo}/contents`);
  if (!Array.isArray(top)) {
    return [];
  }

  const items: ContentItem[] = [];
  for (const teamDir of top) {
    if (teamDir.type !== "dir") {
      continue;
    }
    if (teamDir.name.startsWith(".")) {
      continue;
    }
    const teamSkillsPath = `${teamDir.path}/skills`;
    const innerTry = await gh<GitHubTreeEntry[]>(
      `repos/${owner}/${repo}/contents/${encodeURI(teamSkillsPath)}`
    );
    if (!Array.isArray(innerTry)) {
      continue;
    }
    for (const skillDir of innerTry) {
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
    // Soft cap to avoid blowing the API budget for huge multi-team repos.
    if (items.length >= 100) {
      break;
    }
  }
  return items;
}

// ---------- dispatch ----------

export async function fetchContents(
  entry: CatalogEntry
): Promise<ContentItem[]> {
  const contents = entry.contents;
  const type = contents ? readString(contents, "type") : undefined;
  if (!(contents && type)) {
    return [];
  }
  const parsed = parseGithubUrl(entry.githubUrl);
  if (!parsed) {
    return [];
  }
  const { owner, repo } = parsed;

  switch (type) {
    case "github-skill-tree": {
      const skillsPath = readString(contents, "skills_path");
      if (!skillsPath) {
        return [];
      }
      return fetchSkillTree(
        owner,
        repo,
        skillsPath,
        readString(contents, "skill_marker")
      );
    }
    case "github-multi-skill-tree": {
      const skillPaths = readStringArray(contents, "skill_paths");
      if (skillPaths.length === 0) {
        return [];
      }
      return fetchMultiSkillTree(
        owner,
        repo,
        skillPaths,
        readString(contents, "skill_marker")
      );
    }
    case "github-flat-md": {
      const mdPath = readString(contents, "md_path");
      if (!mdPath) {
        return [];
      }
      return fetchFlatMd(owner, repo, mdPath, readKind(contents));
    }
    case "github-nested-md": {
      const rootPath = readString(contents, "root_path");
      if (!rootPath) {
        return [];
      }
      return fetchNestedMd(owner, repo, rootPath, readKind(contents));
    }
    case "github-nested-skill-tree":
      return fetchNestedSkillTree(
        owner,
        repo,
        readString(contents, "match_pattern")
      );
    case "claude-marketplace": {
      const marketplaceRepo = readString(contents, "marketplace_repo");
      const repoFromContents = marketplaceRepo
        ? parseGithubUrl(`https://github.com/${marketplaceRepo}`)
        : null;
      const mkO = repoFromContents ? repoFromContents.owner : owner;
      const mkR = repoFromContents ? repoFromContents.repo : repo;
      return fetchClaudeMarketplace(
        mkO,
        mkR,
        readString(contents, "plugins_root")
      );
    }
    case "github-claude-plugin": {
      const marketplaceRepo = readString(contents, "marketplace_repo");
      const repoFromContents = marketplaceRepo
        ? parseGithubUrl(`https://github.com/${marketplaceRepo}`)
        : null;
      const pluginO = repoFromContents ? repoFromContents.owner : owner;
      const pluginR = repoFromContents ? repoFromContents.repo : repo;
      const pluginPath = readString(contents, "plugin_path");
      if (!pluginPath) {
        return [];
      }
      return fetchClaudePlugin(pluginO, pluginR, pluginPath);
    }
    case "none":
      return [];
    default:
      return [];
  }
}

/**
 * Top-level entry. Fetches contents for one catalog entry, applies to the
 * cache table, and returns the items.
 */
export async function refreshCatalogContents(
  prisma: DesktopPrisma,
  catalogEntry: CatalogEntry
): Promise<ContentItem[]> {
  const items = await fetchContents(catalogEntry);
  await applyContentsFetch(prisma, { pack_id: catalogEntry.packId, items });
  return items;
}
