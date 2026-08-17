/**
 * @file definition-apply-path.test.ts
 * @description ISS-5274 — the DB half of the definition pipeline, exercised
 * through `applyDiscoveredDefinitions` directly: the entry point the db-host
 * uses to write a set the compute WORKER walked.
 *
 * Two properties have to hold on this path specifically, because it is the one
 * that no longer does its own walking:
 *
 *  1. The scope context must be carried across, not re-derived. Dropping
 *     `userScopeRoots` persists `scope = null` for every OpenCode user-global
 *     definition — the ISS-4386 regression — and it would be invisible, since
 *     the on-host fallback (which derives its own) only runs when this path
 *     already failed.
 *  2. `reconcileDefinitionAccessState` must still run here, or a previously
 *     `resolved` row whose file is gone would keep claiming to be resolved
 *     forever on the worker path.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Harness } from "@repo/api/src/types/agent-component";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  applyDiscoveredDefinitions,
  ComponentScope,
} from "../src/main/packs/definition-content-collector.js";
import type { DiscoveredDefinition } from "../src/main/packs/definition-variant-fold.js";
import { openTestPrisma } from "./prisma-test-utils.js";

function definition(overrides: Partial<DiscoveredDefinition> = {}): {
  primary: DiscoveredDefinition;
  variants: DiscoveredDefinition[];
} {
  return {
    primary: {
      kind: "subagent",
      externalId: "reviewer",
      name: "reviewer",
      installPath: "/tmp/agents/reviewer.md",
      content: "reviewer body",
      harness: Harness.Claude,
      ...overrides,
    },
    variants: [],
  };
}

function scopeOf(
  prisma: DesktopPrisma,
  externalId: string
): Promise<Array<{ scope: string | null; resolved_state: string }>> {
  return prisma.client.$queryRawUnsafe<
    Array<{ scope: string | null; resolved_state: string }>
  >(
    "SELECT scope, resolved_state FROM agent_components WHERE external_id = $1",
    externalId
  );
}

test("an OpenCode config-home definition applies as scope='user' through the precomputed path", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const openCodeHome = "/home/u/.config/opencode";
    const summary = await applyDiscoveredDefinitions(
      prisma,
      [
        definition({
          externalId: "oc-agent",
          name: "oc-agent",
          installPath: path.join(openCodeHome, "agents", "oc-agent.md"),
          harness: Harness.Opencode,
        }),
      ],
      // The context the db-host resolved and shipped alongside the walk. It is
      // NOT recomputed here — that is the point of carrying it.
      { homeDir: "/home/u", userScopeRoots: [openCodeHome] },
      new Date().toISOString()
    );

    assert.equal(summary.upserted, 1);
    const rows = await scopeOf(prisma, "oc-agent");
    // OpenCode's user-global home is not under `<home>/.claude`, so without
    // `userScopeRoots` this row persists `scope = null` and loses its user
    // provenance in sync (ISS-4386).
    assert.equal(rows[0]?.scope, ComponentScope.User);
  } finally {
    await close();
  }
});

test("dropping userScopeRoots would lose the user scope — the guard is load-bearing", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await applyDiscoveredDefinitions(
      prisma,
      [
        definition({
          externalId: "oc-agent-2",
          name: "oc-agent-2",
          installPath: "/home/u/.config/opencode/agents/oc-agent-2.md",
          harness: Harness.Opencode,
        }),
      ],
      // Same definition, context WITHOUT the OpenCode root.
      { homeDir: "/home/u", userScopeRoots: [] },
      new Date().toISOString()
    );

    const rows = await scopeOf(prisma, "oc-agent-2");
    // Pins that the previous test is actually exercising `userScopeRoots` and
    // not passing for some unrelated reason.
    assert.equal(rows[0]?.scope, null);
  } finally {
    await close();
  }
});

test("a project definition under an explicit projectPath applies as scope='project'", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await applyDiscoveredDefinitions(
      prisma,
      [
        definition({
          externalId: "proj-agent",
          name: "proj-agent",
          installPath: "/work/proj/.opencode/agents/proj-agent.md",
          projectPath: "/work/proj",
          harness: Harness.Opencode,
        }),
      ],
      {
        homeDir: "/home/u",
        userScopeRoots: ["/home/u/.config/opencode"],
      },
      new Date().toISOString()
    );

    assert.equal(
      (await scopeOf(prisma, "proj-agent"))[0]?.scope,
      ComponentScope.Project
    );
  } finally {
    await close();
  }
});

test("a resolved row absent from the applied set and gone from disk is demoted to missing", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "cl-def-apply-"));
  const { prisma, close } = await openTestPrisma();
  try {
    const gonePath = path.join(tmp, "deleted.md");
    const now = new Date().toISOString();
    // First pass: the file exists, so the row lands `resolved`.
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO agent_components
           (id, component_kind, external_id, component_key, name, install_path,
            resolved_state, first_seen_at, last_seen_at)
         VALUES ('deadbeef', 'subagent', 'ghost', 'ghost', 'ghost', $1,
                 'resolved', $2, $2)`,
        gonePath,
        now
      )
    );

    // Second pass: the worker walked and did NOT find it (the file is gone).
    await applyDiscoveredDefinitions(
      prisma,
      [definition()],
      { homeDir: "/home/u", userScopeRoots: [] },
      now
    );

    const rows = await scopeOf(prisma, "ghost");
    // Reconciliation must still run on the precomputed path, or a deleted
    // definition keeps claiming `resolved` forever whenever the worker path is
    // healthy — which is the normal case.
    assert.equal(rows[0]?.resolved_state, "missing");
  } finally {
    await close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
