/**
 * @file agent-components-honest-source.test.ts
 * @description ISS-5009: the desktop-local reader's HONEST Source projection
 * (`AgentComponent.honestSource`), driven end to end through
 * `listAgentComponentsLocal`.
 *
 * The legacy `source` chain ends at `install_path ?? external_id`, so a row with
 * no real provenance renders the component's own identifier in the catalog's
 * Source column. `honestSource` says whether that fallback fired. These assert
 * the PRODUCER: the legacy pair must stay byte-identical (that IS the flag-OFF
 * render, and old clients sort on it) while the honest projection reports what
 * the row actually knows.
 *
 * Its own file, not an addition to `shared-agent-components-api.test.ts`, which
 * is over the 1,000-line ceiling and shrink-only. The seed helpers are imported
 * from the shared fixture module rather than copied.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { honestSourceOf } from "../src/main/dashboard/agent-component-honest-source.js";
import { listAgentComponentsLocal } from "../src/main/dashboard/shared-agent-components-api.js";
import {
  insertComponent,
  insertUsage,
} from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const REPO_URL = "https://github.com/closedloop-ai/claude-plugins";
const PLUGIN_REPO_URL = "https://github.com/closedloop-ai/code-review-plugin";
const LEGACY_SOURCE_URL = "https://github.com/closedloop-ai/legacy-source";

/**
 * CROSS-SURFACE PARITY — what the CLOUD resolver answers for these same rows.
 *
 * The two surfaces are pinned to ONE answer, and the wire that makes them the
 * same row is `mapAgentComponentToSynced`
 * (`apps/desktop/src/main/database/component-sync-source.ts`), which maps desktop
 * `row.source_url` -> the cloud's `sourceUrl` and desktop `row.pack_id` ->
 * `packId`. Cloud runs the same ordered switch (pack-minus-echo, then
 * `sourceUrl`, then project, then scope, else nothing).
 *
 *  - `source_url` only            -> cloud `{true, sourceUrl, Repo}`; desktop must match.
 *  - pack_id == key + `source_url`-> cloud rejects the pack echo, then hits its
 *    `sourceUrl` branch: `{true, sourceUrl, Repo}`. Desktop must match. This is
 *    the pair that DIVERGED before the fix (desktop said `{false, null, Local}`).
 *  - pack_id != key               -> both `{true, packId, Pack}`.
 *  - scope only                   -> both `{true, scope, Local}`.
 *  - install_path only            -> both `{false, null, Local}` (a path is a
 *    location, not provenance, and the cloud column is org-wide).
 *  - nothing at all               -> both `{false, null, Local}` / `Server` for mcp.
 *
 * The ONE row with no cloud twin is the legacy bare-`source` fixture: `source`
 * is not part of the sync payload at all, so a cloud row for it would carry no
 * `sourceUrl` and answer `{false, null, Local}`. That is not a parity break in
 * practice — no writer produces such a row — and it is stated here rather than
 * papered over, so nobody reads that case as a cross-surface guarantee.
 */
test("listAgentComponentsLocal emits an honest Source projection beside the unchanged legacy pair (ISS-5009)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // No provenance columns at all — the legacy chain falls all the way to
    // `external_id`, which is the echo this ticket exists to stop rendering.
    await insertComponent(prisma, {
      id: "c-echo",
      kind: "skill",
      externalId: "echo-skill",
      key: "echo-skill",
    });
    // Real pack provenance, distinct from the component's own identity.
    await insertComponent(prisma, {
      id: "c-pack",
      kind: "skill",
      externalId: "ext-packed",
      key: "packed-skill",
      packId: "closedloop-plugins",
    });
    // The plugin case: `component-scanner` writes pack_id == component_key ==
    // name, so the pack-dot branch would print the plugin's own name as its
    // provenance.
    await insertComponent(prisma, {
      id: "c-plugin-echo",
      kind: "plugin",
      externalId: "ext-plugin-echo",
      key: "code",
      packId: "code",
    });
    // Same case with CASE SKEW: pack_id is stored raw while the identity key is
    // normalized, so an un-normalized comparison would call this real provenance
    // on one surface and an echo on the other.
    await insertComponent(prisma, {
      id: "c-plugin-mixed",
      kind: "plugin",
      externalId: "ext-plugin-mixed",
      key: "closedloop",
      name: "ClosedLoop",
      packId: "ClosedLoop",
    });
    // Settings scope IS provenance — "this is a user-level component" — and it
    // is Local, not the list's Repo default.
    await insertComponent(prisma, {
      id: "c-scope",
      kind: "skill",
      externalId: "ext-scoped",
      key: "scoped-skill",
      scope: "user",
    });
    // An install path is a LOCATION, not a provenance. Deliberately excluded
    // from the honest chain (the cloud catalog is org-wide, so surfacing one
    // would print another member's local paths), even though the legacy chain
    // still ends there.
    await insertComponent(prisma, {
      id: "c-path",
      kind: "skill",
      externalId: "ext-path-only",
      key: "path-only-skill",
      installPath: ".claude/skills/path-only.md",
    });
    // A scanner-captured git remote: real provenance, and genuinely Repo. Seeded
    // on `source_url` because that is the column the desktop writers populate —
    // `component-scanner.ts:202`/`:466`, `mcp-discovery.ts:354` and
    // `definition-content-collector.ts:770` all write `source_url`, and NOTHING
    // writes the bare `source` column.
    await insertComponent(prisma, {
      id: "c-repo",
      kind: "skill",
      externalId: "ext-repo",
      key: "repo-skill",
      sourceUrl: REPO_URL,
    });
    // THE REGRESSION CASE. An installed plugin as the scanner really writes it:
    // pack_id == component_key == name (so the pack branch correctly rejects the
    // echo) AND a real `source_url`. Reading only the bare `source` column made
    // the repo branch dead here, so the chain fell through to `{false, null,
    // Local}` — while the cloud, whose `sourceUrl` is fed from this very column
    // (`mapAgentComponentToSynced` maps `row.source_url` -> `sourceUrl`),
    // answered `{true, sourceUrl, Repo}` for the SAME component. That is the
    // web/desktop divergence this projection exists to prevent.
    await insertComponent(prisma, {
      id: "c-plugin-repo",
      kind: "plugin",
      externalId: "ext-plugin-repo",
      key: "code-review",
      name: "code-review",
      packId: "code-review",
      sourceUrl: PLUGIN_REPO_URL,
    });
    // The legacy shape: only the bare `source` column set. No desktop writer
    // produces this today, which is exactly why it needs pinning — it is the
    // trailing fallback that keeps such a row honoured, and without coverage a
    // future cleanup would delete it silently.
    await insertComponent(prisma, {
      id: "c-legacy-source",
      kind: "skill",
      externalId: "ext-legacy-source",
      key: "legacy-source-skill",
      source: LEGACY_SOURCE_URL,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    assert.equal(result.total, 9);
    const byId = new Map(result.items.map((item) => [item.id, item]));

    const echo = byId.get("skill::echo-skill");
    assert.ok(echo);
    // Legacy pair unchanged — this IS the flag-OFF render.
    assert.equal(echo.source, "echo-skill");
    assert.equal(echo.sourceType, "local");
    assert.deepEqual(echo.honestSource, {
      hasProvenance: false,
      source: null,
      sourceType: "local",
    });

    const packed = byId.get("skill::packed-skill");
    assert.ok(packed);
    assert.deepEqual(packed.honestSource, {
      hasProvenance: true,
      source: "closedloop-plugins",
      sourceType: "pack",
    });

    const pluginEcho = byId.get("plugin::code");
    assert.ok(pluginEcho);
    // The legacy value still shows the pack dot beside the plugin's own name.
    assert.equal(pluginEcho.source, "code");
    assert.deepEqual(pluginEcho.honestSource, {
      hasProvenance: false,
      source: null,
      sourceType: "local",
    });

    const pluginMixed = byId.get("plugin::closedloop");
    assert.ok(pluginMixed);
    assert.deepEqual(pluginMixed.honestSource, {
      hasProvenance: false,
      source: null,
      sourceType: "local",
    });

    const scoped = byId.get("skill::scoped-skill");
    assert.ok(scoped);
    assert.deepEqual(scoped.honestSource, {
      hasProvenance: true,
      source: "user",
      sourceType: "local",
    });

    const pathOnly = byId.get("skill::path-only-skill");
    assert.ok(pathOnly);
    // The legacy column prints the path; the honest projection refuses to.
    assert.equal(pathOnly.source, ".claude/skills/path-only.md");
    assert.deepEqual(pathOnly.honestSource, {
      hasProvenance: false,
      source: null,
      sourceType: "local",
    });

    const repo = byId.get("skill::repo-skill");
    assert.ok(repo);
    // Legacy: `source_url` is NOT in the legacy chain, so `displaySource` falls
    // all the way to `external_id` and the type stays the Local default. Honest:
    // the real remote, typed Repo. Both halves pinned, because this row is the
    // one where the two answers diverge most.
    assert.equal(repo.source, "ext-repo");
    assert.equal(repo.sourceType, "local");
    assert.deepEqual(repo.honestSource, {
      hasProvenance: true,
      source: REPO_URL,
      sourceType: "repo",
    });

    // THE REGRESSION ASSERTION. Pre-fix this read `{false, null, "local"}`.
    const pluginRepo = byId.get("plugin::code-review");
    assert.ok(pluginRepo);
    // Legacy pair unchanged: the pack dot beside the plugin's own name.
    assert.equal(pluginRepo.source, "code-review");
    assert.equal(pluginRepo.sourceType, "pack");
    assert.deepEqual(pluginRepo.honestSource, {
      hasProvenance: true,
      source: PLUGIN_REPO_URL,
      sourceType: "repo",
    });

    const legacySource = byId.get("skill::legacy-source-skill");
    assert.ok(legacySource);
    // Legacy chain DOES read the bare `source` column, so both answers agree on
    // the value here and differ only in type.
    assert.equal(legacySource.source, LEGACY_SOURCE_URL);
    assert.equal(legacySource.sourceType, "local");
    assert.deepEqual(legacySource.honestSource, {
      hasProvenance: true,
      source: LEGACY_SOURCE_URL,
      sourceType: "repo",
    });
  } finally {
    await close();
  }
});

test("listAgentComponentsLocal reports no provenance for an unresolved-source usage identity (ISS-5009)", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // Usage with NO inventory row at all: the synthetic row's legacy `source` is
    // literally the usage key, so it knows even less than a row that fell
    // through the chain.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "skill",
      key: "local-only-skill",
      invocations: 3,
    });
    // An MCP tool invocation with no inventoried server still carries honest
    // server provenance-kind — matching the legacy `sourceType` for the same row.
    await insertUsage(prisma, {
      sessionId: "s1",
      kind: "mcp",
      key: "_add_comment_to_issue",
      invocations: 2,
    });

    const result = await listAgentComponentsLocal(prisma, {});
    const byId = new Map(result.items.map((item) => [item.id, item]));

    const orphanSkill = byId.get("skill::local-only-skill");
    assert.ok(orphanSkill);
    assert.equal(orphanSkill.source, "local-only-skill");
    assert.deepEqual(orphanSkill.honestSource, {
      hasProvenance: false,
      source: null,
      sourceType: "local",
    });

    const orphanMcp = byId.get("mcp::_add_comment_to_issue");
    assert.ok(orphanMcp);
    assert.equal(orphanMcp.source, "_add_comment_to_issue");
    assert.deepEqual(orphanMcp.honestSource, {
      hasProvenance: false,
      source: null,
      sourceType: "server",
    });
  } finally {
    await close();
  }
});

test("honestSourceOf never emits project_path itself as the source value (ISS-5009)", () => {
  // `scope` and `project_path` are independently nullable — the cloud sync
  // boundary nulls them separately — so a project-path row with no scope is
  // reachable. It is still known to be project-scoped, but the emitted value
  // must be the scope: an absolute filesystem path syncs to the ORG-WIDE cloud
  // catalog, where it would print one member's local directory layout to the
  // whole org. Same exclusion the `install_path` case already pins, and the
  // cloud twin asserts this in `identity.test.ts`.
  const projectPath = "/home/someone/Workspace/private-client-repo";
  const row = {
    component_kind: "skill",
    external_id: "scoped-skill",
    component_key: "scoped-skill",
    source: null,
    source_url: null,
    install_path: null,
    pack_id: null,
    scope: null,
    project_path: projectPath,
  };

  assert.deepEqual(honestSourceOf(row, AgentComponentKind.Skill), {
    hasProvenance: true,
    source: "project",
    sourceType: "repo",
  });

  // An explicit non-project scope wins over project_path as Local provenance.
  assert.deepEqual(
    honestSourceOf({ ...row, scope: "user" }, AgentComponentKind.Skill),
    {
      hasProvenance: true,
      source: "user",
      sourceType: "local",
    }
  );
});

test("honestSourceOf strips userinfo from source_url (ISS-5009)", () => {
  const row = {
    component_kind: "skill",
    external_id: "ext-cred",
    component_key: "cred-skill",
    source: null,
    source_url: "https://user:token123@github.com/org/repo.git",
    install_path: null,
    pack_id: null,
    scope: null,
    project_path: null,
  };

  assert.deepEqual(honestSourceOf(row, AgentComponentKind.Skill), {
    hasProvenance: true,
    source: "https://github.com/org/repo.git",
    sourceType: "repo",
  });

  const noCredRow = { ...row, source_url: "https://github.com/org/repo.git" };
  assert.deepEqual(honestSourceOf(noCredRow, AgentComponentKind.Skill), {
    hasProvenance: true,
    source: "https://github.com/org/repo.git",
    sourceType: "repo",
  });
});
