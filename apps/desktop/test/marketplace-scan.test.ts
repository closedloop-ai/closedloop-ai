/**
 * @file marketplace-scan.test.ts
 * @description Behavioural coverage for the marketplace arm of the Claude pack
 * projection (ISS-7686). Before this suite the code had none that could fail:
 * `pack-scan-compute.test.ts` STUBS `scanClaudeMarketplaces` through the
 * `overrides` seam and `pack-scanner-db.test.ts` never mentions marketplaces,
 * so a green desktop suite said nothing about this projection.
 *
 * Everything here pins CURRENT behaviour against a real temp filesystem — the
 * helpers walk `fs` for real, so a fake would only prove the fake. The two call
 * shapes of `emitPluginSkills` are asserted through the id root and pack id they
 * disagree on, because collapsing the two copies into one helper is exactly the
 * change that could silently swap them.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { ClaudePluginRegistryEntry } from "../src/main/packs/claude-plugin-registry.js";
import {
  emitPluginSkills,
  groupInstalledPluginsByMarketplace,
  scanBundledMarketplace,
  scanPerPluginMarketplace,
} from "../src/main/packs/marketplace-scan.js";
import {
  type AssociationUpsertRow,
  type PackScanSink,
  type PackUpsertRow,
  type SkillUpsertRow,
  scanClaudeMarketplaces,
} from "../src/main/packs/pack-scanner.js";
import { deterministicSkillId } from "../src/main/packs/skill-files.js";

const CLOSEDLOOP_SOURCE = "https://github.com/closedloop-ai/claude-plugins";
const OFFICIAL_SOURCE = "https://github.com/anthropics/claude-plugins-official";

/**
 * Records every row in emission order. Deliberately NOT `CollectingSink` — that
 * one dedupes by upsert key, which would hide a duplicate emission these tests
 * exist to catch.
 */
class RecordingSink implements PackScanSink {
  readonly packs: PackUpsertRow[] = [];
  readonly skills: SkillUpsertRow[] = [];
  readonly associations: AssociationUpsertRow[] = [];

  pack(row: PackUpsertRow): Promise<void> {
    this.packs.push(row);
    return Promise.resolve();
  }

  skill(row: SkillUpsertRow): Promise<void> {
    this.skills.push(row);
    return Promise.resolve();
  }

  association(row: AssociationUpsertRow): Promise<void> {
    this.associations.push(row);
    return Promise.resolve();
  }

  recentProjectRoots(): string[] {
    return [];
  }
}

function tempRoot(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write `<root>/<dir>/SKILL.md`, with `frontmatter` omitted when null. */
function writeSkill(
  root: string,
  dir: string,
  frontmatter: string | null
): string {
  const skillDir = path.join(root, dir);
  mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, "SKILL.md");
  const body = "How to do the thing.\n";
  writeFileSync(
    file,
    frontmatter === null ? body : `---\n${frontmatter}\n---\n${body}`
  );
  return file;
}

function entry(
  pluginName: string,
  marketplace: string | null,
  installPath: string,
  version: string | null
): ClaudePluginRegistryEntry {
  return { pluginName, marketplace, installPath, version };
}

// ---------------------------------------------------------------------------
// groupInstalledPluginsByMarketplace
// ---------------------------------------------------------------------------

test("groupInstalledPluginsByMarketplace buckets by marketplace, keeping registry order and per-plugin fields", () => {
  const grouped = groupInstalledPluginsByMarketplace([
    entry("alpha", "closedloop-ai", "/p/alpha", "1.0.0"),
    entry("superpowers", "official", "/p/superpowers", null),
    entry("beta", "closedloop-ai", "/p/beta", "1.1.0"),
  ]);

  assert.deepEqual([...grouped.keys()], ["closedloop-ai", "official"]);
  assert.deepEqual(grouped.get("closedloop-ai"), [
    { pluginName: "alpha", installPath: "/p/alpha", version: "1.0.0" },
    { pluginName: "beta", installPath: "/p/beta", version: "1.1.0" },
  ]);
  assert.deepEqual(grouped.get("official"), [
    { pluginName: "superpowers", installPath: "/p/superpowers", version: null },
  ]);
});

test("groupInstalledPluginsByMarketplace drops harness-direct plugins (null marketplace) entirely", () => {
  const grouped = groupInstalledPluginsByMarketplace([
    entry("solo", null, "/p/solo", "9.9.9"),
    entry("alpha", "closedloop-ai", "/p/alpha", null),
    entry("other-solo", null, "/p/other", null),
  ]);

  // A plugin installed straight into the harness is not a pack, so it must not
  // create a bucket of its own NOR leak into another marketplace's bucket.
  assert.deepEqual([...grouped.keys()], ["closedloop-ai"]);
  assert.equal(grouped.get("closedloop-ai")?.length, 1);
});

test("groupInstalledPluginsByMarketplace returns an empty map for no entries", () => {
  assert.equal(groupInstalledPluginsByMarketplace([]).size, 0);
});

// ---------------------------------------------------------------------------
// emitPluginSkills — the two call shapes
// ---------------------------------------------------------------------------

test("emitPluginSkills bundled shape keys skill ids off the shared cache root and the marketplace pack id", async () => {
  const root = tempRoot("iss7686-bundled-");
  try {
    const install = path.join(root, "install");
    writeSkill(
      install,
      "skills/planner",
      'name: "planner"\nversion: "2.0.0"\ndescription: "Plans things."'
    );
    const cacheRoot = path.join(root, "cache", "closedloop-ai");
    const sink = new RecordingSink();

    const emitted = await emitPluginSkills({
      skillsRoot: path.join(install, "skills"),
      skillIdRoot: cacheRoot,
      packId: "closedloop-ai",
      sourceUrl: CLOSEDLOOP_SOURCE,
      pluginVersion: "1.0.0",
      sink,
    });

    assert.equal(emitted, 1);
    assert.deepEqual(sink.skills, [
      {
        skill_id: deterministicSkillId("claude", cacheRoot, "planner"),
        pack_id: "closedloop-ai",
        harness: "claude",
        install_path: path.join(install, "skills", "planner", "SKILL.md"),
        name: "planner",
        // Frontmatter version wins over the plugin's own version.
        version: "2.0.0",
        description: "Plans things.",
        source_url: CLOSEDLOOP_SOURCE,
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitPluginSkills per-plugin shape keys skill ids off the plugin install path and the plugin pack id", async () => {
  const root = tempRoot("iss7686-perplugin-");
  try {
    const install = path.join(root, "superpowers");
    writeSkill(install, "skills/planner", 'name: "planner"');
    const sink = new RecordingSink();

    const emitted = await emitPluginSkills({
      skillsRoot: path.join(install, "skills"),
      skillIdRoot: install,
      packId: "superpowers",
      sourceUrl: null,
      pluginVersion: "3.0.0",
      sink,
    });

    assert.equal(emitted, 1);
    const [row] = sink.skills;
    assert.equal(row.pack_id, "superpowers");
    assert.equal(
      row.skill_id,
      deterministicSkillId("claude", install, "planner")
    );
    // No frontmatter version → the plugin's version; no description → null.
    assert.equal(row.version, "3.0.0");
    assert.equal(row.description, null);
    assert.equal(row.source_url, null);
    // The two shapes must NOT collide: same skill name, different id root.
    assert.notEqual(
      row.skill_id,
      deterministicSkillId("claude", path.join(root, "cache"), "planner")
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitPluginSkills falls back to the containing directory name when frontmatter carries no name", async () => {
  const root = tempRoot("iss7686-dirname-");
  try {
    writeSkill(root, "skills/repo-inspection", 'description: "No name key."');
    writeSkill(root, "skills/blank-name", 'name: ""');
    const sink = new RecordingSink();

    const emitted = await emitPluginSkills({
      skillsRoot: path.join(root, "skills"),
      skillIdRoot: root,
      packId: "pack",
      sourceUrl: null,
      pluginVersion: null,
      sink,
    });

    assert.equal(emitted, 2);
    // Two skill dirs under ONE root: the walk order is readdir's, which is
    // filesystem-dependent, so this is the one place sorting is correct.
    assert.deepEqual(sink.skills.map((s) => s.name).sort(), [
      "blank-name",
      "repo-inspection",
    ]);
    // Version stays null when neither frontmatter nor the plugin supplies one.
    assert.deepEqual(
      sink.skills.map((s) => s.version),
      [null, null]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitPluginSkills skips a SKILL.md it cannot read and does not count it", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    return; // POSIX permission semantics only; root bypasses them.
  }
  const root = tempRoot("iss7686-unreadable-");
  const locked = writeSkill(root, "skills/locked", 'name: "locked"');
  try {
    writeSkill(root, "skills/readable", 'name: "readable"');
    chmodSync(locked, 0o000);
    const sink = new RecordingSink();

    const emitted = await emitPluginSkills({
      skillsRoot: path.join(root, "skills"),
      skillIdRoot: root,
      packId: "pack",
      sourceUrl: null,
      pluginVersion: null,
      sink,
    });

    // The unreadable file is walked (findSkillFiles saw it) but its read
    // returns null, so it is skipped — never emitted as a nameless row, and
    // never counted toward the caller's `skills` total.
    assert.equal(emitted, 1);
    assert.deepEqual(
      sink.skills.map((s) => s.name),
      ["readable"]
    );
  } finally {
    chmodSync(locked, 0o644); // restore so cleanup can remove it
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The two marketplace arms
// ---------------------------------------------------------------------------

test("scanBundledMarketplace writes ONE pack at the plugin cache root and aggregates every plugin's skills under it", async () => {
  const home = tempRoot("iss7686-home-");
  const previousHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  try {
    const cacheRoot = path.join(home, "plugins", "cache", "closedloop-ai");
    const alpha = path.join(cacheRoot, "alpha");
    const beta = path.join(cacheRoot, "beta");
    writeSkill(alpha, "skills/one", 'name: "one"');
    writeSkill(beta, "skills/two", 'name: "two"');
    const sink = new RecordingSink();

    const counts = await scanBundledMarketplace({
      marketplace: "closedloop-ai",
      plugins: [
        { pluginName: "alpha", installPath: alpha, version: "1.0.0" },
        { pluginName: "beta", installPath: beta, version: "1.1.0" },
        // Registered but not on disk — contributes nothing.
        {
          pluginName: "ghost",
          installPath: path.join(cacheRoot, "ghost"),
          version: null,
        },
      ],
      sourceUrl: CLOSEDLOOP_SOURCE,
      sink,
    });

    assert.deepEqual(counts, { installs: 1, skills: 2, plugins: 0 });
    assert.deepEqual(sink.packs, [
      {
        pack_id: "closedloop-ai",
        harness: "claude",
        install_path: cacheRoot,
        install_kind: "directory",
        source_url: CLOSEDLOOP_SOURCE,
        version: null,
      },
    ]);
    // Both plugins' skills carry the MARKETPLACE pack id, not their own.
    assert.deepEqual(
      new Set(sink.skills.map((s) => s.pack_id)),
      new Set(["closedloop-ai"])
    );
    // Emission order is the PLUGIN order the caller passed, not readdir order:
    // one skill dir per plugin, so this sequence is deterministic.
    assert.deepEqual(
      sink.skills.map((s) => s.name),
      ["one", "two"]
    );
  } finally {
    if (previousHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanBundledMarketplace still registers the pack when no plugin is on disk", async () => {
  const home = tempRoot("iss7686-home-empty-");
  const previousHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  try {
    const sink = new RecordingSink();
    const counts = await scanBundledMarketplace({
      marketplace: "closedloop-ai",
      plugins: [
        {
          pluginName: "ghost",
          installPath: path.join(home, "nope"),
          version: null,
        },
      ],
      sourceUrl: null,
      sink,
    });

    assert.deepEqual(counts, { installs: 1, skills: 0, plugins: 0 });
    assert.equal(sink.packs.length, 1);
    assert.equal(sink.skills.length, 0);
  } finally {
    if (previousHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanPerPluginMarketplace writes one pack per plugin and skips reserved and off-disk plugins", async () => {
  const root = tempRoot("iss7686-arm-perplugin-");
  try {
    const superpowers = path.join(root, "superpowers");
    const gstack = path.join(root, "gstack");
    writeSkill(superpowers, "skills/deep", 'name: "deep"');
    writeSkill(gstack, "skills/plan", 'name: "plan"');
    const sink = new RecordingSink();

    const counts = await scanPerPluginMarketplace({
      plugins: [
        {
          pluginName: "superpowers",
          installPath: superpowers,
          version: "3.0.0",
        },
        // `gstack` has a dedicated first-party scanner — skipped here so its
        // rows are never double-counted, even though it IS on disk.
        { pluginName: "gstack", installPath: gstack, version: "0.1.0" },
        {
          pluginName: "ghost",
          installPath: path.join(root, "ghost"),
          version: null,
        },
      ],
      sourceUrl: OFFICIAL_SOURCE,
      sink,
    });

    assert.deepEqual(counts, { installs: 1, skills: 1, plugins: 1 });
    assert.deepEqual(sink.packs, [
      {
        pack_id: "superpowers",
        harness: "claude",
        install_path: superpowers,
        install_kind: "directory",
        source_url: OFFICIAL_SOURCE,
        version: "3.0.0",
      },
    ]);
    assert.deepEqual(
      sink.skills.map((s) => s.pack_id),
      ["superpowers"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// scanClaudeMarketplaces — the composed projection
// ---------------------------------------------------------------------------

test("scanClaudeMarketplaces folds both arms, skips reserved marketplaces, and ticks marketplaces per marketplace", async () => {
  const home = tempRoot("iss7686-scan-home-");
  const previousHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  try {
    const cacheRoot = path.join(home, "plugins", "cache", "closedloop-ai");
    const alpha = path.join(cacheRoot, "alpha");
    const beta = path.join(cacheRoot, "beta");
    const superpowers = path.join(home, "elsewhere", "superpowers");
    const zeta = path.join(home, "elsewhere", "zeta");
    const gstack = path.join(home, "elsewhere", "gstack");
    writeSkill(alpha, "skills/one", 'name: "one"');
    writeSkill(beta, "skills/two", null); // no frontmatter → name from dir
    writeSkill(superpowers, "skills/deep", 'name: "deep"');
    writeSkill(zeta, "skills/zed", 'name: "zed"');
    writeSkill(gstack, "skills/plan", 'name: "plan"');

    mkdirSync(path.join(home, "plugins"), { recursive: true });
    writeFileSync(
      path.join(home, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "alpha@closedloop-ai": [{ installPath: alpha, version: "1.0.0" }],
          "beta@closedloop-ai": [{ installPath: beta, version: "1.1.0" }],
          "superpowers@claude-plugins-official": [
            { installPath: superpowers, version: "3.0.0" },
          ],
          "zeta@indie-marketplace": [{ installPath: zeta, version: null }],
          // Reserved PLUGIN id inside a normal marketplace: no rows, but the
          // marketplace itself still counts as seen.
          "gstack@some-marketplace": [
            { installPath: gstack, version: "0.1.0" },
          ],
          // Reserved MARKETPLACE: skipped before either arm runs.
          "anything@bmad-method": [{ installPath: alpha, version: null }],
          // Harness-direct install: never a pack.
          solo: [{ installPath: alpha, version: null }],
        },
      })
    );

    const sink = new RecordingSink();
    const counts = await scanClaudeMarketplaces(sink);

    assert.deepEqual(counts, {
      installs: 3, // closedloop-ai bundle + superpowers + zeta
      skills: 4, // one + two (bundled) + deep + zed
      marketplaces: 4, // closedloop-ai, claude-plugins-official, indie-marketplace, some-marketplace
      plugins: 2, // the dead counter: per-plugin arm only (superpowers + zeta)
    });

    assert.deepEqual(
      sink.packs.map((p) => [p.pack_id, p.install_path, p.source_url]),
      [
        ["closedloop-ai", cacheRoot, CLOSEDLOOP_SOURCE],
        ["superpowers", superpowers, OFFICIAL_SOURCE],
        // An unlisted marketplace still registers; it just gets no source url.
        ["zeta", zeta, null],
      ]
    );
    // Order is part of the contract — the sink replays in emission order and
    // dedupes last-write-wins. One skill dir per plugin means the sequence is
    // fully determined by registry order, so pin it rather than sorting.
    assert.deepEqual(
      sink.skills.map((s) => [s.pack_id, s.name]),
      [
        ["closedloop-ai", "one"],
        ["closedloop-ai", "two"],
        ["superpowers", "deep"],
        ["zeta", "zed"],
      ]
    );
    // The bundled arm keys its skill ids off the shared cache root, not the
    // per-plugin install path that produced the file.
    const one = sink.skills.find((s) => s.name === "one");
    assert.equal(
      one?.skill_id,
      deterministicSkillId("claude", cacheRoot, "one")
    );
  } finally {
    if (previousHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanClaudeMarketplaces treats prototype-like marketplace names as unknown", async () => {
  const home = tempRoot("iss7969-scan-home-");
  const previousHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  try {
    const constructorPlugin = path.join(home, "constructor-plugin");
    const protoPlugin = path.join(home, "proto-plugin");
    const officialPlugin = path.join(home, "official-plugin");
    mkdirSync(constructorPlugin, { recursive: true });
    mkdirSync(protoPlugin, { recursive: true });
    mkdirSync(officialPlugin, { recursive: true });

    mkdirSync(path.join(home, "plugins"), { recursive: true });
    writeFileSync(
      path.join(home, "plugins", "installed_plugins.json"),
      JSON.stringify({
        plugins: {
          "constructor-plugin@constructor": [
            { installPath: constructorPlugin, version: "1.0.0" },
          ],
          "proto-plugin@__proto__": [
            { installPath: protoPlugin, version: "1.0.0" },
          ],
          "official-plugin@claude-plugins-official": [
            { installPath: officialPlugin, version: "1.0.0" },
          ],
        },
      })
    );

    const sink = new RecordingSink();
    await scanClaudeMarketplaces(sink);

    assert.deepEqual(
      sink.packs.map((pack) => [pack.pack_id, pack.source_url]),
      [
        ["constructor-plugin", null],
        ["proto-plugin", null],
        ["official-plugin", OFFICIAL_SOURCE],
      ]
    );
  } finally {
    if (previousHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("scanClaudeMarketplaces reports zeros and emits nothing when the registry is unreadable", async () => {
  const home = tempRoot("iss7686-scan-corrupt-");
  const previousHome = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  try {
    mkdirSync(path.join(home, "plugins"), { recursive: true });
    // Present but corrupt: NOT authoritative, so the projection must no-op
    // rather than reconcile the inventory to zero.
    writeFileSync(
      path.join(home, "plugins", "installed_plugins.json"),
      "{ oops"
    );

    const sink = new RecordingSink();
    const counts = await scanClaudeMarketplaces(sink);

    assert.deepEqual(counts, { installs: 0, skills: 0, marketplaces: 0 });
    assert.equal(sink.packs.length, 0);
    assert.equal(sink.skills.length, 0);
  } finally {
    if (previousHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
