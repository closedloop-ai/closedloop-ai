/**
 * An INERT, self-contained pack-install fixture for the Desktop pack E2E.
 *
 * The install/uninstall path spawns `sh -c <command text from the catalog row>`
 * and the pack scanner then reads the filesystem to decide what is installed. To
 * drive that whole chain for real — renderer click → IPC → spawn → rescan →
 * rendered control set — a spec needs command text that (a) runs on a bare CI
 * runner with no harness CLI on PATH, and (b) produces exactly the on-disk shape
 * the scanner correlates back to the seeded `pack_id`.
 *
 * That shape is NOT arbitrary. `scanClaudeMarketplaces` derives a pack id from
 * the KEY in `<CLAUDE_HOME>/plugins/installed_plugins.json`, splitting it at the
 * last `@` into `<pluginName>@<marketplace>`:
 *   - the pack id is `pluginName`, so the key must be `<packId>@<marketplace>`;
 *   - an entry with no `@` (null marketplace) is skipped — the suffix is required;
 *   - `marketplace` must not be `closedloop-ai`, which is the one marketplace
 *     bundled as a SINGLE pack keyed on the marketplace name instead;
 *   - neither name may be `gstack` or `bmad-method` (`RESERVED_PLUGIN_PACK_IDS`),
 *     which have dedicated scanners;
 *   - the entry's `installPath` must EXIST on disk, or the plugin is skipped.
 * Each `<installPath>/skills/<name>/SKILL.md` then becomes a `skills` row for the
 * pack, which is what `getPackDetail` returns and what the Contents tab's
 * per-component markers resolve against.
 *
 * Every path is baked into the command text as an absolute literal rather than
 * read from an env var, because `buildAllowedChildEnv` passes the child a strict
 * allowlist (PATH/HOME/USER/SHELL/LANG/TERM/TMPDIR/…) that does NOT include
 * `CLAUDE_HOME` — a command referencing `$CLAUDE_HOME` would expand to empty and
 * write outside the fixture.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { isolatedHarnessHomes } from "../../helpers/isolated-harness-homes";

/**
 * The marketplace the fixture registers under. Deliberately NOT `closedloop-ai`
 * (bundled as one pack keyed on the marketplace, which would defeat the per-pack
 * id correlation) and not a reserved id.
 */
export const FIXTURE_MARKETPLACE = "closedloop-e2e-marketplace";

/** The version the fixture reports for the installed plugin. */
const FIXTURE_VERSION = "1.0.0";

export type PackInstallFixture = {
  packId: string;
  displayName: string;
  /** The single skill component the install writes, and the Contents entry name. */
  skillName: string;
  /** Root of this fixture's isolated Claude home (`CLAUDE_HOME`). */
  claudeHome: string;
  /** Directory the registry points at; must exist for the scanner to accept it. */
  installPath: string;
  /** `<claudeHome>/plugins/installed_plugins.json`. */
  registryPath: string;
  /** The `SKILL.md` the install writes and the scanner turns into a skill row. */
  skillFilePath: string;
  /** Catalog `install_commands.claude` — creates the plugin + registry entry. */
  installCommand: string;
  /** Catalog `uninstall_commands.claude` — removes both again. */
  uninstallCommand: string;
};

/**
 * Build the fixture's paths and the two inert shell commands for a pack id.
 *
 * Creates no files: the COMMANDS create them, because a spec that pre-created
 * the on-disk state would prove nothing about whether the click actually spawned
 * anything.
 */
export function createPackInstallFixture(params: {
  claudeHome: string;
  packId: string;
  displayName: string;
  skillName: string;
}): PackInstallFixture {
  const { claudeHome, packId, displayName, skillName } = params;
  const installPath = path.join(
    claudeHome,
    "plugins",
    "cache",
    FIXTURE_MARKETPLACE,
    packId
  );
  const registryPath = path.join(
    claudeHome,
    "plugins",
    "installed_plugins.json"
  );
  const skillDir = path.join(installPath, "skills", skillName);
  const skillFilePath = path.join(skillDir, "SKILL.md");

  const registryJson = JSON.stringify({
    plugins: {
      [`${packId}@${FIXTURE_MARKETPLACE}`]: [
        { installPath, version: FIXTURE_VERSION },
      ],
    },
  });
  // An EMPTY registry, not a deleted file: `readClaudeInstalledPluginRegistry`
  // treats an absent file as an authoritative empty too, but writing `{}` keeps
  // the uninstall a rewrite rather than relying on ENOENT handling.
  const emptyRegistryJson = JSON.stringify({ plugins: {} });

  const installCommand = [
    `mkdir -p ${shellQuote(skillDir)}`,
    // No YAML frontmatter on purpose: `parseSkillFrontmatter` then yields no
    // name and the scanner falls back to the containing directory name, so the
    // skill is named `skillName` — the same string the Contents entry uses.
    `printf '%s\\n' '# closedloop e2e skill' > ${shellQuote(skillFilePath)}`,
    `printf '%s' ${shellQuote(registryJson)} > ${shellQuote(registryPath)}`,
  ].join(" && ");

  const uninstallCommand = [
    `rm -rf ${shellQuote(installPath)}`,
    `printf '%s' ${shellQuote(emptyRegistryJson)} > ${shellQuote(registryPath)}`,
  ].join(" && ");

  return {
    packId,
    displayName,
    skillName,
    claudeHome,
    installPath,
    registryPath,
    skillFilePath,
    installCommand,
    uninstallCommand,
  };
}

/** Whether the fixture's on-disk install artifacts are currently present. */
export function fixtureArtifactsPresent(fixture: PackInstallFixture): boolean {
  return (
    fs.existsSync(fixture.skillFilePath) &&
    fs.existsSync(fixture.registryPath) &&
    fs.readFileSync(fixture.registryPath, "utf8").includes(fixture.packId)
  );
}

/** POSIX single-quote escaping, so a temp path can never break the command. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * Block until the Agent Dashboard runtime is actually serving a seeded catalog
 * row, for a spec that is about to drive the pack surfaces.
 *
 * The runtime starts asynchronously after the window opens, and until it does
 * every catalog channel answers with a neutral disabled response — a READ
 * resolves EMPTY rather than failing, and a MUTATION resolves a contract-complete
 * error outcome built by the same factory a genuine permanent failure uses. Both
 * are silent false-green sources, so every pack spec gates on this first.
 *
 * A read is the gate, deliberately: polling a mutation would fire repeated real
 * runs. `getCatalogEntry` returning the row proves the runtime is up AND that the
 * seed landed in the store the app actually reads.
 */
export async function waitForCatalogEntryServing(
  page: Page,
  packId: string,
  timeoutMs: number
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const db = (window as CatalogReadyWindow).desktopApi?.db;
          if (!db?.getCatalogEntry) {
            return "missing";
          }
          return (await db.getCatalogEntry(id)) ? "serving" : "starting";
        }, packId),
      { timeout: timeoutMs }
    )
    .toBe("serving");
}

/** The single preload read {@link waitForCatalogEntryServing} gates on. */
type CatalogReadyWindow = Window & {
  desktopApi?: {
    db?: { getCatalogEntry?: (packId: string) => Promise<unknown | null> };
  };
};

/** The isolated harness homes one launch runs against. */
export type HarnessHomes = {
  /** Root holding every home — removed wholesale by {@link removeHarnessHomes}. */
  root: string;
  /** Collector-home overrides to spread into the launch env. */
  env: Record<string, string>;
  /** The Claude home {@link createPackInstallFixture} bakes into its commands. */
  claudeHome: string;
};

/**
 * Fresh, empty homes for EVERY collector a desktop launch reads.
 *
 * `claudeHome` is load-bearing — it is the tree {@link createPackInstallFixture}
 * bakes into the install command and the scanner reads back. The rest exist only
 * to isolate: `launchDesktopApp` INHERITS the runner environment, and every
 * collector home falls back to a path under `os.homedir()` when its override is
 * unset, so an unpinned home leaves a boot collector importing the operator's
 * REAL local history into the test profile.
 *
 * The variable set comes from `isolatedHarnessHomes`, which owns that list for
 * the whole desktop test tree — re-listing it here is how a spec ends up
 * isolating only Claude and Codex.
 *
 * Callers own the lifetime — pass the result to {@link removeHarnessHomes} in a
 * `finally`. The skip flags stay with each spec, which needs a different set.
 */
export function makeHarnessHomes(): HarnessHomes {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "closedloop-e2e-harness-homes-")
  );
  const env = isolatedHarnessHomes(root);
  return { root, env, claudeHome: env.CLAUDE_HOME };
}

/** Remove every temp home {@link makeHarnessHomes} created. */
export function removeHarnessHomes(homes: HarnessHomes): void {
  fs.rmSync(homes.root, { force: true, recursive: true });
}
