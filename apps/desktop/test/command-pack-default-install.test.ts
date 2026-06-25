import assert from "node:assert/strict";
import { test } from "node:test";
import { detectClosedloopWebCommandPack } from "../src/main/packs/pack-scanner.js";
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
    // detectClosedloopWebCommandPack upserts the bundled pack through
    // prisma.write; assert the rows it persists rather than the raw SQL params.
    const detected = await detectClosedloopWebCommandPack(prisma);
    assert.equal(detected, true);

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
