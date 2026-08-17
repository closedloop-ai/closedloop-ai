/**
 * Definition-content collector (FEA-2923 content pipeline — producer).
 *
 * The event-driven inventory (`upsertEventDrivenComponents` in write-core) rows
 * agent components from *usage* — it never reads a file, so `content` /
 * `content_hash` stay null and the detail Prompt panel is empty. This collector
 * closes that gap: it walks the local filesystem for the prompt-bearing
 * definition kinds (skills, sub-agents, commands), reads each file, computes its
 * sha256, and upserts `content` + `content_hash` into `agent_components`.
 *
 * Identity contract (critical): every kind is keyed by `external_id = <the same
 * component_key the event-driven path uses>` — skill name, sub-agent name, and
 * `/<command>` — so the `ON CONFLICT (component_kind, external_id)` UPSERT
 * attaches content to the existing usage row instead of creating a duplicate.
 * When no usage row exists yet, it CREATES the row (deterministic id identical
 * to what the event path would compute), so a freshly-authored definition is
 * discoverable — with its prompt — before its first invocation.
 *
 * Content is stored untruncated locally; the sync loader caps the *transmitted*
 * body while keeping the full-file `content_hash` for true-identity dedup.
 *
 * The per-identity VARIANT FOLD (which discovery wins the display row, which
 * distinct-content bodies are retained) and the `agent_component_versions`
 * append live in the sibling `./definition-variant-fold.js` (ISS-4662); this
 * module owns discovery and the `agent_components` display row and drives it.
 */

import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import {
  type HarnessImportMode,
  HarnessImportMode as HarnessImportModeValue,
  type NormalizedDefinitionKind,
  type NormalizedInvocationDefinitionEvidence,
  type NormalizedSession,
} from "@repo/lib/harness/types";
import {
  commandUserTurnId,
  normalizeCommandComponentKey,
} from "@repo/lib/sessions/command-user-turn-id";
import { gatewayLog } from "../logging/gateway-logger.js";
import { resolveClaudeHome, resolveCodexHome } from "./claude-home.js";
import {
  type DefinitionApplyContext,
  type DefinitionCollectorRoots,
  deriveDefinitionApplyContext,
  discoverDefinitions,
  normalizeScanRoot,
  readContainedDefinition,
  resolveDefaultDefinitionScanRoots,
} from "./definition-discovery.js";
import {
  type DefinitionVariants,
  type DiscoveredDefinition,
  sha256Hex,
  upsertDefinitionVersion,
} from "./definition-variant-fold.js";
import {
  getRecentProjectRoots,
  type PackScannerDb,
  parseSkillFrontmatter,
} from "./pack-scanner.js";

export type DefinitionCollectorSummary = {
  upserted: number;
  skipped: number;
};

type FocusedInvocation = {
  invocationId: string;
  kind: NormalizedDefinitionKind;
  rawName: string;
  normalizedName: string;
  invokedAt: string;
};

export type InvocationDefinitionCaptureOptions = {
  importMode: HarnessImportMode;
  roots?: DefinitionCollectorRoots;
  /** Injectable wall clock; production captures after each stable file read. */
  now?: () => Date;
};

const LEADING_SLASH = /^\//;

/** Mirror of write-core's `deterministicComponentId` so ids line up on insert. */
function deterministicComponentId(kind: string, externalId: string): string {
  return createHash("sha256")
    .update(`${kind}|${externalId}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Where a Claude Code component is installed, per Claude Code's scoping
 * convention. Const-object enum (repo convention) — the string values are the
 * exact tokens stored in `agent_components.scope` and shipped to the cloud
 * inventory, so they must not drift.
 */
export const ComponentScope = {
  /** A user-global definition under `<home>/.claude/` (not a plugin). */
  User: "user",
  /** A project-local definition under `<project>/.claude/`. */
  Project: "project",
  /** A definition vendored by a Claude Code plugin (`…/.claude/plugins/…`). */
  Plugin: "plugin",
} as const;
export type ComponentScope =
  (typeof ComponentScope)[keyof typeof ComponentScope];

// `/.claude/plugins/` anywhere in the path marks a plugin-vendored definition.
const CLAUDE_PLUGINS_SEGMENT = `${path.sep}.claude${path.sep}plugins${path.sep}`;
// A `.claude/` directory boundary anywhere in the path.
const CLAUDE_DIR_SEGMENT = `${path.sep}.claude${path.sep}`;

/** True when `child` is `parent` itself or nested beneath it. */
function isUnder(child: string, parent: string): boolean {
  if (!parent) {
    return false;
  }
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child === parent || child.startsWith(withSep);
}

/**
 * Derive a component's `scope` from where its definition file lives, following
 * Claude Code's scoping convention. Pure — no filesystem or env access; all
 * inputs are passed in so it is trivially testable.
 *
 * Precedence (checked in order):
 *  1. `…/.claude/plugins/…`            → "plugin" (checked first: a plugin can
 *                                        live under home OR a project)
 *  2. under `<homeDir>/.claude/`, or
 *     under any `userScopeRoots` entry
 *     (e.g. the OpenCode config home)  → "user"
 *  3. under `projectPath`, or any other
 *     `.claude/` dir not under home    → "project"
 *  4. otherwise                        → null (unknown — never guessed)
 *
 * A missing `installPath` (invocation-derived rows) yields null: those rows have
 * no local file and correctly carry no scope.
 *
 * `userScopeRoots` (ISS-4386, shafty023) makes scope derivation root-aware for
 * harnesses whose user-global definitions do NOT live under `<home>/.claude/`:
 * OpenCode's user config home is `~/.config/opencode`, which none of the
 * `.claude`-shaped branches recognize, so without this a user-global OpenCode
 * agent persisted with `scope = null` (losing user provenance in sync and
 * showing the raw install path instead of "user"). A definition under one of
 * these roots is user-scoped — unless it is also under a more-specific
 * `projectPath` (a project `.opencode`), which still wins via branch 3.
 */
export function deriveComponentScope(
  installPath: string | null | undefined,
  projectPath: string | null | undefined,
  homeDir: string | null | undefined,
  userScopeRoots: readonly string[] = []
): ComponentScope | null {
  if (!installPath) {
    return null;
  }
  const p = path.normalize(installPath);

  // 1. Plugin-vendored definitions win regardless of home/project location.
  if (p.includes(CLAUDE_PLUGINS_SEGMENT)) {
    return ComponentScope.Plugin;
  }

  // 2a. A project root is the most specific signal — a definition under an
  //     explicit `projectPath` is project-scoped even when that project sits
  //     inside a user-scope root (an unusual layout, but the project wins).
  if (projectPath && isUnder(p, path.normalize(projectPath))) {
    return ComponentScope.Project;
  }

  // 2b. User-global: under the resolved `<home>/.claude/` or any harness user
  //     config home passed in (e.g. `~/.config/opencode`).
  if (homeDir) {
    const claudeHome = path.join(path.normalize(homeDir), ".claude");
    if (isUnder(p, claudeHome)) {
      return ComponentScope.User;
    }
  }
  for (const root of userScopeRoots) {
    if (root && isUnder(p, path.normalize(root))) {
      return ComponentScope.User;
    }
  }

  // 3. Project-local: any other `.claude/` directory that is not the user's
  //    home (a project's `.claude`).
  if (p.includes(CLAUDE_DIR_SEGMENT)) {
    return ComponentScope.Project;
  }

  // 4. Unknown — do not guess.
  return null;
}

/**
 * Capture exact definitions only for markdown identities invoked by this
 * normalized session. This is intentionally not an inventory scan: candidate
 * paths are derived from the invoked key, and no unrelated definition body is
 * read. The caller must identify the original live-watcher pass explicitly;
 * historical, boot, catch-up, and DATA_REVISION paths return before filesystem
 * access and can never turn a later current file into historical evidence.
 */
export function captureInvocationDefinitionEvidence(
  session: NormalizedSession,
  options: InvocationDefinitionCaptureOptions
): NormalizedInvocationDefinitionEvidence[] {
  if (options.importMode !== HarnessImportModeValue.LiveWatcher) {
    return [];
  }
  const invocations = focusedInvocations(session);
  if (invocations.length === 0) {
    return [];
  }
  const roots = options.roots ?? defaultFocusedRoots(session.cwd);
  const now = options.now ?? (() => new Date());
  const evidenceByInvocationId = new Map<
    string,
    NormalizedInvocationDefinitionEvidence
  >();
  const invocationGroups = new Map<string, FocusedInvocation[]>();
  for (const invocation of invocations) {
    const key = `${invocation.kind}\0${invocation.normalizedName}`;
    const group = invocationGroups.get(key);
    if (group) {
      group.push(invocation);
    } else {
      invocationGroups.set(key, [invocation]);
    }
  }
  for (const group of invocationGroups.values()) {
    const latest = group.reduce((current, invocation) =>
      invocation.invokedAt > current.invokedAt ? invocation : current
    );
    const matching = stableDefinitionSnapshots(latest, roots, now);
    if (matching.length === 0) {
      continue;
    }
    // Multiple equally plausible paths are ambiguous even when their bytes
    // match: identical content proves a version, not which SourceOccurrence
    // the runtime actually invoked.
    if (matching.length !== 1) {
      continue;
    }
    const snapshot = matching[0];
    const sourceModifiedAtMs = Date.parse(snapshot.sourceModifiedAt);
    const capturedAtMs = Date.parse(snapshot.capturedAt);
    for (const invocation of group) {
      const invokedAtMs = Date.parse(invocation.invokedAt);
      if (sourceModifiedAtMs <= invokedAtMs && invokedAtMs <= capturedAtMs) {
        evidenceByInvocationId.set(invocation.invocationId, {
          ...snapshot,
          ...invocation,
        });
      }
    }
  }
  return invocations.flatMap((invocation) => {
    const evidence = evidenceByInvocationId.get(invocation.invocationId);
    return evidence ? [evidence] : [];
  });
}

function focusedInvocations(session: NormalizedSession): FocusedInvocation[] {
  const invocations: FocusedInvocation[] = [];
  for (const [index, skill] of session.skills.entries()) {
    if (!skill.timestamp) {
      continue;
    }
    invocations.push({
      invocationId:
        skill.providerToolUseId ??
        `skill:${index}:${skill.timestamp}:${skill.name}`,
      kind: "skill",
      rawName: skill.rawName ?? skill.name,
      normalizedName: skill.normalizedName ?? skill.name,
      invokedAt: skill.timestamp,
    });
  }
  for (const [index, command] of session.slashCommands.entries()) {
    const normalizedName = normalizeCommandComponentKey(
      command.normalizedName ?? command.name
    );
    invocations.push({
      invocationId: commandUserTurnId(command, index),
      kind: "command",
      rawName: command.rawName ?? command.name,
      normalizedName,
      invokedAt: command.timestamp,
    });
  }
  // Never filesystem-resolve a subagent from its name alone. Claude built-ins
  // and plugin agents can share names with local markdown files, and the
  // transcript does not expose a trustworthy runtime-precedence discriminator.
  // Configured markdown agents require the parser's causally-linked embedded
  // definition snapshot; name-only subagents remain unresolved.
  return invocations;
}

function defaultFocusedRoots(cwd: string | null): DefinitionCollectorRoots {
  const projectSkillRoots = cwd
    ? [
        path.join(cwd, ".claude", "skills"),
        path.join(cwd, ".agents", "skills"),
        path.join(cwd, ".codex", "skills"),
      ]
    : [];
  const projectClaudeRoots = cwd ? [path.join(cwd, ".claude")] : [];
  return {
    skillRoots: [
      ...projectSkillRoots,
      path.join(resolveClaudeHome(), "skills"),
      path.join(resolveCodexHome(), "skills"),
      path.join(os.homedir(), ".agents", "skills"),
    ],
    claudeRoots: [...projectClaudeRoots, resolveClaudeHome()],
  };
}

function stableDefinitionSnapshots(
  invocation: FocusedInvocation,
  roots: DefinitionCollectorRoots,
  now: () => Date
): NormalizedInvocationDefinitionEvidence[] {
  const snapshots: NormalizedInvocationDefinitionEvidence[] = [];
  for (const candidate of definitionCandidatePaths(invocation, roots)) {
    const snapshot = stableDefinitionSnapshot(invocation, candidate, now);
    if (snapshot) {
      snapshots.push(snapshot);
    }
  }
  return snapshots;
}

/**
 * A candidate definition path paired with the scan root it was derived from.
 * The root travels with the candidate because admission is a CONTAINMENT check
 * (`isImportableSourcePath`): the candidate's real path must still resolve
 * under that root's real path.
 */
type DefinitionCandidate = { candidatePath: string; rootDir: string };

function definitionCandidatePaths(
  invocation: FocusedInvocation,
  roots: DefinitionCollectorRoots
): DefinitionCandidate[] {
  const relativeName = invocation.normalizedName.replace(LEADING_SLASH, "");
  const candidates = new Map<string, DefinitionCandidate>();
  const add = (candidatePath: string, rootDir: string) => {
    if (!candidates.has(candidatePath)) {
      candidates.set(candidatePath, { candidatePath, rootDir });
    }
  };
  if (invocation.kind === "skill") {
    for (const rawRoot of roots.skillRoots ?? []) {
      const { dir } = normalizeScanRoot(rawRoot);
      add(path.join(dir, relativeName, "SKILL.md"), dir);
      if (path.basename(dir) === relativeName) {
        add(path.join(dir, "SKILL.md"), dir);
      }
    }
  } else {
    const subdir = invocation.kind === "command" ? "commands" : "agents";
    for (const rawRoot of roots.claudeRoots ?? []) {
      const { dir } = normalizeScanRoot(rawRoot);
      add(path.join(dir, subdir, `${relativeName}.md`), dir);
    }
  }
  return [...candidates.values()];
}

function stableDefinitionSnapshot(
  invocation: FocusedInvocation,
  candidate: DefinitionCandidate,
  now: () => Date
): NormalizedInvocationDefinitionEvidence | null {
  const invokedAtMs = Date.parse(invocation.invokedAt);
  if (!Number.isFinite(invokedAtMs)) {
    return null;
  }
  const { candidatePath, rootDir } = candidate;
  try {
    const read = readContainedDefinition(candidatePath, rootDir);
    if (!read) {
      return null;
    }
    const { content, stat: after } = read;
    const normalizedName = definitionNameFromContent(
      invocation.kind,
      candidatePath,
      content
    );
    if (normalizedName !== invocation.normalizedName) {
      return null;
    }
    const capturedAt = now().toISOString();
    const capturedAtMs = Date.parse(capturedAt);
    if (!(after.mtimeMs <= invokedAtMs && invokedAtMs <= capturedAtMs)) {
      return null;
    }
    const fingerprint = computeDefinitionHash({
      frontmatter: "",
      body: content,
      kind: invocation.kind,
    });
    return {
      ...invocation,
      content,
      ...fingerprint,
      definitionFormat: "md",
      sourcePath: candidatePath,
      sourceModifiedAt: new Date(after.mtimeMs).toISOString(),
      capturedAt,
    };
  } catch {
    return null;
  }
}

function definitionNameFromContent(
  kind: NormalizedDefinitionKind,
  candidatePath: string,
  content: string
): string {
  const metadataName = parseSkillFrontmatter(content)?.name;
  if (kind === "skill") {
    return metadataName || path.basename(path.dirname(candidatePath));
  }
  const baseName = metadataName || path.basename(candidatePath, ".md");
  // ISS-4795: same shared normalizer as the discovery path above, so the
  // focused-read and directory-scan producers cannot drift into `/name` vs
  // `//name` for the same command.
  return kind === "command" ? normalizeCommandComponentKey(baseName) : baseName;
}

async function upsertDefinition(
  db: PackScannerDb,
  def: DiscoveredDefinition,
  now: string,
  homeDir: string,
  userScopeRoots: readonly string[] = []
): Promise<void> {
  const id = deterministicComponentId(def.kind, def.externalId);
  const hash = sha256Hex(def.content);
  // Scope is derived from where the definition lives (Claude Code convention,
  // plus the OpenCode config home via `userScopeRoots`). Null when it can't be
  // determined — never guessed. Applied via COALESCE on conflict so an existing
  // (e.g. event-driven) row gains scope but a later pass that can't derive one
  // won't clobber a good value.
  const scope = deriveComponentScope(
    def.installPath,
    def.projectPath,
    homeDir,
    userScopeRoots
  );
  const projectPath = def.projectPath ?? null;
  // Harness attribution (FEA-4028): taken from the scan root this definition
  // was discovered under (folded to `both` for a dual-installed identity), so a
  // Codex-sourced skill/agent is labeled `codex`, not defaulted to `claude` by
  // the read path. Applied via COALESCE on conflict for the same reason as
  // `scope` — a later pass that can't derive one (null) must not clobber a
  // previously-attributed value.
  const harness = def.harness;
  // F1 (FEA-3290 / PRD-527 Slice 4) — promotion (AC-6): this row is backed by
  // exact captured definition text, so it is `resolved`. Set on both insert and
  // conflict-update so a previously label-minted (`unresolved`) or
  // inaccessible/missing row is promoted the moment its exact definition is
  // read. This is the ONLY writer that mints `resolved`.
  await db.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_components
         (id, component_kind, external_id, component_key, name, install_path,
          scope, project_path, harness, content, content_hash, resolved_state,
          first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, 'resolved', $11, $11)
       ON CONFLICT (component_kind, external_id) DO UPDATE SET
         component_key  = excluded.component_key,
         name           = COALESCE(agent_components.name, excluded.name),
         install_path   = excluded.install_path,
         scope          = COALESCE(excluded.scope, agent_components.scope),
         project_path   = COALESCE(excluded.project_path, agent_components.project_path),
         harness        = COALESCE(excluded.harness, agent_components.harness),
         content        = excluded.content,
         content_hash   = excluded.content_hash,
         resolved_state = 'resolved',
         last_seen_at   = excluded.last_seen_at`,
      id,
      def.kind,
      def.externalId,
      def.name,
      def.installPath,
      scope,
      projectPath,
      harness,
      def.content,
      hash,
      now
    )
  );

  // Append the primary variant's version-history row.
  await upsertDefinitionVersion(db, def, hash, now);
}

/**
 * F1 (FEA-3290 / PRD-527 Slice 4) — the honest access classification for a
 * previously-captured definition file (AC-5). Distinguishes a permission-denied
 * read (`inaccessible`, EACCES) from a deleted/absent file (`missing`, ENOENT),
 * which MUST NOT be conflated: an inaccessible private body preserves its
 * last-known-good and can become readable again, while a missing one is gone.
 * Pure (single `fs.accessSync`), so it is trivially testable. Any other error
 * (e.g. the path is a directory now, transient IO) is treated conservatively as
 * `inaccessible` rather than `missing` — we never claim a file is gone unless we
 * actually saw ENOENT.
 */
export function classifyDefinitionAccess(
  installPath: string | null | undefined
): "accessible" | "inaccessible" | "missing" {
  if (!installPath) {
    // No known local path to check — cannot assert missing; leave as-is upstream.
    return "inaccessible";
  }
  try {
    accessSync(installPath, fsConstants.R_OK);
    return "accessible";
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return "missing";
    }
    // EACCES and every other read failure → inaccessible (never fabricate
    // "missing").
    return "inaccessible";
  }
}

/**
 * F1 (FEA-3290 / PRD-527 Slice 4) — reconcile the `resolved_state` of components
 * that were `resolved` (had exact captured content) but whose definition file
 * was NOT re-observed in the current collection pass (AC-5). For each such row
 * with a known `install_path`, re-check the file: EACCES → `inaccessible`,
 * ENOENT → `missing`. The captured `content`/`content_hash` (last-known-good) is
 * NEVER cleared — only `resolved_state` moves — so nothing is lost and a file
 * that becomes readable again promotes back to `resolved` on the next pass.
 * Idempotent: re-running with the same filesystem produces the same state.
 * Rows still readable (present in `observedIds`) are untouched here — they were
 * just re-`resolved` by `upsertDefinition`.
 */
async function reconcileDefinitionAccessState(
  db: PackScannerDb,
  observedIds: ReadonlySet<string>,
  now: string
): Promise<void> {
  const rows = await db.read((client) =>
    client.$queryRawUnsafe<{ id: string; install_path: string | null }[]>(
      `SELECT id, install_path FROM agent_components
       WHERE resolved_state = 'resolved' AND install_path IS NOT NULL`
    )
  );
  for (const row of rows) {
    if (observedIds.has(row.id)) {
      continue; // re-observed this pass — already resolved, leave it.
    }
    const access = classifyDefinitionAccess(row.install_path);
    if (access === "accessible") {
      continue; // still readable but not in scan roots — do not demote.
    }
    await db.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE agent_components
           SET resolved_state = $1, last_seen_at = $2
         WHERE id = $3`,
        access,
        now,
        row.id
      )
    );
  }
}

/**
 * Walk the given roots, read each prompt-bearing definition file, and upsert its
 * `content` + `content_hash` into `agent_components`. Best-effort: a single
 * failing row is logged and skipped; the rest continue.
 */
export async function collectDefinitionContent(
  db: PackScannerDb,
  roots: DefinitionCollectorRoots,
  nowIso: string = new Date().toISOString()
): Promise<DefinitionCollectorSummary> {
  // ISS-5274: discovery (the filesystem walk) and apply (the writes) are split
  // so the walk can run in the pack-scan compute worker instead of on the
  // db-host. This on-host path composes the SAME two halves the worker path
  // uses, so `applyDiscoveredDefinitions` stays the single writer of the display
  // row + `observedIds` + reconcile trio and the two paths cannot drift — a
  // drift that would otherwise be invisible, since this fallback only runs when
  // the worker path already failed.
  return await applyDiscoveredDefinitions(
    db,
    discoverDefinitions(roots),
    deriveDefinitionApplyContext(roots),
    nowIso
  );
}

/**
 * Upsert already-discovered definitions. This is the DB half of
 * `collectDefinitionContent`, exported so the db-host can apply a set the
 * pack-scan worker walked (ISS-5274) without walking again itself.
 *
 * `context` carries the scope inputs `upsertDefinition` needs. They are derived
 * from the same roots the walk used and MUST be passed through rather than
 * re-derived here: dropping `userScopeRoots` persists `scope = null` for every
 * OpenCode user-global definition (the ISS-4386 regression).
 */
export async function applyDiscoveredDefinitions(
  db: PackScannerDb,
  definitions: readonly Omit<DefinitionVariants, "seenHashes">[],
  context: DefinitionApplyContext,
  nowIso: string = new Date().toISOString()
): Promise<DefinitionCollectorSummary> {
  const { homeDir, userScopeRoots } = context;
  const summary: DefinitionCollectorSummary = { upserted: 0, skipped: 0 };
  // F1 (FEA-3290 Slice 4 / AC-5): track which inventory rows we re-observed this
  // pass so the access-state reconciliation can distinguish inaccessible vs
  // missing for the rows we did NOT re-read.
  const observedIds = new Set<string>();
  for (const { primary, variants } of definitions) {
    try {
      // The precedence-winning variant drives the `agent_components` display
      // row AND writes its own version row.
      await upsertDefinition(db, primary, nowIso, homeDir, userScopeRoots);
      observedIds.add(
        deterministicComponentId(primary.kind, primary.externalId)
      );
      // Every OTHER distinct-content variant of the same identity retains its
      // bytes as a version row (ISS-4564) — precedence chose the primary, but a
      // same-name definition with different content under a lower-precedence
      // root is NOT dropped from `agent_component_versions`. These do NOT touch
      // the display row and do NOT count as separate `upserted` identities.
      for (const variant of variants) {
        await upsertDefinitionVersion(
          db,
          variant,
          sha256Hex(variant.content),
          nowIso
        );
      }
      summary.upserted += 1;
    } catch (e: unknown) {
      summary.skipped += 1;
      const msg = e instanceof Error ? e.message : String(e);
      gatewayLog.warn(
        "definition-content-collector",
        `failed to upsert ${primary.kind} "${primary.externalId}": ${msg}`
      );
    }
  }
  // Reconcile access state for previously-resolved rows whose file was not
  // re-observed: EACCES → inaccessible, ENOENT → missing (AC-5). Best-effort —
  // never throws out of collection.
  try {
    await reconcileDefinitionAccessState(db, observedIds, nowIso);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "definition-content-collector",
      `failed to reconcile definition access state: ${msg}`
    );
  }
  return summary;
}

/**
 * Production entrypoint: resolve the standard roots (`~/.claude`, `~/.codex`,
 * the OpenCode config home, and recently-active project directories) and collect
 * their definition content. Best-effort — a failure to enumerate project roots
 * degrades to the home-scoped roots rather than throwing.
 */
export async function collectDefinitionContentFromDefaults(
  db: PackScannerDb
): Promise<DefinitionCollectorSummary> {
  let projectRoots: string[] = [];
  try {
    projectRoots = await getRecentProjectRoots(db);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    gatewayLog.warn(
      "definition-content-collector",
      `failed to resolve project roots: ${msg}`
    );
  }
  return collectDefinitionContent(
    db,
    resolveDefaultDefinitionScanRoots(projectRoots)
  );
}
