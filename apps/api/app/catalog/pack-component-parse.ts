/**
 * Shared classification of a Pack's files (canonical Claude Code layout) into
 * agentic components. Reused by both the zip import (`pack-zip-import`) and the
 * repo import (`pack-repo-import`) so the two ingest paths stay identical.
 *
 * Recognized (matched on an ANCESTOR path segment, so any prefix — a root
 * folder, a `.claude/` dir — is handled):
 *   - `agents/<name>.md`            → agent
 *   - `agents/<team>/<name>.md`     → agent named `<team>:<name>` (subdir namespacing)
 *   - `commands/<name>.md`          → command
 *   - `commands/<ns>/<cmd>.md`      → command named `<ns>:<cmd>` (subdir namespacing)
 *   - `skills/<name>/SKILL.md`      → skill (named after its directory)
 *   - `skills/<name>.md`            → skill (flat form)
 *   - `hooks/<name>.json` | `hooks.json` → hook
 *   - `.mcp.json` | `mcp.json`      → one mcp component per server entry
 *
 * Subdirectory namespacing for `commands/` and `agents/` mirrors Claude Code's
 * `/<ns>:<cmd>` convention: the path segments *after* the `commands`/`agents`
 * directory (extension stripped) are colon-joined into the component name, so
 * `commands/git/commit.md` → command `git:commit` and a deeper nest like
 * `commands/a/b/c.md` → `a:b:c`. Files that would otherwise be silently dropped
 * (namespaced under a subdirectory) are now imported.
 */

export type ParsedComponent = {
  kind: "skill" | "command" | "agent" | "hook" | "mcp";
  name: string;
  content: string;
};

const MD_RE = /\.md$/i;
const JSON_RE = /\.json$/i;
const COMPONENT_DIRS = new Set(["agents", "commands", "skills", "hooks"]);

function stripMd(name: string): string {
  return name.replace(MD_RE, "");
}

/**
 * Find the index of the deepest ancestor segment equal to `dir` (case-sensitive,
 * matching the canonical Claude Code layout). "Ancestor" excludes the file's own
 * base segment, so a file literally named `commands` never matches itself.
 * Returns -1 when absent.
 */
function ancestorDirIndex(segs: string[], dir: string): number {
  for (let i = segs.length - 2; i >= 0; i--) {
    if (segs[i] === dir) {
      return i;
    }
  }
  return -1;
}

/**
 * Derive the namespaced component name for a `commands/`/`agents/` file: the
 * segments after the matched directory, extension stripped, colon-joined —
 * mirroring Claude Code's `/<ns>:<cmd>` namespacing. A direct child
 * (`commands/foo.md`) yields the bare `foo`; a subdir (`commands/git/commit.md`)
 * yields `git:commit`.
 */
function namespacedName(segs: string[], dirIndex: number): string {
  return stripMd(segs.slice(dirIndex + 1).join(":"));
}

/** Expand a `.mcp.json` (`{ mcpServers: { name: config } }`) into mcp components. */
function parseMcpJson(text: string): ParsedComponent[] {
  try {
    const parsed = JSON.parse(text) as {
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    const servers = parsed.mcpServers ?? {};
    return Object.entries(servers).map(([name, config]) => ({
      kind: "mcp" as const,
      name,
      content: `${JSON.stringify({ name, ...config }, null, 2)}\n`,
    }));
  } catch {
    return [];
  }
}

/**
 * Cheap path-only pre-filter: could this path be a component? Lets the repo
 * importer fetch blob content only for candidates instead of the whole tree.
 */
export function isComponentCandidatePath(path: string): boolean {
  const segs = path.split("/").filter(Boolean);
  const base = (segs.at(-1) ?? "").toLowerCase();
  const parent = segs.at(-2);
  const grandparent = segs.at(-3);
  if (base === ".mcp.json" || base === "mcp.json" || base === "hooks.json") {
    return true;
  }
  if (grandparent === "skills" && base === "skill.md") {
    return true;
  }
  // JSON is only a component under `hooks/` (→ hook). `.json` elsewhere in a
  // component dir (e.g. `agents/foo.json`) classifies to null, so exclude it
  // here — otherwise it wastes a blob fetch and a slot in the fetch cap.
  if (parent === "hooks" && JSON_RE.test(base)) {
    return true;
  }
  if (parent && COMPONENT_DIRS.has(parent) && MD_RE.test(base)) {
    return true;
  }
  // Namespaced (subdirectory) commands/agents: a `commands/`/`agents/` ancestor
  // anywhere above the `.md` file — `commands/git/commit.md`, `agents/team/x.md`.
  if (
    MD_RE.test(base) &&
    (ancestorDirIndex(segs, "commands") !== -1 ||
      ancestorDirIndex(segs, "agents") !== -1)
  ) {
    return true;
  }
  return false;
}

/** Classify a single file path into component(s), or null if unrecognized. */
export function classifyComponentPath(
  path: string,
  read: () => string
): ParsedComponent[] | null {
  const segs = path.split("/").filter(Boolean);
  if (segs.length === 0) {
    return null;
  }
  const base = segs.at(-1) as string;
  const parent = segs.at(-2);
  const grandparent = segs.at(-3);
  const lower = base.toLowerCase();

  if (lower === "skill.md" && grandparent === "skills" && parent) {
    return [{ kind: "skill", name: parent, content: read() }];
  }
  if (parent === "skills" && MD_RE.test(base)) {
    return [{ kind: "skill", name: stripMd(base), content: read() }];
  }
  // `agents/`/`commands/` as an ANCESTOR (not just the direct parent), so
  // subdirectory-namespaced files (`commands/git/commit.md` → `git:commit`,
  // `agents/team/name.md` → `team:name`) are classified instead of dropped.
  // Claude Code's `/<ns>:<cmd>` namespacing is preserved as a colon-joined name;
  // a direct child still yields the bare name (`commands/foo.md` → `foo`).
  if (MD_RE.test(base)) {
    const agentsIdx = ancestorDirIndex(segs, "agents");
    if (agentsIdx !== -1) {
      return [
        {
          kind: "agent",
          name: namespacedName(segs, agentsIdx),
          content: read(),
        },
      ];
    }
    const commandsIdx = ancestorDirIndex(segs, "commands");
    if (commandsIdx !== -1) {
      return [
        {
          kind: "command",
          name: namespacedName(segs, commandsIdx),
          content: read(),
        },
      ];
    }
  }
  if (lower === ".mcp.json" || lower === "mcp.json") {
    return parseMcpJson(read());
  }
  if (
    (parent === "hooks" && lower.endsWith(".json")) ||
    lower === "hooks.json"
  ) {
    return [{ kind: "hook", name: base.replace(JSON_RE, ""), content: read() }];
  }
  return null;
}

/** Deduplicate by kind + case-insensitive name (first occurrence wins). */
export function dedupeComponents(
  components: ParsedComponent[]
): ParsedComponent[] {
  const seen = new Set<string>();
  const result: ParsedComponent[] = [];
  for (const component of components) {
    const key = `${component.kind}:${component.name.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(component);
  }
  return result;
}
