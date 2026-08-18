/**
 * @file definition-content-collector-command-key.test.ts
 * @description ISS-4795 — leading-slash command frontmatter through BOTH
 * definition-collector producers.
 *
 * wongk (PR #4322): "Where's the regression that sends leading-slash frontmatter
 * through both collector paths? The current helper and live-materializer tests
 * stay green if either changed caller goes back to prefixing the slash."
 *
 * That is the gap this closes. The bug was NOT in the shared normalizer — it was
 * in two callers that hand-prepended `/` to a `baseName` a slash-command's
 * frontmatter `name` already starts with, minting `//build` here while the
 * invocation path minted `/build`. The helper's own unit tests and the
 * invocation-side identity test both stay green if either of these two callers
 * regresses to `` `/${baseName}` ``, because neither drives THIS file with
 * slash-bearing frontmatter. Each test below fails if its caller regresses:
 *
 *   1. the directory scan  (`collectDefinitionContent` → `discoverClaudeDir`)
 *   2. the focused read    (`captureInvocationDefinitionEvidence` →
 *                           `definitionNameFromContent`)
 *
 * and the last one pins that the two agree with each other, which is the actual
 * contract — one command, one component key, one usage population.
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createNormalizedSession,
  HarnessImportMode,
} from "@repo/lib/harness/types";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  captureInvocationDefinitionEvidence,
  collectDefinitionContent,
} from "../src/main/packs/definition-content-collector.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/** A command definition whose frontmatter `name` ALREADY carries the slash. */
const SLASH_FRONTMATTER = "---\nname: /build\n---\nShip it.\n";

/**
 * The focused read only accepts a definition it can prove was already on disk
 * when the command ran: `stableDefinitionSnapshot` requires
 * `mtime <= invokedAt <= capturedAt`. A freshly written temp file carries the
 * REAL wall clock, so a pinned `invokedAt` in the past would sit before the
 * file's own mtime and the snapshot would be (correctly) rejected — the test
 * would then read as "the collector found nothing" rather than exercising the
 * key normalization it exists to pin. Stamping the seeded file makes the whole
 * window deterministic instead of relative to when the suite happens to run.
 */
const DEFINITION_MTIME = "2026-07-22T10:00:00.000Z";
const INVOKED_AT = "2026-07-22T10:00:01.000Z";
const CAPTURED_AT = "2026-07-22T10:00:02.000Z";

type CommandRow = { external_id: string; component_key: string };

function queryCommandRows(prisma: DesktopPrisma): Promise<CommandRow[]> {
  return prisma.write((client) =>
    client.$queryRawUnsafe<CommandRow[]>(
      `SELECT external_id, component_key FROM agent_components
       WHERE component_kind = 'command' ORDER BY external_id`
    )
  );
}

function seedClaudeCommand(body: string): { root: string; file: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "cmdkey-"));
  const commandDir = path.join(root, ".claude", "commands");
  mkdirSync(commandDir, { recursive: true });
  const file = path.join(commandDir, "build.md");
  writeFileSync(file, body);
  const stamped = new Date(DEFINITION_MTIME);
  utimesSync(file, stamped, stamped);
  return { root, file };
}

test("ISS-4795 directory scan: slash-bearing frontmatter keys the command once", async () => {
  const { root } = seedClaudeCommand(SLASH_FRONTMATTER);
  const { prisma, close } = await openTestPrisma();
  try {
    await collectDefinitionContent(prisma, {
      claudeRoots: [path.join(root, ".claude")],
    });

    const rows = await queryCommandRows(prisma);

    assert.equal(rows.length, 1, "one command, not one per spelling");
    // The regression: `/${baseName}` over a `/build` frontmatter name.
    assert.equal(rows[0]?.external_id, "/build");
    assert.equal(rows[0]?.component_key, "/build");
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ISS-4795 directory scan: both spellings of one command collapse to one row", async () => {
  // The end state the bug produced: `/build` and `//build` as two components
  // splitting one usage population. Whatever the two files' frontmatter says,
  // the collector must land them on ONE identity.
  const root = mkdtempSync(path.join(os.tmpdir(), "cmdkey-both-"));
  const commandDir = path.join(root, ".claude", "commands");
  mkdirSync(commandDir, { recursive: true });
  writeFileSync(path.join(commandDir, "build.md"), SLASH_FRONTMATTER);
  const { prisma, close } = await openTestPrisma();
  try {
    await collectDefinitionContent(prisma, {
      claudeRoots: [path.join(root, ".claude")],
    });
    // A second pass over a bare-named twin must ATTACH to the same key rather
    // than mint a sibling.
    writeFileSync(
      path.join(commandDir, "build.md"),
      "---\nname: build\n---\nShip it.\n"
    );
    await collectDefinitionContent(prisma, {
      claudeRoots: [path.join(root, ".claude")],
    });

    const rows = await queryCommandRows(prisma);

    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.external_id, "/build");
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ISS-4795 focused read: slash-bearing frontmatter is not double-prefixed", () => {
  const { root, file } = seedClaudeCommand(SLASH_FRONTMATTER);
  try {
    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "slash-frontmatter-session",
        slashCommands: [{ name: "build", timestamp: INVOKED_AT }],
      }),
      {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { claudeRoots: [path.join(root, ".claude")] },
        now: () => new Date(CAPTURED_AT),
      }
    );

    assert.equal(evidence.length, 1);
    assert.equal(evidence[0]?.sourcePath, file);
    // The regression: `/${baseName}` over the `/build` frontmatter name.
    assert.equal(evidence[0]?.normalizedName, "/build");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ISS-4795 the two producers agree on the key for the same definition", async () => {
  // The contract proper. Either caller regressing on its own splits the
  // component in two, so the producers are compared against EACH OTHER rather
  // than each against a literal.
  const { root } = seedClaudeCommand(SLASH_FRONTMATTER);
  const { prisma, close } = await openTestPrisma();
  try {
    await collectDefinitionContent(prisma, {
      claudeRoots: [path.join(root, ".claude")],
    });
    const [scanned] = await queryCommandRows(prisma);

    const evidence = captureInvocationDefinitionEvidence(
      createNormalizedSession({
        sessionId: "parity-session",
        slashCommands: [{ name: "build", timestamp: INVOKED_AT }],
      }),
      {
        importMode: HarnessImportMode.LiveWatcher,
        roots: { claudeRoots: [path.join(root, ".claude")] },
        now: () => new Date(CAPTURED_AT),
      }
    );

    // Both producers must have PRODUCED something, or "they agree" would be
    // satisfied by two undefineds.
    assert.equal(scanned?.external_id, "/build");
    assert.equal(evidence.length, 1);
    assert.equal(scanned?.external_id, evidence[0]?.normalizedName);
  } finally {
    await close();
    rmSync(root, { recursive: true, force: true });
  }
});
