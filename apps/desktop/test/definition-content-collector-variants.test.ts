/**
 * @file definition-content-collector-variants.test.ts
 * @description Per-content-hash variant retention for same-name definitions
 * (ISS-4564, shafty023 follow-up on PR #4042). Covers the Claude global-home vs
 * project `.claude` case: a same-name sub-agent with DIFFERENT content in each
 * root must retain BOTH content hashes in `agent_component_versions` (the
 * later-scanned variant's bytes are not dropped by precedence), while identical
 * content in both roots stays a single version row (no double-count). The
 * OpenCode global-vs-project variant coverage lives in
 * `definition-content-collector-opencode.test.ts`. Split out of
 * `definition-content-collector.test.ts` to keep that file under the 1000-line
 * ceiling.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Harness } from "@repo/api/src/types/agent-component";
import { getAgentComponentDetailLocal } from "../src/main/dashboard/shared-agent-components-api.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { collectDefinitionContent } from "../src/main/packs/definition-content-collector.js";
import { openTestPrisma } from "./prisma-test-utils.js";

type ComponentRow = {
  component_kind: string;
  external_id: string;
  content: string | null;
};

type VersionRow = {
  content_hash: string;
  content: string;
};

const GLOBAL_REVIEWER_BODY_RE = /Global reviewer body/;
const PROJECT_REVIEWER_BODY_RE = /Project reviewer body/;

function allComponents(prisma: DesktopPrisma): Promise<ComponentRow[]> {
  return prisma.write((client) =>
    client.$queryRawUnsafe<ComponentRow[]>(
      `SELECT component_kind, external_id, content
       FROM agent_components ORDER BY component_kind, external_id`
    )
  );
}

function subagentVersions(
  prisma: DesktopPrisma,
  key: string
): Promise<VersionRow[]> {
  return prisma.write((client) =>
    client.$queryRawUnsafe<VersionRow[]>(
      `SELECT content_hash, content FROM agent_component_versions
       WHERE component_kind = 'subagent' AND component_key = $1
       ORDER BY content`,
      key
    )
  );
}

test("collectDefinitionContent retains BOTH content-hash variants for a same-name Claude subagent in global home vs project (ISS-4564)", async () => {
  // Root cause (shafty023): the fold keyed on `externalId` before content
  // hashing, and `claudeRoots` orders the global home before project `.claude`
  // roots — so a project sub-agent with the SAME name but DIFFERENT content as
  // the global-home one had its bytes DISCARDED at fold time and never reached
  // `agent_component_versions`. Now every distinct content hash is retained:
  // precedence still makes the first-scanned (global-home) variant the display
  // row, but the project variant's bytes are preserved as a version.
  const home = mkdtempSync(path.join(os.tmpdir(), "defvariant-claude-home-"));
  const proj = mkdtempSync(path.join(os.tmpdir(), "defvariant-claude-proj-"));
  const globalClaude = path.join(home, ".claude");
  mkdirSync(path.join(globalClaude, "agents"), { recursive: true });
  const globalContent = "---\nname: reviewer\n---\nGlobal reviewer body.\n";
  writeFileSync(
    path.join(globalClaude, "agents", "reviewer.md"),
    globalContent
  );
  const projClaude = path.join(proj, ".claude");
  mkdirSync(path.join(projClaude, "agents"), { recursive: true });
  const projContent = "---\nname: reviewer\n---\nProject reviewer body.\n";
  writeFileSync(path.join(projClaude, "agents", "reviewer.md"), projContent);

  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await collectDefinitionContent(prisma, {
      // Global home FIRST (production `claudeRoots` order) — precedence winner.
      claudeRoots: [
        { dir: globalClaude, harness: Harness.Claude },
        { dir: projClaude, projectPath: proj },
      ],
      homeDir: home,
    });
    // ONE display row (one identity); precedence chose the global variant.
    assert.equal(summary.upserted, 1);
    const rows = await allComponents(prisma);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].external_id, "reviewer");
    // Global home scanned first → its content is the primary/active row.
    assert.match(rows[0].content ?? "", GLOBAL_REVIEWER_BODY_RE);

    // BOTH distinct content hashes reach the versions table — the later-scanned
    // project variant's bytes are NOT dropped (reverting the fix fails here).
    const versions = await subagentVersions(prisma, "reviewer");
    assert.equal(versions.length, 2);
    const globalHash = createHash("sha256").update(globalContent).digest("hex");
    const projHash = createHash("sha256").update(projContent).digest("hex");
    const byHash = new Map(versions.map((v) => [v.content_hash, v]));
    assert.match(
      byHash.get(globalHash)?.content ?? "",
      GLOBAL_REVIEWER_BODY_RE
    );
    assert.match(byHash.get(projHash)?.content ?? "", PROJECT_REVIEWER_BODY_RE);
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("collectDefinitionContent keeps ONE version row for a same-name Claude subagent with IDENTICAL content in global home and project (no double-count, ISS-4564)", async () => {
  // Identical bytes under both the global home and a project `.claude` must
  // dedup to a SINGLE version row — variant retention keys on `sha256(content)`,
  // so genuinely-identical content is never double-counted.
  const home = mkdtempSync(
    path.join(os.tmpdir(), "defvariant-identical-home-")
  );
  const proj = mkdtempSync(
    path.join(os.tmpdir(), "defvariant-identical-proj-")
  );
  const shared = "---\nname: reviewer\n---\nShared reviewer body.\n";
  const globalClaude = path.join(home, ".claude");
  mkdirSync(path.join(globalClaude, "agents"), { recursive: true });
  writeFileSync(path.join(globalClaude, "agents", "reviewer.md"), shared);
  const projClaude = path.join(proj, ".claude");
  mkdirSync(path.join(projClaude, "agents"), { recursive: true });
  writeFileSync(path.join(projClaude, "agents", "reviewer.md"), shared);

  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await collectDefinitionContent(prisma, {
      claudeRoots: [
        { dir: globalClaude, harness: Harness.Claude },
        { dir: projClaude, projectPath: proj },
      ],
      homeDir: home,
    });
    assert.equal(summary.upserted, 1);

    const versions = await subagentVersions(prisma, "reviewer");
    assert.equal(versions.length, 1);
    assert.equal(
      versions[0].content_hash,
      createHash("sha256").update(shared).digest("hex")
    );
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("getAgentComponentDetailLocal surfaces BOTH retained variants in detail.versions, primary marked current (ISS-4564, shafty023)", async () => {
  // Querying agent_component_versions directly proves the WRITE, but the Desktop
  // UI consumes the separately normalized/projected detail path
  // (getAgentComponentDetailLocal → readComponentVersions → buildComponentVersions),
  // which could still drop or misclassify a retained variant while the raw-table
  // tests stay green. Drive the same two-variant fixture through that path and
  // assert detail.versions carries both hashes with the precedence-winning
  // (global-home) variant flagged isCurrent.
  const home = mkdtempSync(path.join(os.tmpdir(), "defvariant-detail-home-"));
  const proj = mkdtempSync(path.join(os.tmpdir(), "defvariant-detail-proj-"));
  const globalClaude = path.join(home, ".claude");
  mkdirSync(path.join(globalClaude, "agents"), { recursive: true });
  const globalContent = "---\nname: reviewer\n---\nGlobal reviewer body.\n";
  writeFileSync(
    path.join(globalClaude, "agents", "reviewer.md"),
    globalContent
  );
  const projClaude = path.join(proj, ".claude");
  mkdirSync(path.join(projClaude, "agents"), { recursive: true });
  const projContent = "---\nname: reviewer\n---\nProject reviewer body.\n";
  writeFileSync(path.join(projClaude, "agents", "reviewer.md"), projContent);

  const { prisma, close } = await openTestPrisma();
  try {
    await collectDefinitionContent(prisma, {
      claudeRoots: [
        { dir: globalClaude, harness: Harness.Claude },
        { dir: projClaude, projectPath: proj },
      ],
      homeDir: home,
    });

    // Name-level slug — the detail read aggregates a name's versions.
    const detail = await getAgentComponentDetailLocal(
      prisma,
      "subagent::reviewer"
    );
    assert.ok(detail, "detail should resolve");

    const globalHash = createHash("sha256").update(globalContent).digest("hex");
    const projHash = createHash("sha256").update(projContent).digest("hex");
    const detailByHash = new Map(detail.versions.map((v) => [v.hash, v]));
    // Both retained variants reach the projected detail path — not just the
    // primary. Reverting the variant retention drops the project hash here.
    assert.ok(
      detailByHash.has(globalHash),
      "detail.versions must include the global (primary) variant"
    );
    assert.ok(
      detailByHash.has(projHash),
      "detail.versions must include the retained project variant"
    );
    assert.match(
      detailByHash.get(globalHash)?.content ?? "",
      GLOBAL_REVIEWER_BODY_RE
    );
    assert.match(
      detailByHash.get(projHash)?.content ?? "",
      PROJECT_REVIEWER_BODY_RE
    );
    // The global-home variant won precedence (drives the agent_components
    // content row), so its hash is the live/current one; the project variant is
    // history, not current.
    assert.equal(detailByHash.get(globalHash)?.isCurrent, true);
    assert.equal(detailByHash.get(projHash)?.isCurrent, false);
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
