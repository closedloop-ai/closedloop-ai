import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyPackScan,
  CollectingSink,
  detectClosedloopWebCommandPack,
} from "../src/main/packs/pack-scanner.js";
import { openTestPrisma } from "./prisma-test-utils.js";

type AgentPackRow = {
  pack_id: string;
  harness: string;
  install_kind: string;
  version: string | null;
};

test("bundled Closedloop Web Command Pack is detected as installed by default", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // FEA-3628: detectors now emit into a pure-compute sink; the db-host replays
    // the plan through applyPackScan. Exercise both halves here, then assert the
    // persisted rows rather than the raw SQL params.
    const sink = new CollectingSink([]);
    const detected = await detectClosedloopWebCommandPack(sink);
    assert.equal(detected, true);

    await applyPackScan(
      prisma,
      {
        plan: sink.toPlan(),
        counts: {
          gstack: { installs: 0, skills: 0 },
          bmad: { installs: 0, skills: 0, projects: 0 },
          marketplaces: { installs: 0, skills: 0, marketplaces: 0 },
          catalogDetectors: {},
          gstackProjects: 0,
        },
        // Leave scopes empty so applyPackScan does not prune — this test only
        // seeds the one bundled pack and asserts it persists.
        scopes: { catalogDetectors: false },
      },
      new Date().toISOString()
    );

    const rows = await prisma.client.$queryRawUnsafe<AgentPackRow[]>(
      `SELECT pack_id, harness, install_kind, version
       FROM agent_packs
       WHERE pack_id = $1
       ORDER BY harness ASC`,
      "closedloop-web-command-pack"
    );

    assert.deepEqual(
      rows.map((row) => row.harness),
      ["claude", "codex", "cursor", "opencode"]
    );
    assert.equal(rows[0]?.install_kind, "directory");
    assert.equal(rows[0]?.version, "1");
  } finally {
    await close();
  }
});
