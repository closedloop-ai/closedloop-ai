/**
 * @file plugin-child-kind-parity.test.ts
 * @description ISS-6094 — the plugin child-kind list must be ONE list.
 *
 * `backfillChildPackIds` (src/main/packs/component-scanner.ts) is what STAMPS
 * `agent_components.pack_id` on a child. Three rollup readers
 * (src/main/dashboard/shared-agent-components-api.ts) and the cloud's
 * `loadChildInventoryJoin` then JOIN on that column, filtered by their own kind
 * list. The backfill's list was `('skill', 'command')` while every reader's was
 * `('skill', 'command', 'subagent', 'mcp')`, so a subagent or MCP child could
 * never be stamped, could never be joined, and every plugin whose children are
 * subagents or MCP servers rolled up to a permanent zero — with nothing red.
 *
 * These tests execute the real production backfill against a real store and
 * assert the OBSERVABLE consequence: the set of kinds it stamps is exactly
 * `PLUGIN_CHILD_KINDS`, the shared constant both sides now read. Narrow either
 * list and the sets stop matching, here, before it reaches a user.
 *
 * Deliberately NOT a source scan (banned by scripts/lint/rules/no-raw-text-source-scan.ts,
 * and it would pass while the behaviour was broken): every case seeds the
 * PRE-backfill state — children with a NULL `pack_id`, exactly as the scanner
 * finds them — and reads back what production actually wrote. The exceptions are
 * the uninstall cases, which deliberately start from a link an earlier ACTIVE
 * scan stamped, because that is the only state in which a stale `pack_id` is
 * reachable.
 *
 * The wiring that makes any of this run on a user's machine —
 * `runPackScanPostSteps` invoking `projectPacksToComponents` — is pinned
 * separately in `pack-scan-post-steps.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentComponentKind,
  Harness,
  PLUGIN_CHILD_KINDS,
} from "@repo/api/src/types/agent-component";
import { projectPacksToComponents } from "../src/main/packs/component-scanner.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const PACK_ID = "closedloop-ai";
const PACK_HARNESS = Harness.Claude;
/** Synthetic relative paths — the heuristic only compares the string. */
const PACK_PATH = "plugins/cache/closedloop-ai";
const OUTSIDE_PATH = "repos/some-other-project";

type OpenedPrisma = Awaited<ReturnType<typeof openTestPrisma>>;

/** A child row as the scanner finds it BEFORE any backfill: pack_id IS NULL. */
type SeedChild = {
  kind: string;
  key: string;
  installPath: string;
};

async function seedPack(
  opened: OpenedPrisma,
  pack: { packId: string; installPath: string; uninstalledAt?: string | null }
): Promise<void> {
  await opened.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_packs
         (pack_id, harness, install_path, install_kind, source_url, version,
          detected_at, last_seen_at, uninstalled_at)
       VALUES ($1, $2, $3, NULL, NULL, NULL, NULL, NULL, $4)`,
      pack.packId,
      PACK_HARNESS,
      pack.installPath,
      pack.uninstalledAt ?? null
    )
  );
}

async function seedChildren(
  opened: OpenedPrisma,
  children: readonly SeedChild[]
): Promise<void> {
  for (const child of children) {
    await opened.prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, name,
            install_path, pack_id)
         VALUES ($1, $2, $1, $3, $3, $4, NULL)`,
        `${child.kind}:${child.key}`,
        child.kind,
        child.key,
        child.installPath
      )
    );
  }
}

async function readStampedKinds(opened: OpenedPrisma): Promise<string[]> {
  const rows = await opened.prisma.client.$queryRawUnsafe<
    { componentKind: string }[]
  >(
    `SELECT DISTINCT component_kind AS "componentKind"
       FROM agent_components
      WHERE pack_id IS NOT NULL
        AND component_kind != $1
      ORDER BY component_kind ASC`,
    AgentComponentKind.Plugin
  );
  return rows.map((row) => row.componentKind);
}

async function readPackIdByKey(
  opened: OpenedPrisma
): Promise<Map<string, string | null>> {
  const rows = await opened.prisma.client.$queryRawUnsafe<
    { componentKey: string | null; packId: string | null }[]
  >(
    `SELECT component_key AS "componentKey", pack_id AS "packId"
       FROM agent_components
      WHERE component_kind != $1`,
    AgentComponentKind.Plugin
  );
  return new Map(rows.map((row) => [row.componentKey ?? "", row.packId]));
}

/**
 * One child of EVERY kind the readers roll up, plus two kinds they do not, all
 * nested under the pack's install path so the path heuristic matches each.
 */
const ALL_KIND_CHILDREN: readonly SeedChild[] = [
  ...PLUGIN_CHILD_KINDS.map((kind) => ({
    kind,
    key: `${kind}-child`,
    installPath: `${PACK_PATH}/${kind}s/${kind}-child`,
  })),
  // NOT rollup children: a plugin's usage never sums these, so stamping them
  // would attribute usage the readers cannot see.
  {
    kind: AgentComponentKind.Hook,
    key: "hook-child",
    installPath: `${PACK_PATH}/hooks/hook-child`,
  },
  {
    kind: AgentComponentKind.Tool,
    key: "tool-child",
    installPath: `${PACK_PATH}/tools/tool-child`,
  },
];

test("backfillChildPackIds stamps EVERY kind the rollups join — subagent and mcp included", async () => {
  const opened = await openTestPrisma();
  try {
    await seedPack(opened, { packId: PACK_ID, installPath: PACK_PATH });
    await seedChildren(opened, ALL_KIND_CHILDREN);

    await projectPacksToComponents(opened.prisma);

    // The observable parity assertion: what the backfill stamped is exactly the
    // list the readers join. Narrowing either side breaks this equality.
    assert.deepEqual(
      await readStampedKinds(opened),
      [...PLUGIN_CHILD_KINDS].sort(),
      "the kinds the backfill stamps must equal PLUGIN_CHILD_KINDS"
    );

    const byKey = await readPackIdByKey(opened);
    for (const kind of PLUGIN_CHILD_KINDS) {
      assert.equal(
        byKey.get(`${kind}-child`),
        PACK_ID,
        `${kind} child must be linked to its plugin`
      );
    }
    // A kind the rollups do not join must stay unlinked — stamping it would
    // create a pack_id no reader can attribute.
    assert.equal(byKey.get("hook-child"), null);
    assert.equal(byKey.get("tool-child"), null);
  } finally {
    await opened.close();
  }
});

test("backfillChildPackIds leaves children outside the pack's install path unlinked", async () => {
  const opened = await openTestPrisma();
  try {
    await seedPack(opened, { packId: PACK_ID, installPath: PACK_PATH });
    await seedChildren(opened, [
      {
        kind: AgentComponentKind.Subagent,
        key: "inside",
        installPath: `${PACK_PATH}/agents/inside`,
      },
      {
        kind: AgentComponentKind.Subagent,
        key: "outside",
        installPath: `${OUTSIDE_PATH}/.claude/agents/outside`,
      },
    ]);

    await projectPacksToComponents(opened.prisma);

    const byKey = await readPackIdByKey(opened);
    assert.equal(byKey.get("inside"), PACK_ID);
    assert.equal(
      byKey.get("outside"),
      null,
      "a repo-local subagent must not be swept into a plugin by the widened kind list"
    );
  } finally {
    await opened.close();
  }
});

test("a child matching two nested packs is attributed to exactly one, not double-linked", async () => {
  const opened = await openTestPrisma();
  try {
    // The same child appears in BOTH packs' prefix match — `outer` is a prefix
    // of `inner`, so `install_path LIKE 'outer%'` and `LIKE 'inner%'` both hit
    // it. `pack_id` is a single column, so the row can only carry one pack:
    // this asserts the write is last-writer-wins and total, never a duplicated
    // or half-written row, which is what a rollup grouped by pack_id needs.
    await seedPack(opened, { packId: "outer", installPath: `${PACK_PATH}` });
    await seedPack(opened, {
      packId: "inner",
      installPath: `${PACK_PATH}/nested`,
    });
    await seedChildren(opened, [
      {
        kind: AgentComponentKind.Mcp,
        key: "shared-child",
        installPath: `${PACK_PATH}/nested/mcp/shared-child`,
      },
    ]);

    await projectPacksToComponents(opened.prisma);

    const rows = await opened.prisma.client.$queryRawUnsafe<
      { packId: string | null }[]
    >(
      `SELECT pack_id AS "packId" FROM agent_components WHERE component_key = $1`,
      "shared-child"
    );
    assert.equal(rows.length, 1, "the child must remain a single row");
    assert.equal(
      rows[0].packId,
      "inner",
      "the deepest matching pack owns the child, not whichever id sorts later"
    );
  } finally {
    await opened.close();
  }
});

test("a pack does NOT claim a sibling whose directory name merely shares its prefix", async () => {
  const opened = await openTestPrisma();
  try {
    // `git` vs `git-flow` under one cache root — the shape a bare
    // `LIKE '<installPath>%'` silently mis-matched, rolling one plugin's usage
    // into another. Widening the kind list is what exposed subagent/mcp
    // children to it, so the anchor is guarded here rather than assumed.
    await seedPack(opened, { packId: "git", installPath: `${PACK_PATH}/git` });
    await seedChildren(opened, [
      {
        kind: AgentComponentKind.Subagent,
        key: "own-child",
        installPath: `${PACK_PATH}/git/agents/own-child`,
      },
      {
        kind: AgentComponentKind.Subagent,
        key: "sibling-child",
        installPath: `${PACK_PATH}/git-flow/agents/sibling-child`,
      },
      {
        kind: AgentComponentKind.Mcp,
        key: "at-pack-root",
        installPath: `${PACK_PATH}/git`,
      },
    ]);

    await projectPacksToComponents(opened.prisma);

    const byKey = await readPackIdByKey(opened);
    assert.equal(byKey.get("own-child"), "git");
    // The pack's own directory still counts as belonging to the pack.
    assert.equal(byKey.get("at-pack-root"), "git");
    assert.equal(
      byKey.get("sibling-child"),
      null,
      "`git` must not claim `git-flow`'s children on a bare string prefix"
    );
  } finally {
    await opened.close();
  }
});

test("LIKE metacharacters in a pack's install path are matched literally", async () => {
  const opened = await openTestPrisma();
  try {
    // `_` is an ordinary character in a directory name and a single-character
    // wildcard to LIKE, so an unescaped prefix would let `my_plugin` claim
    // `myXplugin`'s children.
    await seedPack(opened, {
      packId: "underscored",
      installPath: `${PACK_PATH}/my_plugin`,
    });
    await seedChildren(opened, [
      {
        kind: AgentComponentKind.Skill,
        key: "literal-match",
        installPath: `${PACK_PATH}/my_plugin/skills/literal-match`,
      },
      {
        kind: AgentComponentKind.Skill,
        key: "wildcard-match",
        installPath: `${PACK_PATH}/myXplugin/skills/wildcard-match`,
      },
    ]);

    await projectPacksToComponents(opened.prisma);

    const byKey = await readPackIdByKey(opened);
    assert.equal(byKey.get("literal-match"), "underscored");
    assert.equal(
      byKey.get("wildcard-match"),
      null,
      "`_` in the install path must be a literal, not a LIKE wildcard"
    );
  } finally {
    await opened.close();
  }
});

test("a pack root stored with a trailing separator still claims its children", async () => {
  const opened = await openTestPrisma();
  try {
    // The registry accepts the raw non-empty installPath while child rows carry
    // `path.join`-normalized paths, so a root stored as `…/trailing/` used to
    // build the prefix `…/trailing//%` and match none of its own children.
    // The normal (separator-less) root is asserted in the same case so the fix
    // cannot be "normalize" in one direction only.
    await seedPack(opened, {
      packId: "trailing",
      installPath: `${PACK_PATH}/trailing/`,
    });
    await seedPack(opened, {
      packId: "plain",
      installPath: `${PACK_PATH}/plain`,
    });
    await seedChildren(opened, [
      {
        kind: AgentComponentKind.Skill,
        key: "trailing-child",
        installPath: `${PACK_PATH}/trailing/skills/trailing-child`,
      },
      {
        kind: AgentComponentKind.Mcp,
        key: "trailing-at-root",
        installPath: `${PACK_PATH}/trailing`,
      },
      {
        kind: AgentComponentKind.Skill,
        key: "plain-child",
        installPath: `${PACK_PATH}/plain/skills/plain-child`,
      },
      {
        kind: AgentComponentKind.Skill,
        key: "trailing-sibling",
        installPath: `${PACK_PATH}/trailing-x/skills/trailing-sibling`,
      },
    ]);

    await projectPacksToComponents(opened.prisma);

    const byKey = await readPackIdByKey(opened);
    assert.equal(
      byKey.get("trailing-child"),
      "trailing",
      "a trailing separator on the stored root must not orphan the pack's children"
    );
    assert.equal(
      byKey.get("trailing-at-root"),
      "trailing",
      "…nor break the pack's own directory match"
    );
    assert.equal(byKey.get("plain-child"), "plain");
    assert.equal(
      byKey.get("trailing-sibling"),
      null,
      "normalizing the root must not re-open the prefix-sibling mis-claim"
    );
  } finally {
    await opened.close();
  }
});

test("the winner of an overlapping claim is the same on every scan", async () => {
  const opened = await openTestPrisma();
  try {
    // Two packs can both claim a nested child; the backfill is last-writer-wins
    // over an explicit shallowest-first order, so the winner cannot flip between
    // scans — a flapping pack_id would move a plugin's invocations to a
    // different plugin between dashboard refreshes, with no error anywhere.
    await seedPack(opened, { packId: "outer", installPath: PACK_PATH });
    await seedPack(opened, {
      packId: "inner",
      installPath: `${PACK_PATH}/nested`,
    });
    await seedChildren(opened, [
      {
        kind: AgentComponentKind.Mcp,
        key: "shared-child",
        installPath: `${PACK_PATH}/nested/mcp/shared-child`,
      },
    ]);

    await projectPacksToComponents(opened.prisma);
    const first = (await readPackIdByKey(opened)).get("shared-child");
    await projectPacksToComponents(opened.prisma);
    const second = (await readPackIdByKey(opened)).get("shared-child");
    await projectPacksToComponents(opened.prisma);
    const third = (await readPackIdByKey(opened)).get("shared-child");

    assert.equal(first, "inner", "the deepest matching pack wins the claim");
    assert.equal(second, first, "the winner must not flip on a re-scan");
    assert.equal(third, first, "…nor on any later re-scan");
  } finally {
    await opened.close();
  }
});

test("an ancestor pack keyed on a shared root does not steal a nested pack's child", async () => {
  const opened = await openTestPrisma();
  try {
    // The real shape this protects: `scanGStack` keys the Codex gstack row on
    // the WHOLE `~/.codex/skills` root, not on a leaf directory, so it prefix-
    // matches every child of every pack installed beneath it. Under a packId
    // ordering, `gstack` wins every such child whose owner's id sorts earlier —
    // and `aardvark` sorts earlier, so its own skill was rolled into gstack.
    const codexSkillsRoot = "codex/skills";
    await seedPack(opened, {
      packId: "gstack",
      installPath: codexSkillsRoot,
    });
    await seedPack(opened, {
      packId: "aardvark",
      installPath: `${codexSkillsRoot}/aardvark`,
    });
    await seedChildren(opened, [
      {
        kind: AgentComponentKind.Skill,
        key: "aardvark-skill",
        installPath: `${codexSkillsRoot}/aardvark/skills/aardvark-skill`,
      },
      // A skill that really does live directly under the shared root still
      // belongs to the pack keyed on that root.
      {
        kind: AgentComponentKind.Skill,
        key: "gstack-ship",
        installPath: `${codexSkillsRoot}/gstack-ship`,
      },
    ]);

    await projectPacksToComponents(opened.prisma);

    const byKey = await readPackIdByKey(opened);
    assert.equal(
      byKey.get("aardvark-skill"),
      "aardvark",
      "the pack the child actually lives in must own it, not the ancestor root"
    );
    assert.equal(
      byKey.get("gstack-ship"),
      "gstack",
      "…and the root-keyed pack still owns what is genuinely beneath it"
    );
  } finally {
    await opened.close();
  }
});

async function tombstonePack(
  opened: OpenedPrisma,
  packId: string,
  uninstalledAt = "2026-08-12T00:00:00.000Z"
): Promise<void> {
  await opened.prisma.write((client) =>
    client.$executeRawUnsafe(
      "UPDATE agent_packs SET uninstalled_at = $1 WHERE pack_id = $2",
      uninstalledAt,
      packId
    )
  );
}

test("a rescan after an uninstall clears the link the active scan stamped", async () => {
  const opened = await openTestPrisma();
  try {
    // The active→uninstalled transition, which is the only way the stale-link
    // bug is reachable: starting from NULL (every other case here) can never
    // observe it, because a tombstoned pack is simply skipped.
    await seedPack(opened, { packId: PACK_ID, installPath: PACK_PATH });
    await seedChildren(opened, ALL_KIND_CHILDREN);

    await projectPacksToComponents(opened.prisma);
    assert.deepEqual(
      await readStampedKinds(opened),
      [...PLUGIN_CHILD_KINDS].sort(),
      "precondition: the active scan links every rollup child kind"
    );

    // A re-scan with the pack still installed must NOT drop the links — the
    // reconciliation is keyed on the tombstone, not on "we re-ran".
    await projectPacksToComponents(opened.prisma);
    assert.deepEqual(
      await readStampedKinds(opened),
      [...PLUGIN_CHILD_KINDS].sort(),
      "an installed pack keeps its children across a re-scan"
    );

    await tombstonePack(opened, PACK_ID);
    await projectPacksToComponents(opened.prisma);

    assert.deepEqual(
      await readStampedKinds(opened),
      [],
      "an uninstalled pack must not keep rolling up its ex-children's usage"
    );
    const byKey = await readPackIdByKey(opened);
    for (const kind of PLUGIN_CHILD_KINDS) {
      assert.equal(byKey.get(`${kind}-child`), null);
    }
  } finally {
    await opened.close();
  }
});

test("uninstalling one pack clears only ITS children, not a sibling pack's", async () => {
  const opened = await openTestPrisma();
  try {
    // Both directions in one pass: the reconciliation is keyed on the tombstoned
    // pack's own id, so it must clear that pack's links and leave every other
    // installed pack's links exactly where they were.
    await seedPack(opened, {
      packId: "gone",
      installPath: `${PACK_PATH}/gone`,
    });
    await seedPack(opened, {
      packId: "stays",
      installPath: `${PACK_PATH}/stays`,
    });
    await seedChildren(opened, [
      {
        kind: AgentComponentKind.Subagent,
        key: "gone-child",
        installPath: `${PACK_PATH}/gone/agents/gone-child`,
      },
      {
        kind: AgentComponentKind.Subagent,
        key: "stays-child",
        installPath: `${PACK_PATH}/stays/agents/stays-child`,
      },
    ]);

    await projectPacksToComponents(opened.prisma);
    const before = await readPackIdByKey(opened);
    assert.equal(before.get("gone-child"), "gone");
    assert.equal(before.get("stays-child"), "stays");

    await tombstonePack(opened, "gone");
    await projectPacksToComponents(opened.prisma);

    const after = await readPackIdByKey(opened);
    assert.equal(
      after.get("gone-child"),
      null,
      "the uninstalled pack's child must be unlinked"
    );
    assert.equal(
      after.get("stays-child"),
      "stays",
      "an installed pack's child must survive a neighbour's uninstall"
    );
  } finally {
    await opened.close();
  }
});

test("an uninstalled pack links nothing, whatever the kind list says", async () => {
  const opened = await openTestPrisma();
  try {
    await seedPack(opened, {
      packId: PACK_ID,
      installPath: PACK_PATH,
      uninstalledAt: "2026-08-12T00:00:00.000Z",
    });
    await seedChildren(opened, ALL_KIND_CHILDREN);

    await projectPacksToComponents(opened.prisma);

    assert.deepEqual(
      await readStampedKinds(opened),
      [],
      "widening the kind list must not start linking children of uninstalled packs"
    );
  } finally {
    await opened.close();
  }
});
