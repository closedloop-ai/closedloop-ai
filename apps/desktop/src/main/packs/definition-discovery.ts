/**
 * @file definition-discovery.ts — the PURE FILESYSTEM half of the definition
 * content pipeline (ISS-5274), moved out of `definition-content-collector.ts`.
 *
 * Why it lives on its own: the walk it performs — `findSkillFiles` over every
 * recent project root, 6 levels deep, through the SYNCHRONOUS `readdirSync` —
 * used to run inside the `packScanner.apply` db-host store op, where it blocked
 * the db-host's single JS thread and starved renderer DB reads. FEA-3628 had
 * already moved the pack scan's own walk into a main-process compute worker;
 * this module is what lets the definition walk follow it. Everything here is
 * filesystem + parsing only, with NO database import, so it can be loaded in a
 * worker that owns no DB connection.
 *
 * The apply half — the `agent_components` upserts, the `observedIds` set and the
 * access-state reconciliation — stays in `definition-content-collector.ts` and
 * still runs on the db-host, which remains the sole SQLite writer.
 *
 * ROOT OWNERSHIP (ISS-5274): the DB HOST resolves the scan roots and the scope
 * context and ships them to the worker; nothing here is called with the worker's
 * own environment. `resolveDefaultDefinitionScanRoots` and
 * `deriveDefinitionApplyContext` DO read `CLAUDE_HOME` / `CODEX_HOME` / the
 * OpenCode config home / `os.homedir()`, so they must be invoked on the db-host
 * (via the `packScanner.definitionRoots` store op) and their results passed
 * across — never re-derived on the far side, where a different environment would
 * silently change the scanned set and, through `homeDir`, the derived
 * `agent_components.scope`.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Harness } from "@repo/api/src/types/agent-component";
import { normalizeCommandComponentKey } from "@repo/lib/sessions/command-user-turn-id";
import { isImportableSourcePath } from "../collectors/engine/source-admission.js";
import { getOpenCodeConfigHome } from "../collectors/opencode/opencode-home.js";
import { resolveClaudeHome, resolveCodexHome } from "./claude-home.js";
import {
  type DefinitionVariants,
  foldDiscovered,
} from "./definition-variant-fold.js";
import {
  findSkillFiles,
  parseSkillFrontmatter,
  safeReadFile,
} from "./pack-scanner.js";

/**
 * A scan root, optionally tagged with the project root it belongs to and the
 * harness whose home it is. A plain string is shorthand for `{ dir }` (no owning
 * project → project-scope is derived from the path shape alone; no harness →
 * definitions under it stay unattributed). The `projectPath` is threaded into
 * `deriveComponentScope` so a definition under `<projectPath>/…` is scoped
 * "project" even when its path doesn't literally contain a `.claude/` segment.
 *
 * `harness` (FEA-4028) attributes by the ROOT the caller is scanning, not by a
 * literal path segment: the caller already knows it is walking the resolved
 * Claude home vs the resolved Codex home (`resolveClaudeHome()` /
 * `resolveCodexHome()`), so a relocated `CODEX_HOME` with no literal `.codex`
 * segment (codex review) is still attributed `codex`. A harness-agnostic root
 * (e.g. `.agents/skills`) omits it and its definitions stay unattributed —
 * never guessed. Only the display-contract harnesses (`claude`/`codex`) are
 * ever passed; the value is folded to `both` at collection time when the SAME
 * identity is discovered under roots of differing harnesses.
 */
export type DefinitionScanRoot =
  | string
  | {
      dir: string;
      projectPath?: string;
      harness?: Harness;
      /**
       * Candidate definition-subdir names to scan under this root, in
       * precedence order (first match wins the per-identity dedup). Lets a
       * single `discoverClaudeDir` pass mix roots that spell the dir
       * differently — Claude's `agents/`/`commands/` and OpenCode's plural
       * defaults with singular `agent/`/`command/` aliases (ISS-4386) — so a
       * subagent/command identity present under BOTH a Claude and an OpenCode
       * root folds to a single `Harness.Both` row instead of double-upserting
       * (P1/P2 review). Omitted ⇒ the caller's default `subdirs` are used.
       */
      subdirs?: readonly string[];
    };

/** Injectable scan roots — production passes real dirs; tests pass a tmpdir. */
export type DefinitionCollectorRoots = {
  /** Roots searched recursively for `SKILL.md` skill definitions. */
  skillRoots?: readonly DefinitionScanRoot[];
  /**
   * Resolved `.claude` directories whose `agents/*.md` (sub-agents) and
   * `commands/*.md` (slash commands) are read one level deep. Each entry is the
   * `.claude` dir itself (e.g. `resolveClaudeHome()`, honoring `CLAUDE_HOME`, or
   * `<projectRoot>/.claude`) — the collector does NOT re-append `.claude`.
   */
  claudeRoots?: readonly DefinitionScanRoot[];
  /**
   * OpenCode config-home directories whose `agents/`+`commands/` (with singular
   * `agent/`+`command/` backwards-compat aliases) are read one level deep and
   * discovered as `subagent`/`command` components attributed `harness=opencode`
   * (ISS-4386). Each entry is the OpenCode config home itself (e.g.
   * `getOpenCodeConfigHome()` or a project's `.opencode`) — the collector does
   * NOT re-append `opencode`. Kept SEPARATE from `claudeRoots` because OpenCode's
   * layout (plural default dir names, its own config home) differs from Claude's
   * `.claude/` and it is a distinct harness.
   */
  openCodeRoots?: readonly DefinitionScanRoot[];
  /**
   * User home directory used to distinguish `<home>/.claude/` (user scope) from
   * a project's `.claude/` (project scope). Defaults to `os.homedir()`;
   * overridable so tests can point it at a tmpdir.
   */
  homeDir?: string;
};

/**
 * Just the roots to walk — the half of {@link DefinitionCollectorRoots} that
 * crosses to the compute worker (ISS-5274). `homeDir` is excluded because it is
 * a scope-derivation input for the APPLY half, which never leaves the db-host.
 */
export type DefinitionScanRoots = Omit<DefinitionCollectorRoots, "homeDir">;

/**
 * The scope inputs `upsertDefinition` needs alongside the discovered
 * definitions. Derived from the SAME roots the walk used, and carried across the
 * process boundary with them: dropping `userScopeRoots` persists `scope = null`
 * for every OpenCode user-global definition (the ISS-4386 regression), and
 * dropping `homeDir` breaks the `<home>/.claude` user-vs-project split.
 */
export type DefinitionApplyContext = {
  homeDir: string;
  userScopeRoots: string[];
};

const LEADING_DOT_MD = /\.md$/i;

// Claude keeps one canonical subdir per definition kind under `.claude/`.
const CLAUDE_SUBAGENT_SUBDIRS = ["agents"] as const;
const CLAUDE_COMMAND_SUBDIRS = ["commands"] as const;
// OpenCode (ISS-4386) defaults to the PLURAL dir names under its config home and
// keeps the SINGULAR forms as backwards-compat aliases; both are scanned so a
// definition under either is discovered. Plural first (the current default) so
// it wins the per-identity dedup on the rare install that has both.
const OPENCODE_AGENT_SUBDIRS = ["agents", "agent"] as const;
const OPENCODE_COMMAND_SUBDIRS = ["commands", "command"] as const;

export function normalizeScanRoot(root: DefinitionScanRoot): {
  dir: string;
  projectPath?: string;
  harness?: Harness;
  subdirs?: readonly string[];
} {
  return typeof root === "string" ? { dir: root } : root;
}

function listMarkdownFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && LEADING_DOT_MD.test(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Contained, no-follow definition read (T13): a repo can check in
 * `.opencode/agents` (or `.claude/agents`) as a symlink pointing OUTSIDE the
 * project. A plain `readdirSync`+`readFileSync` would follow it and ingest
 * arbitrary Markdown into `agent_components.content` (which is desktop-synced).
 *
 *  - `O_NOFOLLOW` refuses to open a symlink at the final path component.
 *  - `fstat` before/after the read pins the bytes to one stable `(dev, ino)`.
 *  - The containment re-check runs AFTER the read and requires the path to still
 *    name that same `(dev, ino)`. A mid-flight retarget therefore fails either
 *    containment or identity — it can no longer be captured. (A hardlink of an
 *    out-of-root file INTO the root stays indistinguishable from an in-root
 *    file at every layer, and is equivalent to pasting the bytes in.)
 */
export function readContainedDefinition(
  candidatePath: string,
  rootDir: string
): { content: string; stat: Stats } | null {
  // Pre-check so the common out-of-root case is rejected without opening the
  // file at all; the post-read check below is the authoritative one.
  if (!isImportableSourcePath(candidatePath, [rootDir])) {
    return null;
  }
  let fd: number | null = null;
  try {
    // biome-ignore lint/suspicious/noBitwiseOperators: file open flags require bitwise OR
    const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
    fd = openSync(candidatePath, flags);
    const before = fstatSync(fd);
    if (!before.isFile()) {
      return null;
    }
    const content = readFileSync(fd, "utf8");
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      return null;
    }
    const resolved = statSync(candidatePath);
    if (
      !isImportableSourcePath(candidatePath, [rootDir]) ||
      resolved.dev !== after.dev ||
      resolved.ino !== after.ino
    ) {
      return null;
    }
    return { content, stat: after };
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

function discoverSkills(
  roots: readonly DefinitionScanRoot[]
): DefinitionVariants[] {
  const byId = new Map<string, DefinitionVariants>();
  for (const rawRoot of roots) {
    const { dir, projectPath, harness } = normalizeScanRoot(rawRoot);
    for (const file of findSkillFiles(dir)) {
      const content = safeReadFile(file);
      if (content === null) {
        continue;
      }
      const meta = parseSkillFrontmatter(content) ?? {};
      const name = meta.name || path.basename(path.dirname(file));
      if (!name) {
        continue;
      }
      foldDiscovered(byId, {
        kind: "skill",
        externalId: name,
        name,
        installPath: file,
        content,
        projectPath,
        harness: harness ?? null,
      });
    }
  }
  return [...byId.values()];
}

/**
 * Attach the given candidate `subdirs` to a scan root so it can be scanned in
 * the same `discoverClaudeDir` pass as roots that use a different subdir
 * spelling. String roots are widened to the object form; an explicit
 * per-root `subdirs` already present is preserved.
 */
function withSubdirs(
  root: DefinitionScanRoot,
  subdirs: readonly string[]
): DefinitionScanRoot {
  const normalized = normalizeScanRoot(root);
  return { ...normalized, subdirs: normalized.subdirs ?? subdirs };
}

/**
 * Discover `subagent`/`command` markdown one level under each root's
 * definition subdir. `subdirs` is a candidate LIST (checked in order) so a
 * harness that spells the dir differently — OpenCode uses plural `agents/` /
 * `commands/` with singular `agent/` / `command/` as a backwards-compat alias
 * (ISS-4386) — is covered; Claude passes a single-element list. The FIRST root
 * to yield a given identity wins the row (per-identity dedup), matching the
 * skill-discovery fold.
 */
function discoverClaudeDir(
  claudeDirs: readonly DefinitionScanRoot[],
  subdirs: readonly string[],
  kind: "subagent" | "command"
): DefinitionVariants[] {
  const byId = new Map<string, DefinitionVariants>();
  for (const rawRoot of claudeDirs) {
    const {
      dir: claudeDir,
      projectPath,
      harness,
      subdirs: rootSubdirs,
    } = normalizeScanRoot(rawRoot);
    const files = (rootSubdirs ?? subdirs).flatMap((subdir) =>
      listMarkdownFiles(path.join(claudeDir, subdir))
    );
    for (const file of files) {
      const read = readContainedDefinition(file, claudeDir);
      if (read === null) {
        continue;
      }
      const content = read.content;
      const meta = parseSkillFrontmatter(content) ?? {};
      const baseName =
        meta.name || path.basename(file).replace(LEADING_DOT_MD, "");
      if (!baseName) {
        continue;
      }
      // Commands are keyed `/<name>` to match the event-driven component_key.
      // ISS-4795: via the SHARED normalizer, never `/${baseName}` — a
      // slash-command's frontmatter `name` already carries the leading slash,
      // so hand-prepending one minted `//build` here while the invocation path
      // minted `/build`, splitting one command into two components.
      const externalId =
        kind === "command" ? normalizeCommandComponentKey(baseName) : baseName;
      foldDiscovered(byId, {
        kind,
        externalId,
        name: kind === "command" ? externalId : baseName,
        installPath: file,
        content,
        projectPath,
        harness: harness ?? null,
      });
    }
  }
  return [...byId.values()];
}

/**
 * Walk the given roots and return every discovered definition, folded per
 * identity. Pure filesystem — no DB access, so this is what runs in the
 * pack-scan compute worker.
 */
export function discoverDefinitions(
  roots: DefinitionCollectorRoots
): DefinitionVariants[] {
  const skillRoots = roots.skillRoots ?? [];
  const claudeRoots = roots.claudeRoots ?? [];
  const openCodeRoots = roots.openCodeRoots ?? [];
  // OpenCode agents/commands live under its config home in plural (`agents/`,
  // `commands/`) dirs, with the singular forms as backwards-compat aliases
  // (ISS-4386). Attributed `harness=opencode` by the scan root. Each OpenCode
  // root carries its own `subdirs` so the Claude and OpenCode roots for a kind
  // can share ONE `discoverClaudeDir` pass — the per-identity dedup then folds a
  // subagent/command present under both a `.claude` and an OpenCode home into a
  // single `Harness.Both` row via `foldDiscovered`, instead of the two separate
  // passes each upserting and OpenCode silently clobbering the Claude row
  // (P1/P2 review).
  const openCodeSubagentRoots = openCodeRoots.map((root) =>
    withSubdirs(root, OPENCODE_AGENT_SUBDIRS)
  );
  const openCodeCommandRoots = openCodeRoots.map((root) =>
    withSubdirs(root, OPENCODE_COMMAND_SUBDIRS)
  );
  return [
    ...discoverSkills(skillRoots),
    ...discoverClaudeDir(
      [...claudeRoots, ...openCodeSubagentRoots],
      CLAUDE_SUBAGENT_SUBDIRS,
      "subagent"
    ),
    ...discoverClaudeDir(
      [...claudeRoots, ...openCodeCommandRoots],
      CLAUDE_COMMAND_SUBDIRS,
      "command"
    ),
  ];
}

/**
 * Resolve the standard production scan roots (`~/.claude`, `~/.codex`, the
 * OpenCode config home, and recently-active project directories).
 *
 * MUST run on the db-host (see the root-ownership note at the top of this file):
 * it reads `CLAUDE_HOME` / `CODEX_HOME` / the OpenCode config home from the
 * environment, so resolving it in a second process could silently scan a
 * different set.
 */
export function resolveDefaultDefinitionScanRoots(
  projectRoots: readonly string[]
): DefinitionCollectorRoots {
  return {
    // Home skill roots carry no projectPath (their scope is derived from the
    // `<home>/.claude` shape) but ARE harness-tagged by the home they resolve to
    // — this is what attributes a Codex-home skill to `codex` even when
    // `$CODEX_HOME` is relocated to a directory with no literal `.codex` segment
    // (codex review, FEA-4028). Project `.claude/skills` roots stay untagged:
    // a project tree can hold either harness's definitions, so its harness is
    // not guessed here (a real usage/session harness attributes those instead).
    skillRoots: [
      {
        dir: path.join(resolveClaudeHome(), "skills"),
        harness: Harness.Claude,
      },
      { dir: path.join(resolveCodexHome(), "skills"), harness: Harness.Codex },
      ...projectRoots.map((root) => ({ dir: root, projectPath: root })),
    ],
    // The `.claude` directories to scan for `agents/` + `commands/`: the user's
    // resolved Claude home (honoring `$CLAUDE_HOME`) and each active project's
    // own `<root>/.claude`. The user home is a Claude home → `claude`; project
    // `.claude` dirs stay untagged for the same "don't guess" reason as above.
    claudeRoots: [
      { dir: resolveClaudeHome(), harness: Harness.Claude },
      ...projectRoots.map((root) => ({
        dir: path.join(root, ".claude"),
        projectPath: root,
      })),
    ],
    // OpenCode's config home (`~/.config/opencode`, honoring `$OPENCODE_CONFIG` /
    // `$XDG_CONFIG_HOME`) plus each active project's own `<root>/.opencode`
    // (ISS-4386). Both are tagged `opencode`: unlike a project `.claude`
    // directory — which the "don't guess" rule leaves untagged because a project
    // tree can legitimately hold either harness's definitions — a `.opencode`
    // directory is an OpenCode-specific literal, so its definitions are
    // unambiguously OpenCode's. Leaving it untagged stored NULL, which both read
    // paths coerce to Claude (wongk, T14).
    openCodeRoots: [
      { dir: getOpenCodeConfigHome(), harness: Harness.Opencode },
      ...projectRoots.map((root) => ({
        dir: path.join(root, ".opencode"),
        projectPath: root,
        harness: Harness.Opencode,
      })),
    ],
  };
}

/**
 * Derive the scope inputs `upsertDefinition` needs from the same roots the walk
 * used. Runs on the db-host beside `resolveDefaultDefinitionScanRoots`.
 *
 * `userScopeRoots` (ISS-4386, shafty023): OpenCode config HOMES (roots WITHOUT a
 * `projectPath`) hold user-global definitions that don't live under
 * `<home>/.claude/`, so a definition there is `ComponentScope.User`. Project
 * `.opencode` roots (WITH a `projectPath`) are excluded — those stay
 * project-scoped via the `projectPath` branch.
 */
export function deriveDefinitionApplyContext(
  roots: DefinitionCollectorRoots
): DefinitionApplyContext {
  return {
    homeDir: roots.homeDir ?? os.homedir(),
    userScopeRoots: (roots.openCodeRoots ?? [])
      .map((root) => normalizeScanRoot(root))
      .filter((root) => !root.projectPath)
      .map((root) => root.dir),
  };
}

/**
 * Everything the definition pass needs, resolved in ONE place on the db-host:
 * the roots the walk consumes and the scope context the apply consumes.
 */
export type DefinitionRootsResolution = {
  scanRoots: DefinitionCollectorRoots;
  context: DefinitionApplyContext;
};

/**
 * Resolve the roots and the scope context together (ISS-5274) — the body of the
 * `packScanner.definitionRoots` store op.
 *
 * They are produced by ONE call so the two halves cannot be resolved from
 * different environments or different project-root reads: the context is
 * derived from the very roots that are about to be walked, and both travel to
 * the worker path as a pair.
 */
export function resolveDefinitionRoots(
  projectRoots: readonly string[]
): DefinitionRootsResolution {
  const scanRoots = resolveDefaultDefinitionScanRoots(projectRoots);
  return { scanRoots, context: deriveDefinitionApplyContext(scanRoots) };
}
