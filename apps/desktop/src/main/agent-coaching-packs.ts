/**
 * @file agent-coaching-packs.ts — the "coaching pack" store for Agent Coaching
 * Tips.
 *
 * A coaching pack is a directory carrying a `coaching-pack.json` manifest whose
 * `signals` array is the set of best-practice statements the coaching prompt
 * draws on. The built-in `AGENTIC_DEVELOPMENT_SIGNALS` (in
 * agent-coaching-llm.ts) is the default; an installed-and-active pack REPLACES
 * those signals, so coaching knowledge can be distributed as a folder and
 * dropped in. This is the mechanism behind the Token Coach demo.
 *
 * This module is deliberately electron-free — it takes the packs directory (and
 * the bundled-seed directory) as plain paths so it is unit-testable under
 * `node:test` with a temp dir. The electron glue (resolving
 * `app.getPath("userData")` and `process.resourcesPath`) lives in app.ts.
 *
 * On-disk layout under <packsDir>:
 *   active.json                      -> { activePackName: string | null }
 *   <pack-name>/coaching-pack.json   -> the installed pack manifest
 *   <pack-name>/...                  -> any other pack files (docs, references)
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { CoachingPackInfo } from "../shared/coaching-pack-contract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MANIFEST_FILE = "coaching-pack.json";
const PLUGIN_MANIFEST_FILE = path.join(".claude-plugin", "plugin.json");
const ACTIVE_FILE = "active.json";
const DEFAULT_RESOURCES_DIR = "coaching-packs";

/**
 * An identity string field: trimmed and required non-empty, otherwise treated
 * as absent (a non-string or blank value falls back through the identity
 * chain rather than rejecting the whole manifest).
 */
const optionalManifestString = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0)
  .optional()
  .catch(undefined);

/**
 * Zod schema for the untrusted `coaching-pack.json` / `plugin.json` JSON. Per
 * the AGENTS.md convention we validate shape with Zod rather than hand-rolled
 * `typeof` checks. Both files are lenient: bad/missing identity fields degrade
 * to "absent" and non-string `signals` entries are dropped, so a partially
 * malformed manifest still yields a usable pack when it has at least one
 * signal.
 */
const manifestSchema = z.object({
  name: optionalManifestString,
  displayName: optionalManifestString,
  display_name: optionalManifestString,
  version: optionalManifestString,
  description: optionalManifestString,
  signals: z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0
      )
    ),
});

type ParsedManifest = z.infer<typeof manifestSchema>;

const activePointerSchema = z.object({
  activePackName: optionalManifestString,
});

function parseManifest(value: unknown): ParsedManifest | null {
  const result = manifestSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Reduce an arbitrary pack name to a filesystem-safe slug so a manifest can
 * never escape the packs directory (path traversal) or collide with the
 * `active.json` pointer. Returns null when nothing usable remains.
 */
export function coachingPackSlug(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 100);
  // Block any slug that would collide with the active-pointer file — both the
  // bare "active" and the full "active.json" basename — so an installed pack
  // can never shadow it (which would make the pointer path an EISDIR target).
  if (!slug || slug === "active" || slug === path.basename(ACTIVE_FILE)) {
    return null;
  }
  return slug;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Read and validate a pack directory's manifest. Identity (name/displayName/
 * version/description) falls back to a sibling `.claude-plugin/plugin.json`
 * when absent from `coaching-pack.json`, so an existing Claude plugin only has
 * to add `signals`. Returns null when the directory is not a usable coaching
 * pack (no manifest, or no signals).
 */
export function readCoachingPackManifest(
  packDir: string
): CoachingPackInfo | null {
  const manifest = parseManifest(readJson(path.join(packDir, MANIFEST_FILE)));
  if (!manifest) {
    return null;
  }
  const { signals } = manifest;
  if (signals.length === 0) {
    // A coaching pack with no signals can't override anything — not usable.
    return null;
  }
  const plugin = parseManifest(
    readJson(path.join(packDir, PLUGIN_MANIFEST_FILE))
  );
  const name =
    manifest.name ??
    plugin?.name ??
    optionalManifestString.parse(path.basename(packDir));
  if (!name) {
    return null;
  }
  const displayName =
    manifest.displayName ??
    manifest.display_name ??
    plugin?.displayName ??
    plugin?.display_name ??
    name;
  return {
    name,
    displayName,
    version: manifest.version ?? plugin?.version ?? null,
    description: manifest.description ?? plugin?.description ?? null,
    signals,
  };
}

function readActivePackName(packsDir: string): string | null {
  const result = activePointerSchema.safeParse(
    readJson(path.join(packsDir, ACTIVE_FILE))
  );
  return result.success ? (result.data.activePackName ?? null) : null;
}

/**
 * Point the store at a pack (or clear the pointer with null). Writing the
 * pointer is what makes a pack "active" — the signals it carries then replace
 * the built-in defaults on the next coaching generation.
 */
export function setActiveCoachingPack(
  packsDir: string,
  name: string | null
): void {
  mkdirSync(packsDir, { recursive: true });
  writeFileSync(
    path.join(packsDir, ACTIVE_FILE),
    `${JSON.stringify({ activePackName: name }, null, 2)}\n`
  );
}

/** Every installed pack with a valid manifest, sorted by name for determinism. */
export function listInstalledCoachingPacks(
  packsDir: string
): CoachingPackInfo[] {
  if (!existsSync(packsDir)) {
    return [];
  }
  const packs: CoachingPackInfo[] = [];
  for (const entry of readdirSync(packsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const info = readCoachingPackManifest(path.join(packsDir, entry.name));
    if (info) {
      packs.push(info);
    }
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Copy a pack directory into the managed store and make it active. The whole
 * source folder is copied so the pack is self-contained and survives the
 * source being moved/deleted. Throws when the source is not a valid coaching
 * pack — we validate before copying so a bad folder never lands in the store.
 */
export function installCoachingPack(
  sourceDir: string,
  packsDir: string
): CoachingPackInfo {
  // The source is renderer-supplied and untrusted; canonicalize it (resolving
  // any symlinks / `..` components) before reading or copying so the install
  // operates on the real path rather than one that points elsewhere. Throws if
  // the path does not exist.
  let realSourceDir: string;
  try {
    realSourceDir = realpathSync.native(sourceDir);
  } catch {
    throw new Error(
      `not a valid coaching pack (source not found): ${sourceDir}`
    );
  }
  const manifest = readCoachingPackManifest(realSourceDir);
  if (!manifest) {
    throw new Error(
      `not a valid coaching pack (missing ${MANIFEST_FILE} with signals): ${realSourceDir}`
    );
  }
  const slug = coachingPackSlug(manifest.name);
  if (!slug) {
    throw new Error(`invalid coaching pack name: ${manifest.name}`);
  }
  const dest = path.join(packsDir, slug);
  mkdirSync(packsDir, { recursive: true });
  // Replace any prior copy so re-installing picks up a newer source.
  cpSync(realSourceDir, dest, { recursive: true });
  const installed = readCoachingPackManifest(dest);
  if (!installed) {
    throw new Error(`coaching pack failed to install: ${dest}`);
  }
  setActiveCoachingPack(packsDir, slug);
  return installed;
}

/**
 * The currently-active pack's info, or null when none is active (built-in
 * defaults then apply). Resolves the pointer to a real, still-valid install —
 * a dangling pointer (pack dir removed) reads as "no active pack".
 */
export function getActiveCoachingPack(
  packsDir: string
): CoachingPackInfo | null {
  const name = readActivePackName(packsDir);
  if (!name) {
    return null;
  }
  const slug = coachingPackSlug(name);
  if (!slug) {
    return null;
  }
  const packDir = path.join(packsDir, slug);
  if (!(existsSync(packDir) && statSync(packDir).isDirectory())) {
    return null;
  }
  return readCoachingPackManifest(packDir);
}

/**
 * Install every bundled pack found under `bundledRootDir`, and — when nothing
 * is active yet — activate the first one. Safe to call on every launch: an
 * existing active pointer is left untouched, so a user's later choice is never
 * clobbered.
 *
 * A bundled pack already present in the store is refreshed in place when the
 * bundled `version` differs from the installed copy's, so signal fixes shipped
 * in a new app release reach users who seeded an older copy. Only the managed
 * copy's files are overwritten; the active pointer is not touched. Packs the
 * user installed themselves live under their own slug and are never refreshed
 * here.
 */
export function seedBundledCoachingPacks(
  packsDir: string,
  bundledRootDir: string | null
): void {
  if (!(bundledRootDir && existsSync(bundledRootDir))) {
    return;
  }
  mkdirSync(packsDir, { recursive: true });
  for (const entry of readdirSync(bundledRootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sourceDir = path.join(bundledRootDir, entry.name);
    const manifest = readCoachingPackManifest(sourceDir);
    if (!manifest) {
      continue;
    }
    const slug = coachingPackSlug(manifest.name);
    if (!slug) {
      continue;
    }
    const dest = path.join(packsDir, slug);
    const installed = readCoachingPackManifest(dest);
    const bundledVersionChanged =
      installed !== null &&
      manifest.version !== null &&
      manifest.version !== installed.version;
    if (!existsSync(dest) || bundledVersionChanged) {
      cpSync(sourceDir, dest, { recursive: true });
    }
  }
  // Auto-activate a default ONLY on the very first seed — i.e. when no
  // active pointer file exists yet. Once the store has recorded a choice
  // (including an explicit "none" / built-in defaults), later launches must
  // not re-activate over it. The file's existence (not its value) is the
  // "store has decided" marker.
  if (!existsSync(path.join(packsDir, ACTIVE_FILE))) {
    const installed = listInstalledCoachingPacks(packsDir);
    if (installed.length > 0) {
      const slug = coachingPackSlug(installed[0].name);
      if (slug) {
        setActiveCoachingPack(packsDir, slug);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Distribution-honoring install path (T-22.3)
// ---------------------------------------------------------------------------

/**
 * Check whether the org-distributed coaching default should be applied to this
 * device, implementing the "first-seed-only, never clobber a recorded user
 * choice" invariant from `seedBundledCoachingPacks` — generalized to org
 * distribution.
 *
 * Returns true when the active pointer file does NOT yet exist (i.e. the store
 * has never recorded a choice for this device) AND the named pack is not
 * already installed at that slug. This is the exact predicate from
 * `seedBundledCoachingPacks` (L322-332) transposed to org distribution:
 *   - If `active.json` exists (the user has made any choice, including
 *     deliberately setting "none"), we must NOT override it.
 *   - If the pack is already installed and active, no re-install is needed.
 *
 * `packsDir` is `userData/coaching-packs`.
 * `packSlug` is the slug derived from the distributed CatalogItem name.
 */
export function shouldHonorDistributionDefault(
  packsDir: string,
  packSlug: string
): boolean {
  // If the active pointer already exists, a choice has been recorded — do not
  // override it (the core override-precedence invariant).
  const activeFile = path.join(packsDir, ACTIVE_FILE);
  if (existsSync(activeFile)) {
    return false;
  }
  // No active pointer yet — this is the first-seed opportunity. Also check
  // whether the pack directory already exists to avoid double-installs.
  const dest = path.join(packsDir, packSlug);
  if (existsSync(dest)) {
    // Pack is already on disk from a previous run; just activate it without
    // re-copying (mirrors seedBundledCoachingPacks version-refresh logic).
    return true;
  }
  // Pack doesn't exist yet — install it.
  return true;
}

/**
 * Install a coaching pack from an org distribution and (optionally) activate
 * it as the device default. Follows the same copy-then-validate flow as
 * `installCoachingPack` but accepts a pre-resolved source directory rather
 * than a user-supplied folder pick.
 *
 * The caller is responsible for:
 *   1. Downloading the CatalogItem asset zip to a temp directory.
 *   2. Extracting it to `sourceDir`.
 *   3. Calling this function with the extracted directory.
 *
 * Respects override precedence via `shouldHonorDistributionDefault`: if the
 * user has already recorded a choice (active.json exists) this function
 * returns the existing active pack WITHOUT overwriting, so a re-sync never
 * clobbers a user's local selection.
 *
 * When `activate` is true and the distribution default should be honored, this
 * sets the active pointer — matching the `seedBundledCoachingPacks` behavior
 * of auto-activating on first seed.
 *
 * Returns the installed `CoachingPackInfo` on success, or null when:
 *   - The source is not a valid coaching pack.
 *   - The distribution default should not be honored (user has a local choice).
 *   - Any IO error occurs (best-effort; errors are logged by the caller).
 */
export function installCoachingPackFromDistribution(
  sourceDir: string,
  packsDir: string,
  activate = true
): CoachingPackInfo | null {
  // Validate and read the manifest before touching the store.
  let realSourceDir: string;
  try {
    realSourceDir = realpathSync.native(sourceDir);
  } catch {
    return null;
  }

  const manifest = readCoachingPackManifest(realSourceDir);
  if (!manifest) {
    return null;
  }

  const slug = coachingPackSlug(manifest.name);
  if (!slug) {
    return null;
  }

  // Check override-precedence: if a choice has been recorded, only install if
  // not already active (i.e. refresh a version-changed pack in place).
  const activeFile = path.join(packsDir, ACTIVE_FILE);
  const choiceRecorded = existsSync(activeFile);

  const dest = path.join(packsDir, slug);
  const installed = readCoachingPackManifest(dest);

  // Version-changed refresh: always update the managed copy when the
  // distributed version differs, even when a user choice is recorded. The
  // active pointer is NOT changed — the user's preferred pack stays selected,
  // but the updated distribution pack is available in the store.
  const versionChanged =
    installed !== null &&
    manifest.version !== null &&
    manifest.version !== installed.version;

  if (!existsSync(dest) || versionChanged) {
    try {
      mkdirSync(packsDir, { recursive: true });
      cpSync(realSourceDir, dest, { recursive: true });
    } catch {
      return null;
    }
  }

  const result = readCoachingPackManifest(dest);
  if (!result) {
    return null;
  }

  // Activate only on first-ever seed (no active.json yet) when requested.
  if (activate && !choiceRecorded) {
    setActiveCoachingPack(packsDir, slug);
  }

  return result;
}

/**
 * Locate the bundled coaching-packs directory across packaged and dev layouts
 * (mirrors the command-pack resolver). Returns null when not found.
 */
export function resolveBundledCoachingPacksDir(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const candidates = [
    resourcesPath ? path.join(resourcesPath, DEFAULT_RESOURCES_DIR) : null,
    path.join(process.cwd(), "resources", DEFAULT_RESOURCES_DIR),
    path.join(
      process.cwd(),
      "apps",
      "desktop",
      "resources",
      DEFAULT_RESOURCES_DIR
    ),
    path.join(__dirname, "..", "..", "resources", DEFAULT_RESOURCES_DIR),
  ].filter((candidate): candidate is string => typeof candidate === "string");
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
}
