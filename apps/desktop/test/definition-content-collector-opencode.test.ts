/**
 * @file definition-content-collector-opencode.test.ts
 * @description OpenCode-specific collector behavior for `collectDefinitionContent`
 * (ISS-4386): cross-harness dedup (a same-name identity under both a `.claude`
 * home and an OpenCode home folds to one `Harness.Both` row) and the contained,
 * no-follow read that rejects a project `.opencode/agents` directory symlink
 * escaping the scan root. Split out of `definition-content-collector.test.ts` to
 * keep that file under the 1000-line ceiling.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Harness } from "@repo/api/src/types/agent-component";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { collectDefinitionContent } from "../src/main/packs/definition-content-collector.js";
import { openTestPrisma } from "./prisma-test-utils.js";

type ComponentRow = {
  component_kind: string;
  external_id: string;
  content: string | null;
};

type HarnessRow = {
  external_id: string;
  harness: string | null;
};

type VersionRow = {
  content_hash: string;
  content: string;
};

const CLAUDE_REVIEWER_BODY_RE = /Claude reviewer body/;
const OPENCODE_REVIEWER_BODY_RE = /OpenCode reviewer body/;

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

test("collectDefinitionContent rejects a project .opencode/agents that is a directory symlink escaping the root (T13)", async () => {
  // A repo can check in `.opencode/agents` as a symlink pointing OUTSIDE the
  // project. The inventory scan must NOT follow it and ingest arbitrary Markdown
  // into `agent_components.content` (which is desktop-synced). The contained,
  // no-follow read rejects any file whose real path escapes the scan root.
  const home = mkdtempSync(path.join(os.tmpdir(), "defopencode-escape-"));
  const outside = path.join(home, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(
    path.join(outside, "secret.md"),
    "---\nname: secret\n---\nExfiltrated.\n"
  );
  // Project root whose `.opencode/agents` is a symlink to the outside dir.
  const projectRoot = path.join(home, "project", ".opencode");
  mkdirSync(projectRoot, { recursive: true });
  symlinkSync(outside, path.join(projectRoot, "agents"), "dir");

  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await collectDefinitionContent(prisma, {
      openCodeRoots: [
        {
          dir: projectRoot,
          harness: Harness.Opencode,
          projectPath: projectRoot,
        },
      ],
      homeDir: home,
    });
    // Nothing escapes: the linked-out file is rejected, not upserted.
    assert.equal(summary.upserted, 0);
    const rows = await allComponents(prisma);
    assert.equal(rows.length, 0);
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("collectDefinitionContent folds a Claude+OpenCode same-name DIFFERENT-content subagent into one Both row but retains BOTH content-hash variants (T1/T6, ISS-4564)", async () => {
  // The SAME subagent identity present under both a `.claude` home and an
  // OpenCode home must fold to a SINGLE `agent_components` row attributed `both`
  // — not two upserts where OpenCode silently clobbers the Claude row. Claude is
  // scanned first, so precedence makes its content the display row; OpenCode only
  // upgrades the harness attribution. But the OpenCode variant's DIFFERENT bytes
  // must NOT be discarded (ISS-4564): both distinct content hashes must reach
  // `agent_component_versions`. Reverting the variant-retention fix would drop
  // the OpenCode hash and fail the two-version assertion below.
  const home = mkdtempSync(path.join(os.tmpdir(), "deffold-both-"));
  const claudeHome = path.join(home, ".claude");
  mkdirSync(path.join(claudeHome, "agents"), { recursive: true });
  const claudeContent = "---\nname: reviewer\n---\nClaude reviewer body.\n";
  writeFileSync(path.join(claudeHome, "agents", "reviewer.md"), claudeContent);
  const openCodeHome = path.join(home, ".config", "opencode");
  mkdirSync(path.join(openCodeHome, "agents"), { recursive: true });
  const openCodeContent = "---\nname: reviewer\n---\nOpenCode reviewer body.\n";
  writeFileSync(
    path.join(openCodeHome, "agents", "reviewer.md"),
    openCodeContent
  );

  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await collectDefinitionContent(prisma, {
      claudeRoots: [{ dir: claudeHome, harness: Harness.Claude }],
      openCodeRoots: [{ dir: openCodeHome, harness: Harness.Opencode }],
      homeDir: home,
    });
    // ONE display row, not two (precedence chose the primary).
    assert.equal(summary.upserted, 1);
    const rows = await allComponents(prisma);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].external_id, "reviewer");
    // Claude scanned first → its content is the primary/active display row.
    assert.match(rows[0].content ?? "", CLAUDE_REVIEWER_BODY_RE);

    const harnessRows = await prisma.write((client) =>
      client.$queryRawUnsafe<HarnessRow[]>(
        "SELECT external_id, harness FROM agent_components WHERE external_id = 'reviewer'"
      )
    );
    // Folded to `both` (used across harnesses).
    assert.equal(harnessRows[0].harness, Harness.Both);

    // BOTH distinct content hashes reach the versions table — the OpenCode
    // variant's bytes are NOT dropped by precedence (ISS-4564).
    const versions = await subagentVersions(prisma, "reviewer");
    assert.equal(versions.length, 2);
    const claudeHash = createHash("sha256").update(claudeContent).digest("hex");
    const openCodeHash = createHash("sha256")
      .update(openCodeContent)
      .digest("hex");
    const byHash = new Map(versions.map((v) => [v.content_hash, v]));
    assert.ok(byHash.get(claudeHash));
    assert.ok(byHash.get(openCodeHash));
    assert.match(
      byHash.get(claudeHash)?.content ?? "",
      CLAUDE_REVIEWER_BODY_RE
    );
    assert.match(
      byHash.get(openCodeHash)?.content ?? "",
      OPENCODE_REVIEWER_BODY_RE
    );
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("collectDefinitionContent folds a Claude+OpenCode same-name IDENTICAL-content subagent into ONE version row (no double-count, ISS-4564)", async () => {
  // When the SAME subagent identity has IDENTICAL bytes under both a `.claude`
  // and an OpenCode home, the shared content hash must yield exactly ONE version
  // row — variant retention dedups on `sha256(content)`, so identical content in
  // two roots is never double-counted (it stays a single revision).
  const home = mkdtempSync(path.join(os.tmpdir(), "deffold-identical-"));
  const claudeHome = path.join(home, ".claude");
  mkdirSync(path.join(claudeHome, "agents"), { recursive: true });
  const sharedContent = "---\nname: reviewer\n---\nShared reviewer body.\n";
  writeFileSync(path.join(claudeHome, "agents", "reviewer.md"), sharedContent);
  const openCodeHome = path.join(home, ".config", "opencode");
  mkdirSync(path.join(openCodeHome, "agents"), { recursive: true });
  writeFileSync(
    path.join(openCodeHome, "agents", "reviewer.md"),
    sharedContent
  );

  const { prisma, close } = await openTestPrisma();
  try {
    const summary = await collectDefinitionContent(prisma, {
      claudeRoots: [{ dir: claudeHome, harness: Harness.Claude }],
      openCodeRoots: [{ dir: openCodeHome, harness: Harness.Opencode }],
      homeDir: home,
    });
    assert.equal(summary.upserted, 1);
    const rows = await allComponents(prisma);
    assert.equal(rows.length, 1);

    // Identical content in both roots → exactly one version row.
    const versions = await subagentVersions(prisma, "reviewer");
    assert.equal(versions.length, 1);
    const sharedHash = createHash("sha256").update(sharedContent).digest("hex");
    assert.equal(versions[0].content_hash, sharedHash);
  } finally {
    await close();
    rmSync(home, { recursive: true, force: true });
  }
});
