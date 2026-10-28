import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SqliteAgentDatabase } from "../../src/main/database/sqlite.js";
import catalogSeed from "../../src/main/packs/catalog-seed.json" with {
  type: "json",
};
import {
  applyFetchResult,
  recordInstallRunEnd,
  recordInstallRunStart,
  upsertCatalogSeed,
} from "../../src/main/packs/catalog-store.js";
import { runPackScanner } from "../../src/main/packs/pack-scanner.js";

type PackSkill = { readonly name: string; readonly description: string };

/** Skills of the two catalog packs the scanner recognizes by layout. */
const GSTACK_SKILLS: readonly PackSkill[] = [
  {
    name: "plan-ceo-review",
    description: "Founder-mode review of a plan before any code is written.",
  },
  {
    name: "plan-eng-review",
    description:
      "Engineering-manager review of architecture, data flow and edge cases.",
  },
  {
    name: "review",
    description: "Pre-landing review of the current branch's diff.",
  },
  {
    name: "ship",
    description: "Sync main, run tests, bump the version and open the PR.",
  },
  {
    name: "qa",
    description: "Exercise the running app in a browser and report what broke.",
  },
  {
    name: "retro",
    description: "Weekly engineering retrospective from commit history.",
  },
];
const BMAD_SKILLS: readonly PackSkill[] = [
  {
    name: "bmad-analyst",
    description: "Turn a raw idea into a project brief.",
  },
  {
    name: "bmad-pm",
    description: "Draft a PRD with epics and stories from the brief.",
  },
  {
    name: "bmad-architect",
    description: "Produce the architecture document for the PRD.",
  },
  {
    name: "bmad-dev",
    description:
      "Implement one story at a time against its acceptance criteria.",
  },
];

const GSTACK_VERSION = "1.40.0.0";
const BMAD_VERSION = "6.0.0";
const CATALOG_HISTORY_DAYS = 30;
const DAY_MS = 86_400_000;

export type PackSeedCounts = {
  readonly catalogRows: number;
  readonly packs: number;
  readonly skills: number;
  readonly installRuns: number;
};

/**
 * Packs the way a user gets them: the bundled catalog seed applied with the
 * startup op's own function (`upsertCatalogSeed`), a gstack and a BMad install
 * laid out in the profile's collector homes and found by the production pack
 * scanner (which also runs on every launch, so the rows persist), the
 * fetcher's stats write (`applyFetchResult`), and the install audit log the
 * install flow writes.
 */
export async function seedPacks(
  db: SqliteAgentDatabase,
  homes: { claudeHome: string; codexHome: string },
  now: Date
): Promise<PackSeedCounts> {
  writeGstackInstall(homes.claudeHome, homes.codexHome);
  writeBmadInstall(homes.claudeHome);
  const catalog = await upsertCatalogSeed(db.prisma, catalogSeed);
  const scan = await runPackScanner(db.prisma);
  if (!(scan.scopes.gstack && scan.scopes.bmad)) {
    throw new Error(
      `pack scanner failed a scope: ${JSON.stringify(scan.scopes)}`
    );
  }
  await seedCatalogStats(db, now);
  const installRuns = await seedInstallRuns(db);
  return {
    catalogRows: catalog.inserted + catalog.updated,
    packs: scan.gstack.installs + scan.bmad.installs,
    skills: scan.gstack.skills + scan.bmad.skills,
    installRuns,
  };
}

function writeGstackInstall(claudeHome: string, codexHome: string): void {
  const root = path.join(claudeHome, "skills", "gstack");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "VERSION"), `${GSTACK_VERSION}\n`);
  for (const skill of GSTACK_SKILLS) {
    writeSkill(path.join(root, skill.name), skill);
  }
  initGitRemote(root, "https://github.com/garrytan/gstack.git");
  const codexSkills = path.join(codexHome, "skills");
  mkdirSync(codexSkills, { recursive: true });
  for (const skill of GSTACK_SKILLS) {
    symlinkSync(
      path.join(root, skill.name),
      path.join(codexSkills, `gstack-${skill.name}`),
      "dir"
    );
  }
}

function writeBmadInstall(claudeHome: string): void {
  const root = path.join(claudeHome, "skills", "bmad-method");
  mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    path.join(root, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify({ name: "bmad-method", version: BMAD_VERSION }, null, 2)}\n`
  );
  for (const skill of BMAD_SKILLS) {
    writeSkill(path.join(root, "skills", skill.name), skill);
  }
  initGitRemote(root, "https://github.com/bmad-code-org/BMAD-METHOD.git");
}

function writeSkill(dir: string, skill: PackSkill): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n# ${skill.name}\n\n${skill.description}\n`
  );
}

/** The scanner records `git remote get-url origin` as the pack's source. */
function initGitRemote(dir: string, remoteUrl: string): void {
  for (const args of [
    ["init", "-q"],
    ["remote", "add", "origin", remoteUrl],
  ]) {
    const result = spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed in ${dir}`);
    }
  }
}

/**
 * The newest sample is the fetcher's own write; the 29 days before it are
 * inserted directly because `applyFetchResult` stamps the wall clock and the
 * catalog's 30-day star history cannot otherwise exist on a fresh profile.
 */
async function seedCatalogStats(
  db: SqliteAgentDatabase,
  now: Date
): Promise<void> {
  const packs = catalogSeed.packs.filter((pack) => pack.github_url.length > 0);
  const history: {
    packId: string;
    fetchedAt: string;
    stars: number;
    forks: number;
  }[] = [];
  for (const pack of packs) {
    const base = stableNumber(pack.pack_id, 400, 40_000);
    for (let day = CATALOG_HISTORY_DAYS - 1; day >= 1; day -= 1) {
      history.push({
        packId: pack.pack_id,
        fetchedAt: new Date(now.getTime() - day * DAY_MS).toISOString(),
        stars: Math.round(base * (1 - day * 0.004)),
        forks: Math.round((base / 9) * (1 - day * 0.003)),
      });
    }
  }
  await db.prisma.write((client) =>
    client.packCatalogHistory.createMany({ data: history })
  );
  for (const pack of packs) {
    const base = stableNumber(pack.pack_id, 400, 40_000);
    await applyFetchResult(db.prisma, {
      pack_id: pack.pack_id,
      stars: base,
      forks: Math.round(base / 9),
      description: pack.description,
    });
  }
}

async function seedInstallRuns(db: SqliteAgentDatabase): Promise<number> {
  const installs = catalogSeed.packs.filter(
    (pack) => pack.pack_id === "gstack" || pack.pack_id === "bmad-method"
  );
  for (const pack of installs) {
    const command = pack.install_commands?.claude;
    if (typeof command !== "string") {
      throw new Error(
        `catalog seed has no claude install command for ${pack.pack_id}`
      );
    }
    const id = await recordInstallRunStart(db.prisma, {
      pack_id: pack.pack_id,
      harness: "claude",
      action: "install",
      command,
    });
    await recordInstallRunEnd(db.prisma, id, {
      exit_code: 0,
      stdout_tail: `Installed ${pack.display_name}.`,
    });
  }
  return installs.length;
}

function stableNumber(key: string, min: number, max: number): number {
  const digest = createHash("sha256").update(key).digest();
  return min + (digest.readUInt32BE(0) % (max - min));
}
